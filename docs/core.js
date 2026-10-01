// Core logic, free of any DOM code so it can be tested in Node with a fake API.
//
// Duplicate safeguards live here:
//   * songs:     dedupeTracks() + one genre per song + writePlaylist() replaces
//                instead of appending, and reads the playlist back to verify it.
//   * playlists: resolvePlaylists() finds existing playlists by a tag in their
//                description, so nothing is created twice even from another device.

export const API = "https://api.spotify.com/v1";
export const UNCATEGORIZED = { id: "uncategorized", name: "Uncategorized", keywords: [] };
const RECENT_CREATE_MS = 60 * 60 * 1000;

export class SpotifyError extends Error {
  constructor(status, message, { ambiguous = false } = {}) {
    super(message);
    this.status = status;
    // true when we can't tell whether Spotify applied the request (5xx / network drop)
    this.ambiguous = ambiguous;
  }
}

// --------------------------------------------------------------------------- API client

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spotify has stopped answering because this app sent too many requests. Requests sent
 * during a lockout can make it longer, so nothing more should be sent until it's over.
 * `retryAfterMs` is how long Spotify asked us to wait, or null when the browser can't
 * read it (Spotify doesn't expose Retry-After to web pages).
 */
export class RateLimitedError extends SpotifyError {
  constructor(retryAfterMs) {
    super(429, "Spotify has paused this app for sending too many requests.");
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * getToken() returns a valid access token; onUnauthorized() refreshes it.
 *
 * Rate limiting: Spotify counts each app's requests over a rolling 30s window. Going over
 * gives a 429; going over repeatedly, or retrying too eagerly, can lock the app out for
 * hours, and requests during a lockout extend it. So:
 *   * pacing: requests go out one turn at a time at a conservative steady rate. The gap
 *     doubles on a 429 and shrinks slowly while requests succeed.
 *   * a short 429 gets two careful retries, after 30s (a full window) and then 60s.
 *   * a third 429 in a row, or a Retry-After longer than `maxShortWaitMs`, means a lockout:
 *     we stop at once with RateLimitedError instead of poking Spotify again.
 *
 * 429 is always safe to retry (Spotify rejected it, nothing was applied). 5xx and network
 * errors are retried only for GET/PUT, which are safe to repeat. A POST that adds
 * songs is never retried blindly, because it may already have gone through.
 */
export function createClient({
  getToken, onUnauthorized, fetchImpl = fetch, onWait = () => {},
  sleepImpl = sleep, minGapMs = 400, startGapMs = 800, maxGapMs = 5000, maxShortWaitMs = 2 * 60 * 1000,
}) {
  let gap = startGapMs;        // current spacing between request starts
  let nextSlot = 0;            // earliest time the next request may start
  let okStreak = 0;
  let consecutive429 = 0;
  let lockedOut = null;        // once Spotify locks us out, this page sends nothing more
  let pauseNo = 0;             // goes up with every counted 429

  async function takeTurn() {
    const now = Date.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + gap;
    if (start > now) await sleepImpl(start - now);
  }

  async function request(method, path, body) {
    const url = path.startsWith("http") ? path : API + path;
    const repeatable = method === "GET" || method === "PUT";
    let failures = 0;
    let refreshed = false;
    for (;;) {
      if (lockedOut) throw lockedOut;
      await takeTurn();
      if (lockedOut) throw lockedOut;
      const sentInPause = pauseNo;
      let resp;
      try {
        resp = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${await getToken()}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (repeatable && failures < 4) { await sleepImpl(1000 * 2 ** failures++); continue; }
        throw new SpotifyError(0, `Network error: ${err.message}`, { ambiguous: !repeatable });
      }
      if (resp.status === 401 && !refreshed) { refreshed = true; await onUnauthorized(); continue; }
      if (resp.status === 429) {
        // A request already in flight when the pause began isn't a new refusal: just wait.
        if (sentInPause < pauseNo) continue;
        pauseNo++;
        gap = Math.min(maxGapMs, gap * 2);
        okStreak = 0;
        consecutive429++;
        const header = parseInt(resp.headers.get("Retry-After") || "", 10);
        const headerMs = header > 0 ? (header + 1) * 1000 : null;
        if (headerMs !== null ? headerMs > maxShortWaitMs : consecutive429 > 2) {
          lockedOut = new RateLimitedError(headerMs);
          throw lockedOut;
        }
        const wait = headerMs ?? 30_000 * consecutive429 + Math.random() * 2000;
        // Pause everyone, not just this request, so the window can actually clear.
        nextSlot = Math.max(nextSlot, Date.now() + wait);
        onWait(wait);
        continue;
      }
      if (resp.status >= 500) {
        if (repeatable && failures < 4) { await sleepImpl(1000 * 2 ** failures++); continue; }
        throw new SpotifyError(resp.status, `Spotify server error ${resp.status}`, { ambiguous: true });
      }
      consecutive429 = 0;
      if (++okStreak >= 25 && gap > minGapMs) { gap = Math.max(minGapMs, gap * 0.9); okStreak = 0; }
      const text = await resp.text();
      const data = text ? JSON.parse(text) : null;
      if (!resp.ok) {
        throw new SpotifyError(resp.status, data?.error?.message || `Spotify error ${resp.status}`);
      }
      return data;
    }
  }
  /** Rough time for `n` more requests at the current pace. */
  const estimateMs = (n) => n * gap;
  return { request, estimateMs };
}

async function getAllPages(api, path) {
  const out = [];
  let url = path;
  while (url) {
    const page = await api.request("GET", url);
    out.push(...page.items);
    url = page.next;
  }
  return out;
}

// --------------------------------------------------------------------------- library

function toTrack(entry) {
  const t = entry.track || entry.item;
  if (!t || !t.id || t.is_local || (t.type && t.type !== "track")) return null;
  return {
    uri: t.uri,
    name: t.name,
    artistIds: t.artists.filter((a) => a.id).map((a) => a.id),
    artistNames: t.artists.map((a) => a.name),
  };
}

/**
 * Liked Songs, newest first. `saved` is { total, firstUris, tracks } from a previous run:
 * if the song count and the 50 newest songs are unchanged, it is reused, so a resumed run
 * costs one request instead of one per 50 songs. Returns { tracks, snapshot }.
 */
export async function fetchLikedTracks(api, onProgress = () => {}, saved = null) {
  const first = await api.request("GET", "/me/tracks?limit=50");
  const firstUris = first.items.map((e) => (e.track || e.item)?.uri);
  if (saved && saved.total === first.total && saved.firstUris?.join() === firstUris.join()) {
    onProgress(saved.tracks.length, first.total);
    return { tracks: saved.tracks, snapshot: saved };
  }
  const tracks = first.items.map(toTrack).filter(Boolean);
  onProgress(tracks.length, first.total);
  let url = first.next;
  while (url) {
    const page = await api.request("GET", url);
    tracks.push(...page.items.map(toTrack).filter(Boolean));
    onProgress(tracks.length, page.total);
    url = page.next;
  }
  return { tracks, snapshot: { total: first.total, firstUris, tracks } };
}

/**
 * Fills `cache` (artist id -> genres[]) with what the tracks need, mutating it.
 *
 * Spotify only allows one artist per request now, so lookups are kept to a minimum:
 * a song is sorted by its main artist, so only main artists are looked up first.
 * Featured artists are looked up only for songs whose main artist gave no usable genre.
 * `onSaved` is called after each artist so progress survives a stop or a reload.
 */
export async function fetchArtistGenres(api, tracks, cache, buckets, {
  onProgress = () => {}, onSaved = () => {}, concurrency = 1,
} = {}) {
  let done = 0;
  let total = 0;
  async function lookUp(ids) {
    const queue = [...new Set(ids)].filter((id) => !(id in cache));
    total += queue.length;
    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        const artist = await api.request("GET", `/artists/${id}`);
        cache[id] = artist.genres || [];
        onSaved(cache);
        onProgress(++done, total);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }

  await lookUp(tracks.map((t) => t.artistIds[0]).filter(Boolean));
  const sortable = (id) => (cache[id] || []).some((g) => bucketForGenre(g, buckets));
  await lookUp(tracks.filter((t) => !sortable(t.artistIds[0])).flatMap((t) => t.artistIds.slice(1)));
  return cache;
}

// --------------------------------------------------------------------------- sorting

export function bucketForGenre(genre, buckets) {
  const g = genre.toLowerCase();
  return buckets.find((b) => b.keywords.some((k) => g.includes(k.toLowerCase()))) || null;
}

/** The single bucket a track belongs to: the one most of its main artist's genres map to. */
export function classifyTrack(track, artistGenres, buckets) {
  // Featured artists are only consulted when the main artist has no usable genres.
  for (const aid of track.artistIds) {
    const votes = new Map();
    for (const g of artistGenres[aid] || []) {
      const b = bucketForGenre(g, buckets);
      if (b) votes.set(b.id, (votes.get(b.id) || 0) + 1);
    }
    if (votes.size) {
      const top = Math.max(...votes.values());
      return buckets.find((b) => votes.get(b.id) === top); // ties go to the earlier bucket
    }
  }
  return UNCATEGORIZED;
}

/** "Song - 2011 Remaster" and "Song (Remastered)" are the same song. */
export function songKey(track) {
  const title = track.name
    .toLowerCase()
    .replace(/\s+-\s+.*remaster.*$/, "")
    .replace(/\s*[([][^)\]]*remaster[^)\]]*[)\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${title}|${track.artistIds[0] || track.artistNames[0]}`;
}

/**
 * Drops the same track liked twice and the same song saved from different releases
 * (single vs album, explicit vs clean, remasters). Keeps the most recently liked copy.
 */
export function dedupeTracks(tracks) {
  const seenUri = new Set();
  const seenSong = new Set();
  const kept = [];
  let removed = 0;
  for (const t of tracks) {
    const key = songKey(t);
    if (seenUri.has(t.uri) || seenSong.has(key)) { removed++; continue; }
    seenUri.add(t.uri);
    seenSong.add(key);
    kept.push(t);
  }
  return { tracks: kept, removed };
}

/** bucket id -> { bucket, tracks[] } in genres.json order, Uncategorized last. */
export function groupTracks(tracks, artistGenres, buckets) {
  const groups = new Map([...buckets, UNCATEGORIZED].map((b) => [b.id, { bucket: b, tracks: [] }]));
  for (const t of tracks) groups.get(classifyTrack(t, artistGenres, buckets).id).tracks.push(t);
  return [...groups.values()].filter((g) => g.tracks.length);
}

// --------------------------------------------------------------------------- playlists

export const tagFor = (bucketId) => `[gs:${bucketId}]`;
const descriptionFor = (bucket) =>
  `Your ${bucket.name} songs from Liked Songs, sorted by Genre Sorter. ${tagFor(bucket.id)}`;

/**
 * Works out which existing playlist (if any) each bucket should write to.
 *
 * Matching order:
 *   1. a playlist you own whose description carries the bucket's tag
 *   2. a playlist you own with exactly the expected name (made before tags existed)
 *   3. a playlist this browser created within the last hour, which Spotify may not
 *      list yet (its playlist list can lag behind a create)
 * More than one match means duplicates already exist; we use one and report the rest
 * rather than deleting anything.
 *
 * `remembered` is bucket id -> { id, createdAt } saved by this browser.
 */
export async function resolvePlaylists(api, userId, buckets, nameFor, remembered = {}, now = Date.now()) {
  const owned = (await getAllPages(api, "/me/playlists?limit=50"))
    .filter((p) => p && p.owner?.id === userId);
  const result = new Map();
  const warnings = [];

  for (const bucket of buckets) {
    const tag = tagFor(bucket.id);
    let matches = owned.filter((p) => (p.description || "").includes(tag));
    if (!matches.length) matches = owned.filter((p) => p.name === nameFor(bucket));

    const mem = remembered[bucket.id];
    if (matches.length) {
      const chosen = matches.find((p) => p.id === mem?.id) || matches[0];
      result.set(bucket.id, { playlistId: chosen.id, isNew: false });
      const extras = matches.filter((p) => p !== chosen);
      if (extras.length) {
        warnings.push({ bucket, keptId: chosen.id, extraIds: extras.map((p) => p.id) });
      }
    } else if (mem && now - mem.createdAt < RECENT_CREATE_MS) {
      try {
        const p = await api.request("GET", `/playlists/${mem.id}`);
        if (p.owner?.id === userId) { result.set(bucket.id, { playlistId: p.id, isNew: false }); continue; }
      } catch { /* gone: fall through and create */ }
      result.set(bucket.id, { playlistId: null, isNew: true });
    } else {
      // Not in your library any more (or never made): a fresh one is not a duplicate.
      result.set(bucket.id, { playlistId: null, isNew: true });
    }
  }
  return { targets: result, warnings };
}

async function readPlaylistUris(api, playlistId) {
  const items = await getAllPages(api, `/playlists/${playlistId}/items?limit=100`);
  return items.map((e) => (e.item || e.track)?.uri).filter(Boolean);
}

const sameList = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);

/**
 * Makes the playlist contain exactly `uris`, in order, once each.
 * The first 100 go in with a replace (PUT), which wipes whatever was there, so a re-run
 * or a retry after a half-finished run can never stack songs twice. Then we read the
 * playlist back; if it doesn't match exactly, the whole thing is rewritten.
 */
export async function writePlaylist(api, playlistId, uris, { verifyDelayMs = 800 } = {}) {
  uris = [...new Set(uris)];
  let lastProblem = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await api.request("PUT", `/playlists/${playlistId}/items`, { uris: uris.slice(0, 100) });
      for (let i = 100; i < uris.length; i += 100) {
        await api.request("POST", `/playlists/${playlistId}/items`, { uris: uris.slice(i, i + 100) });
      }
    } catch (err) {
      if (!(err instanceof SpotifyError) || !err.ambiguous) throw err;
      lastProblem = err.message; // unknown whether it applied: start over with a replace
      continue;
    }
    // Spotify can take a moment to reflect a write, so re-read once before rewriting.
    for (const wait of [verifyDelayMs, verifyDelayMs * 3]) {
      await sleep(wait);
      const actual = await readPlaylistUris(api, playlistId);
      if (sameList(actual, uris)) return { attempts: attempt };
      lastProblem = `playlist has ${actual.length} songs, expected ${uris.length}`;
    }
  }
  throw new Error(`Could not confirm the playlist was written correctly (${lastProblem}).`);
}

/**
 * Creates/updates one playlist per selected group. `remember(bucketId, playlistId)` is
 * called the moment a playlist is created so even a crash right after can't lead to
 * a second one being made next time.
 */
export async function syncPlaylists(api, {
  userId, groups, nameFor, isPublic, remembered, remember, onStep = () => {}, verifyDelayMs,
}) {
  const buckets = groups.map((g) => g.bucket);
  onStep({ phase: "checking" });
  const { targets, warnings } = await resolvePlaylists(api, userId, buckets, nameFor, remembered);
  const results = [];
  for (const [i, g] of groups.entries()) {
    const target = targets.get(g.bucket.id);
    onStep({ phase: "writing", index: i, total: groups.length, bucket: g.bucket });
    let playlistId = target.playlistId;
    if (playlistId) {
      await api.request("PUT", `/playlists/${playlistId}`, {
        name: nameFor(g.bucket), description: descriptionFor(g.bucket),
      });
    } else {
      const created = await api.request("POST", "/me/playlists", {
        name: nameFor(g.bucket), public: isPublic, description: descriptionFor(g.bucket),
      });
      playlistId = created.id;
      remember(g.bucket.id, playlistId);
    }
    await writePlaylist(api, playlistId, g.tracks.map((t) => t.uri), { verifyDelayMs });
    results.push({ bucket: g.bucket, playlistId, count: g.tracks.length, isNew: target.isNew });
  }
  return { results, warnings };
}
