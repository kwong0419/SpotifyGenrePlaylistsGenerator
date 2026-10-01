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
//   * bad or oversized replies are retried in smaller batches; artists the model doesn't
//     know are recorded as unknown rather than guessed.

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
  constructor(resumeAt) {
    super("Groq's free daily allowance is used up for now.");
    this.resumeAt = resumeAt;
  }
}

export const estimateTokens = (text) => Math.ceil(text.length / 3.5);

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
    if (blocked) throw new GroqDailyLimitError(blocked.blockedUntil);
    const c = caps();
    // Bigger than a whole minute's allowance: can never be sent, so make the caller split it.
    if (estimated > c.tpm) throw new GroqError("too_large", "Batch is larger than the per-minute allowance");
    const u = usage();
    if (u.day + estimated > c.tpd || u.dayRequests + 1 > c.rpd) throw new GroqDailyLimitError(dayResumeAt(estimated));
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
          throw new GroqDailyLimitError(now() + wait + 5000);
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
    /** One JSON-mode chat completion, budgeted before sending and recorded after. */
    async chatJSON(system, user, maxTokens) {
      const estimated = estimateTokens(system + user) + maxTokens;
      await waitForBudget(estimated);
      let data;
      try {
        data = await call("/chat/completions", {
          model, temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        });
      } catch (err) {
        if (err instanceof GroqError && (err.kind === "too_large" || err.kind === "bad_output")) record(estimated);
        throw err;
      }
      record(data?.usage?.total_tokens ?? estimated);
      try {
        return JSON.parse(data.choices[0].message.content);
      } catch {
        throw new GroqError("bad_output", "Groq's reply wasn't valid JSON");
      }
    },
    /** For progress messages: rough tokens/minute we allow ourselves, and what's left today. */
    budget() {
      const c = caps();
      return { tpm: c.tpm, tpd: c.tpd, dayLeft: Math.max(0, c.tpd - usage().day) };
    },
  };
}

/** The first model in our preference list that this key can use (or any chat model). */
export function chooseModel(available) {
  return PREFERRED_MODELS.find((m) => available.includes(m))
    || available.find((m) => !/whisper|tts|guard|embed|vision/i.test(m))
    || null;
}

// --------------------------------------------------------------------------- tagging

const ARTIST_PROMPT = `You tag music artists with genres the way Spotify does on artist pages.
For each numbered artist (with example songs from the listener's library), give 1-3 Spotify-style genre tags, most representative first, lowercase, e.g. "chicago drill", "bedroom pop", "classic oklahoma country", "k-pop girl group", "reggaeton", "uk garage", "art pop".
If you don't confidently recognise the artist, give an empty list. Never guess from the name alone.
Also give the numbers of artists whose songs clearly span different broad genres (e.g. both hip hop and rock, or both country and pop).
Reply with JSON only, in this shape: {"tags":{"1":["tag","tag"],"2":[]},"mixed":[3]}`;

const SONG_PROMPT = `You tag individual songs with genres the way Spotify would.
For each numbered song, give 1-2 Spotify-style genre tags describing that specific song (not the artist in general), lowercase, e.g. "pop rap", "alternative rock", "contemporary country", "dance pop".
If you don't confidently know the song, give an empty list. Never guess.
Reply with JSON only, in this shape: {"tags":{"1":["tag"],"2":[]}}`;

/**
 * Roughly how long tagging these artists will take and how much of the daily allowance
 * it needs: { tokens, minutes, days } where days > 1 means it continues on later days.
 */
export function estimateArtistJob(groq, artists, batchSize = 80) {
  const perBatch = estimateTokens(ARTIST_PROMPT) + 40;
  const tokens = artists.reduce((n, a) => n + estimateTokens(artistLine(a)) + 3 + 16, 0)
    + Math.ceil(artists.length / batchSize) * perBatch;
  const { tpm, tpd, dayLeft } = groq.budget();
  const today = Math.min(tokens, dayLeft);
  const days = tokens <= dayLeft ? 1 : 1 + Math.ceil((tokens - dayLeft) / tpd);
  // Pacing allows `tpm` tokens a minute; replies take time too, so add a little.
  const minutes = Math.ceil((today / tpm) * 1.15 + 0.5);
  return { tokens, minutes, days, todayShare: tokens ? today / tokens : 1 };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cleanTags = (v) => (Array.isArray(v) ? v : [])
  .filter((t) => typeof t === "string" && t.trim())
  .map((t) => t.trim().toLowerCase().slice(0, 40))
  .slice(0, 3);

/**
 * Runs `items` through the model in batches, splitting a batch in half when the reply is
 * unusable or too large, down to single items. Items still unanswered are reported as
 * unknown (empty tags). `onBatch(results)` gets { key: { tags, mixed } } after each batch.
 */
async function runBatches(groq, items, { prompt, line, key, batchSize, outPerItem, onBatch }) {
  async function attempt(batch) {
    const user = batch.map((it, i) => `${i + 1}. ${line(it)}`).join("\n");
    let reply;
    try {
      reply = await groq.chatJSON(prompt, user, Math.min(4000, 40 + batch.length * outPerItem));
    } catch (err) {
      if (err instanceof GroqError && (err.kind === "bad_output" || err.kind === "too_large") && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await attempt(batch.slice(0, mid));
        await attempt(batch.slice(mid));
        return;
      }
      if (err instanceof GroqError && err.kind === "bad_output") { // a single item the model can't answer
        onBatch({ [key(batch[0])]: { tags: [], mixed: false } });
        return;
      }
      throw err;
    }
    const tags = reply?.tags && typeof reply.tags === "object" ? reply.tags : {};
    const mixed = new Set((Array.isArray(reply?.mixed) ? reply.mixed : []).map(String));
    const results = {};
    const missing = [];
    batch.forEach((it, i) => {
      const n = String(i + 1);
      if (n in tags) results[key(it)] = { tags: cleanTags(tags[n]), mixed: mixed.has(n) };
      else missing.push(it);
    });
    if (missing.length === batch.length && batch.length > 1) { // ignored the whole batch: try smaller
      const mid = Math.ceil(batch.length / 2);
      await attempt(batch.slice(0, mid));
      await attempt(batch.slice(mid));
      return;
    }
    onBatch(results);
    if (missing.length && missing.length < batch.length) await attempt(missing);
    else if (missing.length) for (const it of missing) onBatch({ [key(it)]: { tags: [], mixed: false } });
  }
  for (let i = 0; i < items.length; i += batchSize) await attempt(items.slice(i, i + batchSize));
}

const artistLine = (a) => `${clip(a.name, 60)}${a.titles.length ? ` (songs: ${a.titles.map((t) => clip(t, 35)).join("; ")})` : ""}`;

/**
 * Tags artists not yet in `cache` (artist id -> { tags, mixed }), mutating it.
 * `artists` is [{ id, name, titles, songCount }]; artists with the most liked songs go
 * first, so if the daily allowance runs out, the most music is already sorted.
 */
export async function tagArtists(groq, artists, cache, { batchSize = 80, onProgress = () => {}, onSaved = () => {} } = {}) {
  const todo = artists.filter((a) => !(a.id in cache)).sort((a, b) => b.songCount - a.songCount);
  let done = 0;
  onProgress(0, todo.length);
  await runBatches(groq, todo, {
    prompt: ARTIST_PROMPT, batchSize, outPerItem: 16, key: (a) => a.id,
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
export async function tagSongs(groq, songs, cache, { batchSize = 60, onProgress = () => {}, onSaved = () => {} } = {}) {
  const todo = songs.filter((s) => !(s.uri in cache));
  let done = 0;
  onProgress(0, todo.length);
  await runBatches(groq, todo, {
    prompt: SONG_PROMPT, batchSize, outPerItem: 12, key: (s) => s.uri,
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
