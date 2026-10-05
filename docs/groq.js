// Genre tagging with Groq (free LLM API), instead of one Spotify request per artist.
//
// The model tags each artist with Spotify-style genres ("chicago drill", "bedroom pop");
// those tags then go through the same keyword rules as Spotify's own genres. Artists
// whose songs span different genres are flagged, and their songs are tagged one by one.
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
  constructor(resumeAt, source = "groq") {
    super("Groq's free daily allowance is used up for now.");
    this.resumeAt = resumeAt;
    this.source = source;
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
export const REASONING_ROOM = 1024;

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
    const list = entries().filter((e) => e.t);
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
    if (blocked) throw new GroqDailyLimitError(blocked.blockedUntil, "groq");
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
          list.push({ blockedUntil: now() + wait + 5000 });
          ledger.save(list);
          throw new GroqDailyLimitError(now() + wait + 5000, "groq");
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
    async chat(system, user, maxTokens, schema = null) {
      const reasoning = isReasoningModel(model);
      if (reasoning) maxTokens += REASONING_ROOM;
      const estimated = estimateTokens(system + user) + maxTokens;
      await waitForBudget(estimated);
      let data;
      try {
        data = await call("/chat/completions", {
          model, temperature: 0, max_tokens: maxTokens,
          ...(reasoning ? { reasoning_effort: "low", include_reasoning: false } : {}),
          ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "genres", strict: true, schema } } } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        });
      } catch (err) {
        if (err instanceof GroqError && ["too_large", "bad_output", "no_schema"].includes(err.kind)) record(estimated);
        throw err;
      }
      record(data?.usage?.total_tokens ?? estimated);
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new GroqError("bad_output", "Groq's reply had no text");
      return { text, cutOff: data.choices[0].finish_reason === "length" };
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

// --------------------------------------------------------------------------- tagging

/** Models Groq runs in strict structured-output mode (constrained decoding). */
export const supportsStrictOutput = (model) => /^openai\/gpt-oss-\d+b$|^qwen\/qwen3/i.test(model || "");

const ARTIST_TASK = `You tag music artists with genres the way Spotify does on artist pages.
For each numbered artist (with example songs from the listener's library), give 1-3 Spotify-style genre tags, most representative first, lowercase, e.g. "chicago drill", "bedroom pop", "classic oklahoma country", "k-pop girl group", "reggaeton", "uk garage", "art pop".
If you don't confidently recognise the artist, give no tags. Never guess from the name alone.
Mark the artist as mixed when their songs clearly span different broad genres (e.g. both hip hop and rock, or both country and pop).`;

const SONG_TASK = `You tag individual songs with genres the way Spotify would.
For each numbered song, give 1-2 Spotify-style genre tags describing that specific song (not the artist in general), lowercase, e.g. "pop rap", "alternative rock", "contemporary country", "dance pop".
If you don't confidently know the song, give no tags. Never guess.`;

const FORMAT = {
  artist: {
    json: "Give exactly one result per numbered artist, with its number n.",
    lines: `Reply with exactly one line per artist, starting with its number, in order, and nothing else:
1: chicago drill, drill
2:
3: country pop, pop | mixed`,
  },
  song: {
    json: "Give exactly one result per numbered song, with its number n.",
    lines: `Reply with exactly one line per song, starting with its number, in order, and nothing else:
1: pop rap
2:
3: alternative rock, pop rock`,
  },
};

const resultSchema = (withMixed) => ({
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          tags: { type: "array", items: { type: "string" } },
          ...(withMixed ? { mixed: { type: "boolean" } } : {}),
        },
        required: withMixed ? ["n", "tags", "mixed"] : ["n", "tags"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
});
const SCHEMA = { artist: resultSchema(true), song: resultSchema(false) };

// Reply room per item. A structured answer like {"n":12,"tags":["conscious hip hop",
// "west coast rap"],"mixed":false} is ~24 tokens; a line "12: conscious hip hop, west
// coast rap" ~14. Room is generous so replies are rarely cut off (and a cut-off reply
// still yields its complete answers); estimates use the typical size.
const ROOM = { artist: { json: 36, lines: 24 }, song: { json: 28, lines: 16 } };
const TYPICAL = { artist: { json: 24, lines: 14 }, song: { json: 18, lines: 10 } };
const ARTIST_BATCH = 60;
const SONG_BATCH = 50;

const modeFor = (model) => (supportsStrictOutput(model) ? "json" : "lines");

/**
 * Roughly how long tagging these artists will take and how much of the daily allowance
 * it needs: { tokens, minutes, days, todayShare, startsToday }. days > 1 means it continues
 * on later days; startsToday false means not even one request fits in today's allowance.
 */
export function estimateArtistJob(groq, artists, batchSize = ARTIST_BATCH) {
  const mode = modeFor(groq.model);
  // Reasoning models also think a little per request (asked for low effort: ~a few hundred tokens).
  const perBatch = estimateTokens(`${ARTIST_TASK}\n${FORMAT.artist[mode]}`) + 40 + (isReasoningModel(groq.model) ? 300 : 0);
  const tokens = artists.reduce((n, a) => n + estimateTokens(artistLine(a)) + 3 + TYPICAL.artist[mode], 0)
    + Math.ceil(artists.length / batchSize) * perBatch;
  const { tpm, tpd, dayLeft } = groq.budget();
  const smallestRequest = perBatch + 5 * (ROOM.artist[mode] + 12) + (isReasoningModel(groq.model) ? REASONING_ROOM : 0);
  if (artists.length && dayLeft < smallestRequest) return { tokens, minutes: 0, days: 1 + Math.ceil(tokens / tpd), todayShare: 0, startsToday: false };
  const today = Math.min(tokens, dayLeft);
  const days = tokens <= dayLeft ? 1 : 1 + Math.ceil((tokens - dayLeft) / tpd);
  // Pacing allows `tpm` tokens a minute; replies take time too, so add a little.
  const minutes = Math.ceil((today / tpm) * 1.15 + 0.5);
  return { tokens, minutes, days, todayShare: tokens ? today / tokens : 1, startsToday: true };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const NOT_A_TAG = /^(unknown|none|n\/a|na|-+|\?+|empty|no tags?)$/i;

const cleanTags = (list) => list
  .map((t) => String(t).replace(/["'`*[\]{}()]/g, "").trim().toLowerCase())
  .filter((t) => t && !NOT_A_TAG.test(t))
  .map((t) => t.slice(0, 40))
  .slice(0, 3);

/**
 * Reads a structured reply ({"results":[{"n":1,"tags":[...],"mixed":false}]}) into
 * Map("n" -> { tags, mixed }). If the reply was cut off, every complete answer in it is
 * still picked out. Numbers outside 1..count are ignored; the first answer for a number wins.
 */
export function parseStructuredReply(text, count) {
  const out = new Map();
  const add = (n, tags, mixed) => {
    const k = String(n);
    if (Number.isInteger(+n) && +n >= 1 && +n <= count && !out.has(k) && Array.isArray(tags)) {
      out.set(k, { tags: cleanTags(tags), mixed: mixed === true });
    }
  };
  try {
    const data = JSON.parse(text);
    for (const r of Array.isArray(data?.results) ? data.results : []) add(r?.n, r?.tags, r?.mixed);
    return out;
  } catch { /* cut off or otherwise incomplete: pick out the complete answers below */ }
  const one = /\{\s*"n"\s*:\s*(\d+)\s*,\s*"tags"\s*:\s*(\[[^\]]*\])\s*(?:,\s*"mixed"\s*:\s*(true|false)\s*)?\}/g;
  for (const m of text.matchAll(one)) {
    try { add(+m[1], JSON.parse(m[2]), m[3] === "true"); } catch { /* a half-written answer */ }
  }
  return out;
}

/**
 * Whether an unnumbered line reads like genre tags ("pop rock, hip hop | mixed") rather
 * than chatter ("I'm sorry, I can't help with that."). Only tag-like lines are matched up
 * to items by position.
 */
function looksLikeTags(line) {
  if (/[?!]|\b(sorry|cannot|can't|unable|here (are|is)|sure|apolog|unfortunately|i am|i'm|as an)\b/i.test(line)) return false;
  if (/\.\s*$/.test(line.trim())) return false; // ends like a sentence
  const [answer] = line.split("|");
  return answer.split(/[,;]/).every((t) => t.trim().split(/\s+/).length <= 4 && t.trim().length <= 40);
}

function lineAnswer(rest) {
  let [answer, flags = ""] = rest.split("|");
  if (answer.includes(":")) answer = answer.slice(answer.lastIndexOf(":") + 1); // "Name: tags"
  return { tags: cleanTags(answer.split(/[,;]/)), mixed: /mixed/i.test(flags) };
}

/**
 * Reads "N: tag, tag | mixed" lines into Map("N" -> { tags, mixed }). Tolerant of small
 * drift ("1." or "1)", quotes, brackets, the name echoed back as "1: Name: tags", chatter
 * around the answers). If the model left the numbers off, its lines are only used when
 * there's no doubt which answer is whose: exactly one line per item in a batch of at most
 * 5 (any larger and a skipped line could shift every answer onto the wrong artist).
 * A cut-off reply's half-written last line is ignored. Lines it can't read are simply
 * missing, so they get asked again.
 */
export function parseReplyLines(text, count = Infinity, cutOff = false) {
  let lines = text.split(/\r?\n/);
  if (cutOff) lines = lines.slice(0, -1);
  const out = new Map();
  for (const raw of lines) {
    const m = /^\s*[*-]?\s*\**(\d+)\**\s*[:.)\]–-]\s*(.*)$/.exec(raw);
    if (m && +m[1] >= 1 && +m[1] <= count && !out.has(m[1])) out.set(m[1], lineAnswer(m[2]));
  }
  if (out.size || count > 5) return out;
  const plain = lines.map((l) => l.replace(/^\s*[*-]\s*/, "").trim()).filter((l) => l && !/^```/.test(l));
  if (plain.length === count && plain.every(looksLikeTags)) plain.forEach((l, i) => out.set(String(i + 1), lineAnswer(l)));
  return out;
}

/**
 * Runs `items` through the model in batches. `onBatch(results)` gets { key: { tags, mixed } }
 * for every item the model actually answered; an empty answer means "unknown".
 *
 * Items the model didn't answer are never saved: they're asked again (up to twice) and
 * otherwise left for the next run, so a reply the app couldn't read can't turn into a
 * permanent "unknown". A batch is split in half when Groq refuses it or its reply can't be
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
      const reply = await groq.chat(`${spec.task}\n${spec.format[mode]}`, user, max, mode === "json" ? spec.schema : null);
      const answers = mode === "json"
        ? spec.parseJson(reply.text, batch.length)
        : spec.parseLines(reply.text, batch.length, reply.cutOff);
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

const tagSpec = (kind) => ({
  task: kind === "artist" ? ARTIST_TASK : SONG_TASK,
  format: FORMAT[kind], room: ROOM[kind], schema: SCHEMA[kind],
  parseJson: parseStructuredReply, parseLines: parseReplyLines,
});

const artistLine = (a) => `${clip(a.name, 60)}${a.titles.length ? ` (songs: ${a.titles.map((t) => clip(t, 35)).join("; ")})` : ""}`;

/**
 * Tags artists not yet in `cache` (artist id -> { tags, mixed }), mutating it.
 * `artists` is [{ id, name, titles, songCount }]; artists with the most liked songs go
 * first, so if the daily allowance runs out, the most music is already sorted.
 */
export async function tagArtists(groq, artists, cache, { batchSize = ARTIST_BATCH, onProgress = () => {}, onSaved = () => {} } = {}) {
  const todo = artists.filter((a) => !(a.id in cache)).sort((a, b) => b.songCount - a.songCount);
  let done = 0;
  onProgress(0, todo.length);
  await runBatches(groq, todo, {
    spec: tagSpec("artist"), batchSize, key: (a) => a.id, line: artistLine,
    onBatch: (results) => {
      Object.assign(cache, results);
      done += Object.keys(results).length;
      onSaved(cache);
      onProgress(done, todo.length);
    },
  });
  return cache;
}

/** Tags songs not yet in `cache` (song uri -> { tags }), mutating it. `songs` is [{ uri, title, artist }]. */
export async function tagSongs(groq, songs, cache, { batchSize = SONG_BATCH, onProgress = () => {}, onSaved = () => {} } = {}) {
  const todo = songs.filter((s) => !(s.uri in cache));
  let done = 0;
  onProgress(0, todo.length);
  await runBatches(groq, todo, {
    spec: tagSpec("song"), batchSize, key: (s) => s.uri,
    line: (s) => `"${clip(s.title, 60)}" by ${clip(s.artist, 40)}`,
    onBatch: (results) => {
      for (const [k, v] of Object.entries(results)) cache[k] = { tags: v.tags };
      done += Object.keys(results).length;
      onSaved(cache);
      onProgress(done, todo.length);
    },
  });
  return cache;
}

// --------------------------------------------------------------------------- playlist picks

/**
 * Second pass for artists whose tags didn't match any playlist (or who had none): the
 * model picks the playlist that fits best from the actual list, using everything known
 * about the artist. In strict mode the answer can only be one of the playlist ids or
 * "none", so it can't invent a category. "none" is saved too (the artist stays in
 * Uncategorized); unanswered artists aren't saved and are asked again next run.
 */
function pickSpec(buckets) {
  const ids = buckets.map((b) => b.id);
  const byName = new Map(buckets.flatMap((b) => [[b.id, b.id], [b.name.toLowerCase(), b.id]]));
  const valid = (v) => (v === "none" ? "none" : byName.get(String(v || "").trim().toLowerCase()) || null);
  const parseJson = (text, count) => {
    const out = new Map();
    const add = (n, pick) => {
      const k = String(n);
      const v = valid(pick);
      if (v && Number.isInteger(+n) && +n >= 1 && +n <= count && !out.has(k)) out.set(k, { playlist: v });
    };
    try {
      const data = JSON.parse(text);
      for (const r of Array.isArray(data?.results) ? data.results : []) add(r?.n, r?.playlist);
      return out;
    } catch { /* cut off: pick out the complete answers */ }
    for (const m of text.matchAll(/\{\s*"n"\s*:\s*(\d+)\s*,\s*"playlist"\s*:\s*"([^"]*)"\s*\}/g)) add(+m[1], m[2]);
    return out;
  };
  const parseLines = (text, count, cutOff) => {
    let lines = text.split(/\r?\n/);
    if (cutOff) lines = lines.slice(0, -1);
    const out = new Map();
    for (const raw of lines) {
      const m = /^\s*[*-]?\s*\**(\d+)\**\s*[:.)\]–-]\s*["'`*]*([^"'`*|]*)/.exec(raw);
      const v = m && valid(m[2]);
      if (v && +m[1] >= 1 && +m[1] <= count && !out.has(m[1])) out.set(m[1], { playlist: v });
    }
    return out;
  };
  return {
    task: `You sort music artists into playlists. For each numbered artist, pick the one playlist their music fits best, from this list (answer with the id):
${buckets.map((b) => `${b.id}: ${b.name}`).join("\n")}
Use everything given: genre tags (from you or from Last.fm listeners), the artists they work with, and their song titles. Answer "none" only if there's no reasonable basis to place the artist at all; never pick from the artist's name alone.`,
    format: {
      json: "Give exactly one result per numbered artist, with its number n.",
      lines: "Reply with exactly one line per artist, starting with its number, and nothing else, e.g.\n1: hip-hop-rap\n2: none",
    },
    room: { json: 16, lines: 10 },
    schema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: { n: { type: "integer" }, playlist: { type: "string", enum: [...ids, "none"] } },
            required: ["n", "playlist"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
    parseJson, parseLines,
  };
}

const pickLine = (a) => {
  const parts = [];
  if (a.tags?.length) parts.push(`tags: ${a.tags.join(", ")}`);
  if (a.lastfm?.length) parts.push(`Last.fm: ${a.lastfm.join(", ")}`);
  if (a.featured?.length) parts.push(`works with: ${a.featured.map((f) => clip(f, 30)).join(", ")}`);
  if (a.titles?.length) parts.push(`songs: ${a.titles.map((t) => clip(t, 35)).join("; ")}`);
  return `${clip(a.name, 60)}${parts.length ? ` (${parts.join("; ")})` : ""}`;
};

/**
 * Picks playlists for artists not yet in `cache` (artist id -> playlist id or "none"),
 * mutating it. `artists` is [{ id, name, tags, lastfm, featured, titles, songCount }].
 */
export async function pickPlaylists(groq, artists, buckets, cache, { batchSize = 50, onProgress = () => {}, onSaved = () => {} } = {}) {
  const todo = artists.filter((a) => !(a.id in cache)).sort((a, b) => b.songCount - a.songCount);
  let done = 0;
  onProgress(0, todo.length);
  await runBatches(groq, todo, {
    spec: pickSpec(buckets), batchSize, key: (a) => a.id, line: pickLine,
    onBatch: (results) => {
      for (const [k, v] of Object.entries(results)) cache[k] = v.playlist;
      done += Object.keys(results).length;
      onSaved(cache);
      onProgress(done, todo.length);
    },
  });
  return cache;
}
