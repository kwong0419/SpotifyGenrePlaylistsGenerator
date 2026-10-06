// Core logic, free of any DOM code so it can be tested in Node with a fake API.
//
// Duplicate safeguards live here:
//   * songs:     dedupeTracks() + one genre per song + writePlaylist() replaces
//                instead of appending, and reads the playlist back to verify it.
//   * playlists: resolvePlaylists() finds existing playlists by a tag in their
//                description, so nothing is created twice even from another device.

export const API = "https://api.spotify.com/v1";
export const UNCATEGORIZED = { id: "uncategorized", name: "Uncategorized", keywords: [] };
// Songs whose artist hasn't been sorted yet (e.g. Groq's daily allowance ran out). Never
// turned into a playlist; they're sorted on a later run.
export const NOT_SORTED_YET = { id: "not-sorted-yet", name: "Not sorted yet", keywords: [] };
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
  constructor(retryAfterMs, { quota = false } = {}) {
    super(429, quota
      ? "Spotify says this developer account has used up its request quota for now."
      : "Spotify has paused this app for sending too many requests.");
    this.retryAfterMs = retryAfterMs;
    // QUOTA_EXCEEDED: the account's allowance is used up (observed to last ~20 hours),
    // as opposed to a short burst over the rate limit.
    this.quota = quota;
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
        // Spotify labels quota refusals in the body (which, unlike Retry-After, browsers can
        // read). Waiting a few seconds never helps with those, so stop straight away.
        let reason = "";
        try { const b = JSON.parse(await resp.text()); reason = b?.error?.reason || b?.reason || ""; } catch { /* no body */ }
        if (/QUOTA_EXCEEDED/i.test(reason)) {
          const h = parseInt(resp.headers.get("Retry-After") || "", 10);
          lockedOut = new RateLimitedError(h > 0 ? (h + 1) * 1000 : null, { quota: true });
          throw lockedOut;
        }
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

// --------------------------------------------------------------------------- sorting

/**
 * The playlist list from taxonomy.json as one flat list, each broad genre followed by its
 * subgenres: [{ id, name, hint, parent }] where parent is the broad genre's id (or null).
 */
export function flattenTaxonomy(genres) {
  return genres.flatMap((g) => [
    { id: g.id, name: g.name, hint: g.hint, parent: null },
    ...(g.sub || []).map((s) => ({ id: s.id, name: s.name, hint: s.hint, parent: g.id })),
  ]);
}

export const MIN_SUBGENRE_SONGS = 15;

/**
 * Groups songs into playlists from the playlist chosen for each song (`picks`: uri ->
 * playlist id or "none"). A subgenre only becomes its own playlist when it has at least
 * `minSubgenre` songs, or a playlist for it already exists (`keepIds`), so playlists don't
 * flip between runs; otherwise its songs go into the broad genre's playlist.
 * Songs answered "none", or picked into an unknown id, go to Uncategorized; songs for
 * which `isPending` is true (not sorted yet) to Not sorted yet.
 * Returns [{ bucket, tracks }] in taxonomy order, then Uncategorized, then Not sorted yet.
 */
export function groupSongs(tracks, picks, nodes, { isPending = () => false, keepIds = new Set(), minSubgenre = MIN_SUBGENRE_SONGS } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chosen = new Map();
  const counts = new Map();
  for (const t of tracks) {
    const node = isPending(t) ? NOT_SORTED_YET : byId.get(picks[t.uri]) || UNCATEGORIZED;
    chosen.set(t, node);
    counts.set(node.id, (counts.get(node.id) || 0) + 1);
  }
  const groups = new Map([...nodes, UNCATEGORIZED, NOT_SORTED_YET].map((n) => [n.id, { bucket: n, tracks: [] }]));
  for (const t of tracks) {
    let node = chosen.get(t);
    if (node.parent && (counts.get(node.id) || 0) < minSubgenre && !keepIds.has(node.id)) node = byId.get(node.parent);
    groups.get(node.id).tracks.push(t);
  }
  return [...groups.values()].filter((g) => g.tracks.length);
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
 * `remembered` is bucket id -> { id, createdAt, snapshot, hash } saved by this browser.
 * Also returns `retired`: playlists this app made for genres no longer in `buckets`.
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
      result.set(bucket.id, { playlistId: chosen.id, isNew: false, snapshot: chosen.snapshot_id, name: chosen.name });
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
  // Playlists made for a genre that's no longer in the list (say "K-Pop & J-Pop" after it
  // was split in two). Their songs now live in other playlists, so they must be emptied.
  const known = new Set([...buckets.map((b) => b.id), NOT_SORTED_YET.id]);
  const retired = owned
    .map((p) => ({ playlist: p, id: /\[gs:([a-z0-9-]+)\]/.exec(p.description || "")?.[1] }))
    .filter(({ id }) => id && !known.has(id))
    .map(({ playlist, id }) => ({ bucketId: id, playlistId: playlist.id, name: playlist.name }));
  return { targets: result, warnings, retired };
}

async function readPlaylistUris(api, playlistId) {
  const items = await getAllPages(api, `/playlists/${playlistId}/items?limit=100`);
  return items.map((e) => (e.item || e.track)?.uri).filter(Boolean);
}

/** The playlist's song count with one request, or null if Spotify didn't include it. */
async function readPlaylistCount(api, playlistId) {
  const p = await api.request("GET", `/playlists/${playlistId}?fields=items(total),tracks(total)`);
  const total = p?.items?.total ?? p?.tracks?.total;
  return typeof total === "number" ? total : null;
}

const sameList = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);

/** A short fingerprint of a song list, to tell whether a playlist needs rewriting. */
export function listHash(uris) {
  let h = 0x811c9dc5;
  for (const ch of uris.join("\n")) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `${uris.length}:${h.toString(36)}`;
}

/**
 * Makes the playlist contain exactly `uris`, in order, once each.
 * The first 100 go in with a replace (PUT), which wipes whatever was there, so a re-run
 * or a retry after a half-finished run can never stack songs twice.
 *
 * Checking afterwards: a clean write is confirmed with the song count (1 request; a
 * doubled-up add would show as too many songs). If anything went wrong on the way,
 * every song is read back and compared. Either way a mismatch means a full rewrite.
 * Returns { snapshot } (Spotify's version id after the write).
 */
export async function writePlaylist(api, playlistId, uris, { verifyDelayMs = 800 } = {}) {
  uris = [...new Set(uris)];
  let lastProblem = "";
  let troubled = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let snapshot = null;
    try {
      snapshot = (await api.request("PUT", `/playlists/${playlistId}/items`, { uris: uris.slice(0, 100) }))?.snapshot_id;
      for (let i = 100; i < uris.length; i += 100) {
        snapshot = (await api.request("POST", `/playlists/${playlistId}/items`, { uris: uris.slice(i, i + 100) }))?.snapshot_id ?? snapshot;
      }
    } catch (err) {
      if (!(err instanceof SpotifyError) || !err.ambiguous) throw err;
      lastProblem = err.message; // unknown whether it applied: start over with a replace
      troubled = true;
      continue;
    }
    // Spotify can take a moment to reflect a write, so re-check once before rewriting.
    for (const wait of [verifyDelayMs, verifyDelayMs * 3]) {
      await sleep(wait);
      const count = troubled ? null : await readPlaylistCount(api, playlistId);
      if (count !== null) {
        if (count === uris.length) return { snapshot };
        lastProblem = `playlist has ${count} songs, expected ${uris.length}`;
        troubled = true;
        continue;
      }
      const actual = await readPlaylistUris(api, playlistId);
      if (sameList(actual, uris)) return { snapshot };
      lastProblem = `playlist has ${actual.length} songs, expected ${uris.length}`;
    }
  }
  throw new Error(`Could not confirm the playlist was written correctly (${lastProblem}).`);
}

/**
 * Which groups to write. Ticked genres get a playlist; genres that already have one are
 * always kept up to date, ticked or not, and emptied if all their songs moved elsewhere.
 * Otherwise a song that moved (say from Country to Pop when its own genre was worked out
 * on a later run) would be left behind in the old playlist too. "Not sorted yet" is
 * never written.
 *
 * `targets` is resolvePlaylists() output for every bucket; `buckets` is every bucket.
 */
export function planSync(groups, targets, selectedIds, buckets) {
  const byId = new Map(groups.map((g) => [g.bucket.id, g]));
  const plan = [];
  for (const bucket of [...buckets, UNCATEGORIZED]) {
    const existing = targets.get(bucket.id) && !targets.get(bucket.id).isNew;
    const group = byId.get(bucket.id);
    if (existing) plan.push(group || { bucket, tracks: [] });
    else if (group && selectedIds.has(bucket.id)) plan.push(group);
  }
  return plan;
}

/**
 * Creates/updates one playlist per group (see planSync for which groups).
 *
 * `remember(bucketId, info)` saves { id, createdAt } the moment a playlist is created, so
 * even a crash right after can't lead to a second one next time, and { snapshot, hash }
 * after each write. A playlist whose songs haven't changed and that nobody has edited
 * since (same Spotify version id) is left alone, which keeps re-runs to a few requests.
 */
export async function syncPlaylists(api, {
  userId, groups, nameFor, isPublic, remembered, remember, onStep = () => {}, verifyDelayMs, knownBuckets,
}) {
  const buckets = groups.map((g) => g.bucket);
  onStep({ phase: "checking" });
  // Retiring needs the full playlist list (`knownBuckets`): judged against only the genres
  // being written now, every other playlist would look retired.
  const { targets, warnings, retired: found } = await resolvePlaylists(api, userId, knownBuckets || buckets, nameFor, remembered);
  const retired = knownBuckets ? found : [];
  const results = [];
  for (const [i, g] of groups.entries()) {
    const target = targets.get(g.bucket.id);
    const uris = g.tracks.map((t) => t.uri);
    const hash = listHash([...new Set(uris)]);
    const mem = remembered[g.bucket.id];
    onStep({ phase: "writing", index: i, total: groups.length, bucket: g.bucket });

    let playlistId = target.playlistId;
    if (playlistId && mem?.id === playlistId && mem.hash === hash && mem.snapshot && mem.snapshot === target.snapshot) {
      if (target.name !== nameFor(g.bucket)) {
        await api.request("PUT", `/playlists/${playlistId}`, { name: nameFor(g.bucket), description: descriptionFor(g.bucket) });
        remember(g.bucket.id, { snapshot: null }); // a rename can change the version id; recheck next time
      }
      results.push({ bucket: g.bucket, playlistId, count: g.tracks.length, isNew: false, unchanged: true });
      continue;
    }
    if (playlistId) {
      await api.request("PUT", `/playlists/${playlistId}`, {
        name: nameFor(g.bucket), description: descriptionFor(g.bucket),
      });
    } else {
      const created = await api.request("POST", "/me/playlists", {
        name: nameFor(g.bucket), public: isPublic, description: descriptionFor(g.bucket),
      });
      playlistId = created.id;
      remember(g.bucket.id, { id: playlistId, createdAt: Date.now() });
    }
    const { snapshot } = await writePlaylist(api, playlistId, uris, { verifyDelayMs });
    remember(g.bucket.id, { id: playlistId, snapshot, hash });
    results.push({ bucket: g.bucket, playlistId, count: g.tracks.length, isNew: target.isNew });
  }
  // Retired playlists are emptied (once; already-empty ones are left alone) so none of
  // their songs is also in its new playlist. Deleting them is left to the user.
  for (const r of retired) {
    const count = await readPlaylistCount(api, r.playlistId);
    if (count !== 0) {
      await api.request("PUT", `/playlists/${r.playlistId}`, {
        description: `No longer used by Genre Sorter: its songs moved to other playlists. Safe to delete. ${tagFor(r.bucketId)}`,
      });
      await writePlaylist(api, r.playlistId, [], { verifyDelayMs });
    }
  }
  return { results, warnings, retired };
}
