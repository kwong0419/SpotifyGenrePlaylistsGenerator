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
//   * replies are one short line per item rather than JSON: about half the tokens, and a
//     reply cut off at the length limit still yields every complete line (only the
//     missing items are asked again). Unusable or oversized replies are retried in
//     smaller batches; items the model doesn't know are recorded as unknown, not guessed.

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
     * One plain-text chat completion, budgeted before sending and recorded after.
     * Plain text on purpose: in JSON mode Groq refuses a whole reply (and still charges
     * for it) if it's cut off or malformed, whereas a cut-off text reply is still usable.
     */
    async chatText(system, user, maxTokens) {
      const reasoning = isReasoningModel(model);
      if (reasoning) maxTokens += REASONING_ROOM;
      const estimated = estimateTokens(system + user) + maxTokens;
      await waitForBudget(estimated);
      let data;
      try {
        data = await call("/chat/completions", {
          model, temperature: 0, max_tokens: maxTokens,
          ...(reasoning ? { reasoning_effort: "low", include_reasoning: false } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        });
      } catch (err) {
        if (err instanceof GroqError && (err.kind === "too_large" || err.kind === "bad_output")) record(estimated);
        throw err;
      }
      record(data?.usage?.total_tokens ?? estimated);
      let text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new GroqError("bad_output", "Groq's reply had no text");
      // Cut off at the length limit: the last line may be half-written, so drop it and let
      // that item be asked again rather than saving a truncated tag.
      const cutOff = data.choices[0].finish_reason === "length";
      if (cutOff) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
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

// --------------------------------------------------------------------------- tagging

const ARTIST_PROMPT = `You tag music artists with genres the way Spotify does on artist pages.
For each numbered artist (with example songs from the listener's library), give 1-3 Spotify-style genre tags, most representative first, lowercase, e.g. "chicago drill", "bedroom pop", "classic oklahoma country", "k-pop girl group", "reggaeton", "uk garage", "art pop".
If you don't confidently recognise the artist, leave the answer empty. Never guess from the name alone.
Add "| mixed" when the artist's songs clearly span different broad genres (e.g. both hip hop and rock, or both country and pop).
Reply with exactly one line per artist, in order, and nothing else:
1: chicago drill, drill
2:
3: country pop, pop | mixed`;

const SONG_PROMPT = `You tag individual songs with genres the way Spotify would.
For each numbered song, give 1-2 Spotify-style genre tags describing that specific song (not the artist in general), lowercase, e.g. "pop rap", "alternative rock", "contemporary country", "dance pop".
If you don't confidently know the song, leave the answer empty. Never guess.
Reply with exactly one line per song, in order, and nothing else:
1: pop rap
2:
3: alternative rock, pop rock`;

/**
 * Roughly how long tagging these artists will take and how much of the daily allowance
 * it needs: { tokens, minutes, days } where days > 1 means it continues on later days.
 */
// A reply line like "12: conscious hip hop, west coast rap, hip hop" is ~14 tokens. The
// room allowed per item is generous so replies are rarely cut off (and a cut-off reply
// still yields its complete lines); the estimate uses the typical size.
const ARTIST_REPLY_ROOM = 24;
const ARTIST_REPLY_TYPICAL = 14;
const SONG_REPLY_ROOM = 16;
const ARTIST_BATCH = 60;
const SONG_BATCH = 50;

export function estimateArtistJob(groq, artists, batchSize = ARTIST_BATCH) {
  // Reasoning models also think a little per request (asked for low effort: ~a few hundred tokens).
  const perBatch = estimateTokens(ARTIST_PROMPT) + 40 + (isReasoningModel(groq.model) ? 300 : 0);
  const tokens = artists.reduce((n, a) => n + estimateTokens(artistLine(a)) + 3 + ARTIST_REPLY_TYPICAL, 0)
    + Math.ceil(artists.length / batchSize) * perBatch;
  const { tpm, tpd, dayLeft } = groq.budget();
  // Less left than even a small request needs: nothing can be sorted today at all.
  const smallestRequest = perBatch + 5 * (ARTIST_REPLY_ROOM + 12) + (isReasoningModel(groq.model) ? REASONING_ROOM : 0);
  if (artists.length && dayLeft < smallestRequest) return { tokens, minutes: 0, days: 1 + Math.ceil(tokens / tpd), todayShare: 0, startsToday: false };
  const today = Math.min(tokens, dayLeft);
  const days = tokens <= dayLeft ? 1 : 1 + Math.ceil((tokens - dayLeft) / tpd);
  // Pacing allows `tpm` tokens a minute; replies take time too, so add a little.
  const minutes = Math.ceil((today / tpm) * 1.15 + 0.5);
  return { tokens, minutes, days, todayShare: tokens ? today / tokens : 1, startsToday: true };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const NOT_A_TAG = /^(unknown|none|n\/a|na|-+|\?+|empty)$/i;

/**
 * Reads "N: tag, tag | mixed" lines into Map(N -> { tags, mixed }). Tolerant of the small
 * ways models drift from the format ("1." or "1)", quotes, brackets, the name echoed back
 * as "1: Name: tags"). Lines it can't read are simply missing, so they get asked again.
 */
export function parseReplyLines(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*[*-]?\s*(\d+)\s*[:.)\]–-]\s*(.*)$/.exec(raw);
    if (!m) continue;
    let [answer, flags = ""] = m[2].split("|");
    if (answer.includes(":")) answer = answer.slice(answer.lastIndexOf(":") + 1); // "Name: tags"
    const tags = answer.split(/[,;]/)
      .map((t) => t.replace(/["'`*[\]{}()]/g, "").trim().toLowerCase())
      .filter((t) => t && !NOT_A_TAG.test(t))
      .map((t) => t.slice(0, 40))
      .slice(0, 3);
    if (!out.has(m[1])) out.set(m[1], { tags, mixed: /mixed/i.test(flags) });
  }
  return out;
}

/**
 * Runs `items` through the model in batches. `onBatch(results)` gets { key: { tags, mixed } }
 * for every item the model actually answered; a blank answer means "unknown".
 *
 * Items the model didn't answer are never saved: they're asked again (up to twice) and
 * otherwise left for the next run, so a reply the app couldn't read can't turn into a
 * permanent "unknown". A batch is split in half when Groq refuses it or its reply can't be
 * read (retrying it unchanged is pointless: with temperature 0 the model says the same
 * again), which narrows a problem down to the item causing it.
 *
 * To avoid burning the allowance on a reply format the app can't read: until a readable
 * reply has been seen, an unreadable one is followed by two single-item questions. If
 * neither is readable either, it's the format, not the batch, and sorting stops with a
 * snippet of the reply. It also stops after 8 unreadable replies in a row.
 */
async function runBatches(groq, items, { prompt, line, key, batchSize, outPerItem, onBatch }) {
  let readableSeen = false;
  let streak = 0;

  const formatError = (text) => new GroqError("format", "Sorting stopped to save your Groq allowance: the model's "
    + `replies aren't in the expected format. It replied: "${text.trim().replace(/\s+/g, " ").slice(0, 160) || "(nothing)"}". `
    + "Try another model in Settings.");

  /** One request: { answers, cutOff, text }, or null when Groq refused it (bad or too large). */
  async function ask(batch) {
    const user = batch.map((it, i) => `${i + 1}. ${line(it)}`).join("\n");
    try {
      const reply = await groq.chatText(prompt, user, Math.min(4000, 40 + batch.length * outPerItem));
      return { ...reply, answers: parseReplyLines(reply.text) };
    } catch (err) {
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
    prompt: ARTIST_PROMPT, batchSize, outPerItem: ARTIST_REPLY_ROOM, key: (a) => a.id,
    line: artistLine,
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
    prompt: SONG_PROMPT, batchSize, outPerItem: SONG_REPLY_ROOM, key: (s) => s.uri,
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
