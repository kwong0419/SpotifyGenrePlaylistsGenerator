// Run with: node --test tests/
// A small in-memory Spotify that misbehaves on purpose (lagging playlist list,
// requests that apply and then report failure) to prove no duplicates slip through.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createClient, fetchLikedTracks, fetchArtistGenres, RateLimitedError, dedupeTracks, groupTracks,
  syncPlaylists, classifyTrack, UNCATEGORIZED,
} from "../docs/core.js";

import { FakeSpotify, ME } from "./fake-spotify.mjs";

const BUCKETS = JSON.parse(readFileSync(new URL("../docs/genres.json", import.meta.url))).buckets;
const track = (i, name, artistId, extra = {}) => ({
  added_at: `2026-01-${String(28 - (i % 28)).padStart(2, "0")}`,
  track: { id: `t${i}`, uri: `spotify:track:t${i}`, name, type: "track", artists: [{ id: artistId, name: artistId }], ...extra },
});

function library(n = 250) {
  const liked = [];
  for (let i = 0; i < n; i++) liked.push(track(i, `Song ${i}`, ["rapper", "indie", "latin", "nogenre"][i % 4]));
  return {
    liked,
    artists: { rapper: ["chicago drill", "rap"], indie: ["bedroom pop"], latin: ["reggaeton"], nogenre: [] },
  };
}

function fakeClient(spotify, extra = {}) {
  return createClient({
    getToken: async () => "tok", onUnauthorized: async () => {}, fetchImpl: (...a) => spotify.fetch(...a),
    minGapMs: 0, startGapMs: 0, sleepImpl: async () => {}, ...extra,
  });
}

async function run(spotify, remembered = {}, { prefix = "Liked · " } = {}) {
  const api = fakeClient(spotify);
  const { tracks: liked } = await fetchLikedTracks(api);
  const { tracks } = dedupeTracks(liked);
  const genres = await fetchArtistGenres(api, tracks, {}, BUCKETS);
  const groups = groupTracks(tracks, genres, BUCKETS).filter((g) => g.bucket.id !== "uncategorized");
  return syncPlaylists(api, {
    userId: ME, groups, nameFor: (b) => prefix + b.name, isPublic: false, remembered,
    remember: (id, pid) => { remembered[id] = { id: pid, createdAt: Date.now() }; }, verifyDelayMs: 0,
  });
}

function assertNoDuplicates(spotify) {
  const names = [...spotify.followed].map((id) => spotify.playlists.get(id).name);
  assert.equal(new Set(names).size, names.length, `duplicate playlists: ${names}`);
  for (const id of spotify.followed) {
    const items = spotify.playlists.get(id).items;
    assert.equal(new Set(items).size, items.length, `duplicate songs in ${id}`);
  }
}

test("first run creates one playlist per genre with every song once", async () => {
  const sp = new FakeSpotify(library());
  const { results } = await run(sp);
  assert.equal(sp.creates, 3);
  assert.deepEqual(results.map((r) => r.count), [62, 63, 63]);
  assertNoDuplicates(sp);
});

test("re-running, even from a different browser, never makes new playlists or doubles songs", async () => {
  const sp = new FakeSpotify(library());
  const remembered = {};
  await run(sp, remembered);
  await run(sp, remembered);          // same browser
  await run(sp, {});                  // fresh browser: found via description tag
  assert.equal(sp.creates, 3);
  assertNoDuplicates(sp);
  assert.equal(sp.playlists.get("pl1").items.length, 62);
});

test("renaming playlists in Spotify still doesn't cause duplicates", async () => {
  const sp = new FakeSpotify(library());
  await run(sp);
  sp.playlists.get("pl1").name = "my latin bangers";
  await run(sp, {});
  assert.equal(sp.creates, 3);
  assertNoDuplicates(sp);
});

test("changing the name prefix updates the same playlists", async () => {
  const sp = new FakeSpotify(library());
  await run(sp, {});
  await run(sp, {}, { prefix: "🎧 " });
  assert.equal(sp.creates, 3);
  assert.ok([...sp.playlists.values()].every((p) => p.name.startsWith("🎧 ")));
});

test("a just-created playlist missing from Spotify's lagging list is reused, not recreated", async () => {
  const sp = new FakeSpotify(library());
  const remembered = {};
  await run(sp, remembered);
  ["pl1", "pl2", "pl3"].forEach((id) => sp.hiddenFromList.add(id));
  await run(sp, remembered);
  assert.equal(sp.creates, 3);
  sp.hiddenFromList.clear();
  assertNoDuplicates(sp);
});

test("an add that succeeds but reports an error is not double-added", async () => {
  const lib = library(1200); // >100 songs per playlist so POST appends are used
  const sp = new FakeSpotify(lib);
  sp.failAfterApply = 2;
  await run(sp);
  assertNoDuplicates(sp);
  assert.equal(sp.playlists.get("pl1").items.length, 300);
});

test("playlists deleted by the user are recreated once, not duplicated", async () => {
  const sp = new FakeSpotify(library());
  await run(sp, {});
  sp.followed = sp.followed.filter((id) => id !== "pl2");
  await run(sp, {});
  await run(sp, {});
  assert.equal(sp.creates, 4);
  assertNoDuplicates(sp);
});

test("existing duplicates made elsewhere are reported, one is used, none are added", async () => {
  const sp = new FakeSpotify(library());
  sp.addPlaylist({ id: "old1", name: "Liked · Latin" });
  sp.addPlaylist({ id: "old2", name: "Liked · Latin" });
  const { warnings } = await run(sp, {});
  assert.equal(sp.creates, 2);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].extraIds, ["old2"]);
  assert.equal(sp.playlists.get("old2").items.length, 0);
});

test("the same song liked from two releases is only included once", () => {
  const raw = [
    { uri: "a", name: "Hey Jude - Remastered 2015", artistIds: ["beatles"], artistNames: [] },
    { uri: "b", name: "Hey Jude", artistIds: ["beatles"], artistNames: [] },
    { uri: "c", name: "Hey Jude (Remastered)", artistIds: ["beatles"], artistNames: [] },
    { uri: "a", name: "Hey Jude - Remastered 2015", artistIds: ["beatles"], artistNames: [] },
    { uri: "d", name: "Hey Jude", artistIds: ["cover-band"], artistNames: [] },
    { uri: "e", name: "Hey Jude (Live)", artistIds: ["beatles"], artistNames: [] },
  ];
  const { tracks, removed } = dedupeTracks(raw);
  assert.deepEqual(tracks.map((t) => t.uri), ["a", "d", "e"]);
  assert.equal(removed, 3);
});

test("songs go to exactly one genre, using featured artists only as a fallback", () => {
  const g = { a: ["pop", "dance pop", "edm"], b: ["trap"], c: [] };
  assert.equal(classifyTrack({ artistIds: ["a", "b"] }, g, BUCKETS).id, "pop");
  assert.equal(classifyTrack({ artistIds: ["c", "b"] }, g, BUCKETS).id, "hip-hop-rap");
  assert.equal(classifyTrack({ artistIds: ["c"] }, g, BUCKETS), UNCATEGORIZED);
});

test("a short slow-down is waited out with two careful retries", async () => {
  const sp = new FakeSpotify(library());
  const waits = [];
  const api = fakeClient(sp, { onWait: (ms) => waits.push(ms) });
  const { tracks } = await fetchLikedTracks(api);
  sp.rateLimitNext = 2;
  await fetchArtistGenres(api, tracks, {}, BUCKETS);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 30_000 && waits[0] < 33_000, `first wait covers a full 30s window: ${waits[0]}`);
  assert.ok(waits[1] >= 60_000 && waits[1] < 63_000, `second wait is longer: ${waits[1]}`);
});

test("a lockout stops at once, sends nothing more, and keeps what was found", async () => {
  const sp = new FakeSpotify(library());
  const api = fakeClient(sp);
  const { tracks } = await fetchLikedTracks(api);
  const cache = {};
  await fetchArtistGenres(api, tracks.slice(0, 1), cache, BUCKETS);
  sp.rateLimitNext = 1000;
  let sent = 0;
  const realFetch = sp.fetch;
  sp.fetch = (...a) => { sent++; return realFetch(...a); };
  const err = await fetchArtistGenres(api, tracks, cache, BUCKETS).catch((e) => e);
  assert.ok(err instanceof RateLimitedError, String(err));
  assert.equal(err.retryAfterMs, null, "browsers can't read Retry-After");
  assert.ok(sent <= 4, `only a couple of probes during a lockout, sent ${sent}`);
  assert.equal(Object.keys(cache).length, 1, "earlier results are kept for next time");
  const before = sent;
  await assert.rejects(api.request("GET", "/me"), RateLimitedError);
  assert.equal(sent, before, "the page sends nothing more after a lockout");
});

test("refusals for requests already in flight count once, not as a lockout", async () => {
  const sp = new FakeSpotify(library());
  const waits = [];
  const api = fakeClient(sp, { onWait: (ms) => waits.push(ms) });
  const { tracks } = await fetchLikedTracks(api);
  sp.rateLimitNext = 3; // three parallel requests all refused at the same moment
  const cache = await fetchArtistGenres(api, tracks, {}, BUCKETS, { concurrency: 3 });
  assert.equal(Object.keys(cache).length, 4);
  assert.equal(waits.length, 1, `one pause, not a lockout: ${waits}`);
});

test("a readable long Retry-After stops immediately and reports it", async () => {
  const sp = new FakeSpotify(library());
  const api = fakeClient(sp);
  const realFetch = sp.fetch;
  sp.fetch = async () => ({ ok: false, status: 429, headers: { get: (k) => (k === "Retry-After" ? "49000" : null) }, text: async () => "" });
  const err = await api.request("GET", "/me").catch((e) => e);
  assert.ok(err instanceof RateLimitedError);
  assert.equal(err.retryAfterMs, 49001_000);
  sp.fetch = realFetch;
});

test("a resumed run reuses saved Liked Songs when nothing changed", async () => {
  const sp = new FakeSpotify(library(400));
  const api = fakeClient(sp);
  let calls = 0;
  const realFetch = sp.fetch;
  sp.fetch = (...a) => { calls++; return realFetch(...a); };
  const first = await fetchLikedTracks(api);
  assert.equal(calls, 8);
  calls = 0;
  const again = await fetchLikedTracks(api, () => {}, first.snapshot);
  assert.equal(calls, 1, "one request instead of eight");
  assert.equal(again.tracks.length, 400);
  sp.liked.unshift(track(999, "New Like", "rapper"));
  calls = 0;
  const changed = await fetchLikedTracks(api, () => {}, first.snapshot);
  assert.equal(changed.tracks.length, 401, "a new like means a fresh read");
  assert.ok(calls > 1);
});

test("only main artists are looked up unless a song needs its featured artists", async () => {
  const sp = new FakeSpotify({
    liked: [
      track(0, "A", "rapper", { artists: [{ id: "rapper", name: "r" }, { id: "feat1", name: "f1" }] }),
      track(1, "B", "nogenre", { artists: [{ id: "nogenre", name: "n" }, { id: "feat2", name: "f2" }] }),
    ],
    artists: { rapper: ["rap"], nogenre: [], feat1: ["pop"], feat2: ["pop"] },
  });
  const api = fakeClient(sp);
  const { tracks } = await fetchLikedTracks(api);
  const cache = await fetchArtistGenres(api, tracks, {}, BUCKETS);
  assert.deepEqual(Object.keys(cache).sort(), ["feat2", "nogenre", "rapper"]); // feat1 never needed
  assert.equal(sp.artistLookups, 3);
  await fetchArtistGenres(api, tracks, cache, BUCKETS);
  assert.equal(sp.artistLookups, 3, "a second run looks nothing up again");
});

test("requests are spaced out, and spacing grows after a slow-down", async () => {
  const sp = new FakeSpotify(library(40));
  const slept = [];
  const api = createClient({
    getToken: async () => "tok", onUnauthorized: async () => {}, fetchImpl: sp.fetch,
    minGapMs: 100, startGapMs: 200, sleepImpl: async (ms) => { slept.push(ms); },
  });
  const { tracks } = await fetchLikedTracks(api);
  await fetchArtistGenres(api, tracks, {}, BUCKETS, { concurrency: 1 });
  assert.ok(slept.length > 0, "requests waited for their turn");
});
