// Sorting songs into playlists with Groq (free LLM API).
//
// Every song is judged on its own: the model picks the most specific playlist it fits
// from the list in taxonomy.json (or "none"), so an artist's songs can land in different
// playlists. Nothing is decided by keyword matching.
//
// Guardrails, so Groq never blocks us:
//   * every request is budgeted before it's sent: per minute (tokens and requests) and
//     over a rolling 24 hours, using 80-90% of Groq's free limits to leave headroom.
//   * actual usage from each reply is recorded in a ledger the caller keeps in storage,
//     so the daily budget holds across page reloads and tabs.
//   * a 429 for the minute is waited out (at most 3 in a row); a 429 for the day, or our
//     own daily budget running out, stops with GroqDailyLimitError and a resume time.
//   * replies use Groq's strict structured outputs where the model supports them: Groq
//     forces the reply into an exact JSON shape, with every answer carrying its item's
//     number, so the model can't drift from the format or misnumber answers. Other models
//     (or if Groq turns strict mode down) answer one short numbered line per item.
//     Either way a reply cut off at the length limit still yields every complete answer,
//     and only the missing items are asked again. Items the model didn't answer are never
//     saved; items it says it doesn't know are recorded as unknown, not guessed.

const API = "https://api.groq.com/openai/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;

// Free-tier limits per model (requests/min, tokens/min, requests/day, tokens/day). Groq
// changes these; if its reply headers report different numbers, those are used instead.
export const MODEL_LIMITS = {
  "llama-3.3-70b-versatile": { rpm: 30, tpm: 12000, rpd: 1000, tpd: 100000 },
  "openai/gpt-oss-120b": { rpm: 30, tpm: 8000, rpd: 1000, tpd: 200000 },
  "openai/gpt-oss-20b": { rpm: 30, tpm: 8000, rpd: 1000, tpd: 200000 },
  "llama-3.1-8b-instant": { rpm: 30, tpm: 6000, rpd: 14400, tpd: 500000 },
};
const UNKNOWN_MODEL_LIMITS = { rpm: 30, tpm: 6000, rpd: 1000, tpd: 100000 };
export const PREFERRED_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant", "openai/gpt-oss-20b"];

export class GroqError extends Error {
  /** kind: "auth" | "model" | "too_large" | "bad_output" | "unavailable" | "busy" */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** The free daily allowance (or our share of it) is used up until `resumeAt`. */
export class GroqDailyLimitError extends Error {
  /**
   * source "groq": Groq itself refused for the day, so `resumeAt` is Groq's own time.
   * source "estimate": our own count of today's usage says we're at the safe limit; Groq
   * may still have some left, so it's fine to ask (see clearUsageEstimates).
   */
  constructor(resumeAt, source = "groq", detail = "") {
    super("Groq's free daily allowance is used up for now.");
    this.resumeAt = resumeAt;
    this.source = source;
    this.detail = detail; // Groq's own message, e.g. "...tokens per day (TPD): Limit 200000, Used 199850..."
  }
}

/**
 * Forgets our own record of today's usage but keeps any time Groq itself gave, so the next
 * request asks Groq directly. Safe: if Groq is really out it says so, with the exact time.
 */
export function clearUsageEstimates(ledger) {
  ledger.save((ledger.load() || []).filter((e) => e.blockedUntil));
}

export const estimateTokens = (text) => Math.ceil(text.length / 3.5);

/**
 * Reasoning models (gpt-oss, qwen3, deepseek-r1...) think before answering, and that
 * thinking counts against max_tokens: with room for only the answer, they spend it all
 * thinking and reply with nothing. So they're asked to think briefly, and get extra room.
 */
export const isReasoningModel = (model) => /gpt-oss|qwen3|qwq|deepseek-r1|reason/i.test(model || "");
// Room for a reasoning model's thinking, which counts against max_tokens. Measured on real
// runs: low effort over a batch of 60 songs thinks for up to ~1,500 tokens.
export const REASONING_ROOM = 1536;
const CAREFUL_REASONING_ROOM = 3072; // for reasoning_effort "medium"

/** "Please try again in 1h2m3.5s" -> ms */
function parseTryAgain(message) {
  const m = /try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i.exec(message || "");
  if (!m || !m[0].match(/\d/)) return null;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + (+m[4] || 0);
}

/**
 * `ledger` is { load(): entries, save(entries) } where entries are [{ t, tokens }] for the
 * last 24 hours, plus an optional { blockedUntil } entry. The app backs it with localStorage.
 */
export function createGroq({
  apiKey, model, fetchImpl = fetch, sleepImpl = sleep, now = () => Date.now(),
  ledger, onWait = () => {}, onPace = () => {}, limits,
}) {
  let lim = { ...(limits || MODEL_LIMITS[model] || UNKNOWN_MODEL_LIMITS) };
  // A daily limit Groq itself reported (see the 429 handling) beats our table.
  const learned = (ledger.load() || []).filter((e) => e.limitTpd && e.t > now() - 7 * DAY).pop();
  if (learned) lim.tpd = learned.limitTpd;
  // What happened this session, for diagnosing: requests, tokens, cut-off replies, answers
  // rejected as belonging to another song, batches split in half.
  const stats = { requests: 0, tokens: 0, cutOffs: 0, rejected: 0, splits: 0 };
  const caps = () => ({
    tpm: Math.floor(lim.tpm * 0.8), rpm: Math.floor(lim.rpm * 0.8),
    tpd: Math.floor(lim.tpd * 0.9), rpd: Math.floor(lim.rpd * 0.9),
  });

  function entries() {
    const cutoff = now() - DAY;
    return (ledger.load() || []).filter((e) => e.t > cutoff || e.blockedUntil > now());
  }
  function record(tokens) {
    const list = entries();
    list.push({ t: now(), tokens });
    ledger.save(list);
  }
  function usage() {
    const list = entries().filter((e) => e.t && typeof e.tokens === "number");
    const minute = list.filter((e) => e.t > now() - 60_000);
    return {
      day: list.reduce((n, e) => n + e.tokens, 0), dayRequests: list.length,
      minute: minute.reduce((n, e) => n + e.tokens, 0), minuteRequests: minute.length, list,
    };
  }

  /** When enough of the rolling day frees up to fit `needed` more tokens and 1 more request. */
  function dayResumeAt(needed) {
    const { list } = usage();
    const sorted = [...list].sort((a, b) => a.t - b.t);
    let tokens = sorted.reduce((n, e) => n + e.tokens, 0);
    let requests = sorted.length;
    for (const e of sorted) {
      tokens -= e.tokens;
      requests -= 1;
      if (tokens + needed <= caps().tpd && requests + 1 <= caps().rpd) return e.t + DAY + 1000;
    }
    return now() + DAY;
  }

  async function waitForBudget(estimated) {
    const blocked = entries().find((e) => e.blockedUntil > now());
    if (blocked) throw new GroqDailyLimitError(blocked.blockedUntil, "groq", blocked.message || "");
    const c = caps();
    // Bigger than a whole minute's allowance: can never be sent, so make the caller split it.
    if (estimated > c.tpm) throw new GroqError("too_large", "Batch is larger than the per-minute allowance");
    const u = usage();
    if (u.day + estimated > c.tpd || u.dayRequests + 1 > c.rpd) throw new GroqDailyLimitError(dayResumeAt(estimated), "estimate");
    // Per minute: wait until the oldest requests in the last 60s drop out of the window.
    for (let i = 0; i < 100; i++) {
      const m = usage();
      if (m.minute + estimated <= c.tpm && m.minuteRequests + 1 <= c.rpm) return;
      const oldest = Math.min(...m.list.filter((e) => e.t > now() - 60_000).map((e) => e.t));
      const wait = Math.max(1000, oldest + 60_000 - now() + 250);
      onPace(wait); // a planned pause to stay under the per-minute limit, not a problem
      await sleepImpl(wait);
    }
  }

  function readHeaderLimits(resp) {
    const n = (k) => parseInt(resp.headers.get(k) || "", 10);
    if (n("x-ratelimit-limit-tokens") > 0) lim.tpm = n("x-ratelimit-limit-tokens");
    if (n("x-ratelimit-limit-requests") > 0) lim.rpd = n("x-ratelimit-limit-requests");
  }

  async function call(path, body) {
    let rateLimited = 0;
    let failures = 0;
    for (;;) {
      let resp;
      try {
        resp = await fetchImpl(API + path, {
          method: body ? "POST" : "GET",
          headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        if (++failures <= 3) { await sleepImpl(2000 * failures); continue; }
        throw new GroqError("unavailable", "Couldn't reach Groq. Check your connection and try again.");
      }
      const text = await resp.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      const message = data?.error?.message || "";
      if (resp.ok) { readHeaderLimits(resp); return data; }

      if (resp.status === 401 || resp.status === 403) {
        throw new GroqError("auth", "Groq didn't accept the API key. Check it in Settings.");
      }
      if (resp.status === 404 || /model.*(not found|decommissioned|does not exist)/i.test(message)) {
        throw new GroqError("model", `Groq doesn't offer the model "${body?.model}" to this key any more. Pick another in Settings.`);
      }
      // In JSON mode Groq checks the model's reply itself and refuses invalid JSON (often a
      // reply cut short). That's a bad reply like any other: the batch is retried smaller.
      if (resp.status === 400 && (data?.error?.code === "json_validate_failed" || /validate JSON|failed_generation/i.test(message))) {
        throw new GroqError("bad_output", "The model's reply wasn't valid JSON");
      }
      // Strict structured output turned down for this model: the caller falls back to lines.
      if (resp.status === 400 && body?.response_format && /response_format|json_schema|schema|structured|strict/i.test(message)
        && !/validate JSON|failed_generation/i.test(message)) {
        throw new GroqError("no_schema", message);
      }
      if (resp.status === 413 || /context|too large|maximum.*tokens/i.test(message)) {
        throw new GroqError("too_large", message || "Request too large");
      }
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") || "", 10);
        const wait = parseTryAgain(message) ?? (retryAfter > 0 ? retryAfter * 1000 : 20_000);
        if (/per day|\(TPD\)|\(RPD\)/i.test(message) || wait > 10 * 60_000) {
          const list = entries();
          list.push({ blockedUntil: now() + wait + 5000, message });
          // Groq says what the limit actually is ("tokens per day (TPD): Limit 200000"): remember it.
          const tpd = /tokens per day \(TPD\): Limit (\d+)/i.exec(message)?.[1];
          if (tpd) { list.push({ t: now(), limitTpd: +tpd }); lim.tpd = +tpd; }
          ledger.save(list);
          throw new GroqDailyLimitError(now() + wait + 5000, "groq", message);
        }
        if (++rateLimited > 3) throw new GroqError("busy", "Groq keeps asking us to slow down. Try again in a few minutes.");
        onWait(wait + 1000);
        await sleepImpl(wait + 1000);
        continue;
      }
      if (resp.status >= 500 && ++failures <= 3) { await sleepImpl(2000 * failures); continue; }
      throw new GroqError("unavailable", message || `Groq error ${resp.status}`);
    }
  }

  return {
    get model() { return model; },
    stats,
    /** Ids of the chat models this key can use. Also confirms the key works (free: no tokens used). */
    async listModels() {
      const data = await call("/models");
      return (data?.data || []).map((m) => m.id);
    },
    /**
     * One chat completion, budgeted before sending and recorded after. With `schema`, Groq's
     * strict structured output is requested (constrained decoding: the reply always matches
     * the schema). Returns the raw { text, cutOff }; cutOff means it hit the length limit.
     */
    async chat(system, user, maxTokens, schema = null, { careful = false } = {}) {
      const reasoning = isReasoningModel(model);
      if (reasoning) maxTokens += careful ? CAREFUL_REASONING_ROOM : REASONING_ROOM;
      const estimated = estimateTokens(system + user) + maxTokens;
      await waitForBudget(estimated);
      let data;
      try {
        data = await call("/chat/completions", {
          model, temperature: 0, max_tokens: maxTokens,
          ...(reasoning ? { reasoning_effort: careful ? "medium" : "low", include_reasoning: false } : {}),
          ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "genres", strict: true, schema } } } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        });
      } catch (err) {
        if (err instanceof GroqError && ["too_large", "bad_output", "no_schema"].includes(err.kind)) record(estimated);
        throw err;
      }
      record(data?.usage?.total_tokens ?? estimated);
      stats.requests++;
      stats.tokens += data?.usage?.total_tokens ?? estimated;
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new GroqError("bad_output", "Groq's reply had no text");
      const cutOff = data.choices[0].finish_reason === "length";
      if (cutOff) stats.cutOffs++;
      return { text, cutOff };
    },
    /** For progress messages: rough tokens/minute we allow ourselves, and what's left today. */
    budget() {
      const c = caps();
      return { tpm: c.tpm, tpd: c.tpd, dayLeft: Math.max(0, c.tpd - usage().day) };
    },
  };
}

/** The models in a key's list that can do text chat (not speech, safety or embedding models). */
export const chatModels = (available) => available.filter((m) => !/whisper|tts|guard|embed|vision|orpheus|allam/i.test(m));

/** The first model in our preference list that this key can use (or any chat model). */
export function chooseModel(available) {
  return PREFERRED_MODELS.find((m) => available.includes(m)) || chatModels(available)[0] || null;
}

// --------------------------------------------------------------------------- sorting songs

/** Models Groq runs in strict structured-output mode (constrained decoding). */
export const supportsStrictOutput = (model) => /^openai\/gpt-oss-\d+b$|^qwen\/qwen3/i.test(model || "");
const modeFor = (model) => (supportsStrictOutput(model) ? "json" : "lines");

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Reply room per song. A structured answer {"n": 37, "w": "icarus", "p": "classical", "c": "h"}
// is ~20 tokens as the model spaces it out (short keys keep every answer cheap); a line
// "37: classical" ~6. Room is generous so replies are rarely cut off, and a cut-off reply
// still yields its complete answers.
// Measured on real runs: gpt-oss spaces answers over several lines, ~28 tokens each.
const ROOM = { json: 40, lines: 10 };
const TYPICAL = { json: 28, lines: 6 };
// The playlist list is ~1,100 tokens per request, so bigger batches waste less on repeating
// it; 60 songs keeps a request (with its reply and thinking room) under gpt-oss-120b's
// per-minute cap, so replies aren't cut off and re-asked.
const SONG_BATCH = 60;
// Songs the model was unsure about get a second, more careful look in smaller batches.
const CAREFUL_BATCH = 30;
const MAX_EXAMPLES = 20;

/**
 * The instructions, with the playlist list (subgenres indented under their genre).
 * `examples` are songs the listener placed themselves ([{ title, artist, playlist }]),
 * shown so the model follows their taste. `careful` is for the second look.
 */
export function sortingTask(nodes, { examples = [], careful = false } = {}) {
  const list = nodes.map((n) => `${n.parent ? "  " : ""}${n.id}: ${n.hint}`).join("\n");
  const taste = examples.length
    ? `\nThe listener placed these songs themselves; place similar songs the same way:\n${examples.slice(0, MAX_EXAMPLES)
      .map((e) => `"${clip(e.title, 50)}" by ${clip(e.artist, 30)} -> ${e.playlist}`).join("\n")}`
    : "";
  return `You sort songs into playlists. For each numbered song, pick the most specific playlist it fits, from this list (answer with the id). Indented entries are subgenres of the entry above: pick a subgenre when the song clearly fits it, otherwise the broad genre.
${list}
Judge each song itself, not just its artist: an artist's songs can belong in different playlists. Go by how the song actually sounds, from what you know about the song and the artist. Listener tags and Apple Music genres, when given, are real data about the song: trust them over impressions.
Never judge by an artist's name, a title's language, or its capitals or styling: an all-caps title is not a sign of K-Pop, and a Spanish or Korean surname is not a sign of Latin music or K-Pop.
Answer "none" if you don't recognise the song or its artist and nothing given places it.
Confidence: "h" (high) if you know the song, or the artist's sound well enough to place it; "m" (medium) if you know the artist but not this song; "l" (low) if you don't really know them and are relying on weak clues.${taste}${careful
    ? "\nThese are songs you were unsure about before: think about each one carefully, and keep confidence \"l\" for any you still can't place with real knowledge."
    : ""}`;
}

const FORMAT = {
  json: "Give exactly one result per numbered song: n = its number, w = the first two words of its title (or its only word), p = the playlist id, c = your confidence. Write the JSON compactly on one line.",
  lines: "Reply with exactly one line per song, starting with its number, and nothing else, e.g.\n1: deep-house\n2: none",
};

const songLine = (s) => {
  const extra = [];
  if (s.featured?.length) extra.push(`feat. ${s.featured.map((f) => clip(f, 30)).join(", ")}`);
  if (s.context?.length) extra.push(`listener tags for the artist: ${s.context.join(", ")}`);
  if (s.songTags?.length) extra.push(`listener tags for this song: ${s.songTags.join(", ")}`);
  if (s.storeGenre) extra.push(`Apple Music genre: ${s.storeGenre}`);
  return `"${clip(s.title, 70)}" by ${clip(s.artist, 40)}${extra.length ? ` (${extra.join("; ")})` : ""}`;
};

/** The words of a title, simplified for comparing ("Don't Stop" -> ["don", "t", "stop"]). */
const words = (text) => String(text ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
/** A title simplified to its letters and digits, for comparing ("Don't Stop" -> "dontstop"). */
const letters = (text) => String(text ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/&/g, "and").replace(/[^\p{L}\p{N}]+/gu, "");
/** The first word of a title ("Don't Stop" -> "don"). */
export const firstWord = (text) => words(text)[0] || "";

/**
 * Reading answers into Map(n -> { playlist, confidence }). Only a real playlist id (or its
 * exact name, or "none") is accepted: strict mode can't produce anything else, and in the
 * line format anything else is ignored and asked again. In structured answers the echoed
 * start of the title must match the song with that number; if it doesn't, the answer
 * was meant for a different song and is dropped (the song is asked again). Numbers outside
 * the batch are ignored, and the first answer for a number wins.
 */
export function answerReader(nodes) {
  const lookup = new Map(nodes.flatMap((n) => [[n.id, n.id], [n.name.toLowerCase(), n.id]]));
  const valid = (v) => {
    const k = String(v ?? "").trim().replace(/^["'`*]+|["'`*.]+$/g, "").toLowerCase();
    return k === "none" ? "none" : lookup.get(k) || null;
  };
  // The answer must repeat the start of the title (its first two words): one word alone
  // can't tell apart neighbouring songs that both start with "The" or "Love". Compared on
  // letters and digits only, so "Don't Start" = "Dont Start", "P.Y.T." = "PYT", "&" = "and",
  // and a leading "(I Can't Get No)" may be skipped. Real mismatches still fail.
  const sameWord = (given, title) => {
    const got = letters(given);
    const t = String(title);
    const unbracketed = t.replace(/^\s*[([][^)\]]*[)\]]\s*/, "");
    // "&" may be echoed as "and" or left out altogether.
    const starts = [t, unbracketed, t.replace(/&/g, " "), unbracketed.replace(/&/g, " ")].map(letters);
    if (!starts[0]) return true;
    return starts.some((want) => want && got.length >= Math.min(4, want.length)
      && (want.startsWith(got) || got.startsWith(want)));
  };
  const json = (text, batch) => {
    const out = new Map();
    const add = (n, word, pick, confidence) => {
      const v = valid(pick);
      const k = String(n);
      const song = batch[+n - 1];
      if (!v || !Number.isInteger(+n) || !song || out.has(k)) return;
      if (!sameWord(word, song.title)) { out.rejected = (out.rejected || 0) + 1; return; } // meant for another song
      out.set(k, { playlist: v, confidence: ["high", "medium", "low"].includes(confidence) ? confidence : "medium" });
    };
    const CONFIDENCE = { h: "high", m: "medium", l: "low" };
    try {
      const data = JSON.parse(text);
      for (const r of Array.isArray(data?.results) ? data.results : []) add(r?.n, r?.w, r?.p, CONFIDENCE[r?.c]);
      return out;
    } catch { /* cut off: pick out the complete answers */ }
    const one = /\{\s*"n"\s*:\s*(\d+)\s*,\s*"w"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"p"\s*:\s*"([^"]*)"\s*,\s*"c"\s*:\s*"([^"]*)"\s*\}/g;
    for (const m of text.matchAll(one)) add(+m[1], m[2], m[3], CONFIDENCE[m[4]]);
    return out;
  };
  const lines = (text, batch, cutOff) => {
    let rows = text.split(/\r?\n/);
    if (cutOff) rows = rows.slice(0, -1); // the last line may be half-written
    const out = new Map();
    for (const raw of rows) {
      const m = /^\s*[*-]?\s*\**(\d+)\**\s*[:.)\]–-]\s*(.*)$/.exec(raw);
      const v = m && valid(m[2]);
      if (v && +m[1] >= 1 && +m[1] <= batch.length && !out.has(m[1])) out.set(m[1], { playlist: v, confidence: "medium" });
    }
    return out;
  };
  return { json, lines };
}

const answerSchema = (nodes) => ({
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          w: { type: "string" },
          p: { type: "string", enum: [...nodes.map((n) => n.id), "none"] },
          c: { type: "string", enum: ["h", "m", "l"] },
        },
        required: ["n", "w", "p", "c"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
});

/**
 * Roughly how long sorting these songs takes and how much of the daily allowance it needs:
 * { tokens, minutes, days, todayShare, startsToday }. days > 1 means it continues on later
 * days; startsToday false means not even one request fits in today's allowance. Includes
 * the second look for unsure songs (assumed ~10% of them).
 */
export function estimateSongJob(groq, songs, nodes, batchSize = SONG_BATCH) {
  const mode = modeFor(groq.model);
  const reasoning = isReasoningModel(groq.model);
  const perBatch = estimateTokens(`${sortingTask(nodes)}\n${FORMAT[mode]}`) + 40 + (reasoning ? 900 : 0);
  const perSong = (s) => estimateTokens(songLine(s)) + 3 + TYPICAL[mode];
  const main = songs.reduce((n, s) => n + perSong(s), 0) + Math.ceil(songs.length / batchSize) * perBatch;
  const unsure = Math.ceil(songs.length * 0.1);
  const second = mode === "json"
    ? unsure * (perSong({ title: "a typical song", artist: "an artist" }) + 15) + Math.ceil(unsure / CAREFUL_BATCH) * (perBatch + (reasoning ? 1500 : 0))
    : 0;
  const tokens = main + second;
  const { tpm, tpd, dayLeft } = groq.budget();
  const smallestRequest = perBatch + 5 * (ROOM[mode] + 20) + (reasoning ? REASONING_ROOM : 0);
  if (songs.length && dayLeft < smallestRequest) {
    return { tokens, minutes: 0, days: 1 + Math.ceil(tokens / tpd), todayShare: 0, startsToday: false };
  }
  const today = Math.min(tokens, dayLeft);
  const days = tokens <= dayLeft ? 1 : 1 + Math.ceil((tokens - dayLeft) / tpd);
  // Pacing allows `tpm` tokens a minute; each request also reserves reply room, so add some.
  const minutes = Math.ceil((today / tpm) * 1.4 + 0.5);
  return { tokens, minutes, days, todayShare: tokens ? today / tokens : 1, startsToday: true };
}

/**
 * Sorts songs not yet in `cache` (song uri -> { playlist, confidence }), mutating it, in
 * the order given. `songs` is [{ uri, title, artist, featured, context }] (context: optional
 * listener tags for the artist).
 *
 * Answers with low confidence aren't saved straight away: those songs get a second, more
 * careful look in small batches (with `moreContext(song)`'s extra evidence, e.g. Last.fm
 * tags for the song, if given). Anything still low-confidence after that is saved as
 * "none" (Uncategorized) rather than put in a playlist on weak clues.
 * `examples` are the listener's own placements, shown to the model.
 * Throws GroqDailyLimitError when the allowance runs out, with everything sorted so far
 * already in `cache` (unsure songs not yet re-checked are simply asked again next run).
 */
export async function classifySongs(groq, songs, nodes, cache, {
  batchSize = SONG_BATCH, examples = [], moreContext = null, onProgress = () => {}, onSaved = () => {},
  onLookup = () => {},
} = {}) {
  const todo = songs.filter((s) => !(s.uri in cache));
  const read = answerReader(nodes);
  const spec = (careful) => ({
    task: sortingTask(nodes, { examples, careful }), format: FORMAT, room: ROOM, schema: answerSchema(nodes),
    parseJson: read.json, parseLines: read.lines, careful,
  });
  const unsure = [];
  let done = 0;
  onProgress(0, todo.length);
  const save = (results, careful) => {
    for (const [uri, a] of Object.entries(results)) {
      if (a.confidence === "low" && !careful) { unsure.push(uri); continue; }
      cache[uri] = { ...(a.confidence === "low" ? { playlist: "none", confidence: "low" } : a), model: groq.model };
      done++;
    }
    onSaved(cache);
    onProgress(done, todo.length);
  };

  await runBatches(groq, todo, { spec: spec(false), batchSize, key: (s) => s.uri, line: songLine, onBatch: (r) => save(r, false) });

  if (unsure.length) {
    const bySong = new Map(todo.map((s) => [s.uri, s]));
    const again = [];
    for (const [i, uri] of unsure.entries()) {
      const s = bySong.get(uri);
      if (moreContext) onLookup(i, unsure.length);
      again.push(moreContext ? { ...s, ...(await moreContext(s)) } : s);
    }
    await runBatches(groq, again, { spec: spec(true), batchSize: CAREFUL_BATCH, key: (s) => s.uri, line: songLine, onBatch: (r) => save(r, true) });
  }
  return cache;
}

/**
 * Runs `items` through the model in batches. `onBatch(results)` gets { key: answer } for
 * every item the model actually answered (for songs: a playlist id, or "none").
 *
 * Items the model didn't answer are never saved: they're asked again (up to twice) and
 * otherwise left for the next run, so a reply the app couldn't read can't turn into a
 * permanent "none". A batch is split in half when Groq refuses it or its reply can't be
 * read (retrying it unchanged is pointless: with temperature 0 the model says the same
 * again), which narrows a problem down to the item causing it.
 *
 * Strict structured replies are used where the model supports them. If Groq turns strict
 * mode down, or its replies can't be read, the line format takes over for the rest of the run.
 * Sorting only stops for a format problem if, before any reply has been readable, a batch
 * and two single items all come back unreadable in the line format too, or after 8
 * unreadable replies in a row; the message shows what the model said.
 */
async function runBatches(groq, items, { spec, line, key, batchSize, onBatch }) {
  let mode = modeFor(groq.model);
  let readableSeen = false;
  let streak = 0;

  const formatError = (text) => new GroqError("format", "Sorting stopped to save your Groq allowance: the model's "
    + `replies aren't in a format the app can read. It replied: "${text.trim().replace(/\s+/g, " ").slice(0, 160) || "(nothing)"}". `
    + "Try another model in Settings.");

  /** One request: { answers, text }, or null when Groq refused it (bad or too large). */
  async function ask(batch) {
    const user = batch.map((it, i) => `${i + 1}. ${line(it)}`).join("\n");
    const max = Math.min(4000, 40 + batch.length * spec.room[mode]);
    try {
      const reply = await groq.chat(`${spec.task}\n${spec.format[mode]}`, user, max, mode === "json" ? spec.schema : null,
        { careful: !!spec.careful });
      const answers = mode === "json"
        ? spec.parseJson(reply.text, batch)
        : spec.parseLines(reply.text, batch, reply.cutOff);
      if (groq.stats) groq.stats.rejected += answers.rejected || 0;
      return { answers, text: reply.text };
    } catch (err) {
      if (err instanceof GroqError && err.kind === "no_schema" && mode === "json") {
        mode = "lines"; // this model or key doesn't take strict mode after all
        return ask(batch);
      }
      if (err instanceof GroqError && (err.kind === "bad_output" || err.kind === "too_large")) return null;
      throw err;
    }
  }

  function save(batch, answers) {
    const results = {};
    const missing = [];
    batch.forEach((it, i) => {
      const a = answers.get(String(i + 1));
      if (a) results[key(it)] = a;
      else missing.push(it);
    });
    onBatch(results);
    return missing;
  }

  async function split(batch, retries) {
    if (batch.length < 2) return; // a single item with no usable answer: left for next run
    if (groq.stats) groq.stats.splits++;
    const mid = Math.ceil(batch.length / 2);
    await attempt(batch.slice(0, mid), retries);
    await attempt(batch.slice(mid), retries);
  }

  async function attempt(batch, retries = 2) {
    const reply = await ask(batch);
    if (!reply) return split(batch, retries);

    if (!reply.answers.size) {
      if (++streak >= 8) throw formatError(reply.text);
      if (!readableSeen && mode === "json") { // structured replies we can't read: use lines instead
        mode = "lines";
        return attempt(batch, retries);
      }
      let rest = batch;
      if (!readableSeen) {
        // The format, or something in this batch? Ask about two items on their own.
        for (const probe of [...new Set([batch[batch.length - 1], batch[0]])]) {
          const single = await ask([probe]);
          if (single?.answers.size) {
            readableSeen = true;
            save([probe], single.answers);
            rest = batch.filter((it) => it !== probe);
            break;
          }
        }
        if (!readableSeen) throw formatError(reply.text);
      }
      return split(rest, retries);
    }

    readableSeen = true;
    streak = 0;
    const missing = save(batch, reply.answers);
    if (missing.length && retries > 0) await attempt(missing, retries - 1);
  }

  for (let i = 0; i < items.length; i += batchSize) await attempt(items.slice(i, i + batchSize));
}
