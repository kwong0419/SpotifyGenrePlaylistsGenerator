// Run with: node --test tests/
// A small in-memory Spotify that misbehaves on purpose (lagging playlist list,
// requests that apply and then report failure) to prove no duplicates slip through.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createClient, fetchLikedTracks, RateLimitedError, dedupeTracks, flattenTaxonomy, groupSongs,
  syncPlaylists, UNCATEGORIZED, NOT_SORTED_YET, planSync, resolvePlaylists,
} from "../docs/core.js";

import { FakeSpotify, ME } from "./fake-spotify.mjs";

const NODES = flattenTaxonomy(JSON.parse(readFileSync(new URL("../docs/taxonomy.json", import.meta.url))).genres);
const track = (i, name, artistId, extra = {}) => ({
  added_at: `2026-01-${String(28 - (i % 28)).padStart(2, "0")}`,
  track: { id: `t${i}`, uri: `spotify:track:t${i}`, name, type: "track", artists: [{ id: artistId, name: artistId }], ...extra },
});

// The playlist Groq picks for each test artist's songs ("none": it doesn't know them).
const LIB_PICKS = { rapper: "hip-hop-rap", indie: "indie-alternative", latin: "latin", nogenre: "none" };

function library(n = 250) {
  const liked = [];
  for (let i = 0; i < n; i++) liked.push(track(i, `Song ${i}`, ["rapper", "indie", "latin", "nogenre"][i % 4]));
  return {
    liked,
    artists: {},
    playlists: LIB_PICKS,
  };
}

/** uri -> playlist for every song, from an artist -> playlist map (standing in for Groq). */
const picksFor = (tracks, byArtist, overrides = {}) =>
  Object.fromEntries(tracks.map((t) => [t.uri, overrides[t.uri] ?? byArtist[t.artistIds[0]] ?? "none"]));

function fakeClient(spotify, extra = {}) {
  return createClient({
    getToken: async () => "tok", onUnauthorized: async () => {}, fetchImpl: (...a) => spotify.fetch(...a),
    minGapMs: 0, startGapMs: 0, sleepImpl: async () => {}, ...extra,
  });
}

// Playlists come from Groq in the app; here the fake library's picks stand in for them.
async function run(spotify, remembered = {}, { prefix = "Liked · " } = {}) {
  const api = fakeClient(spotify);
  const { tracks: liked } = await fetchLikedTracks(api);
  const { tracks } = dedupeTracks(liked);
  const groups = groupSongs(tracks, picksFor(tracks, LIB_PICKS), NODES).filter((g) => g.bucket.id !== "uncategorized");
  return syncPlaylists(api, {
    userId: ME, groups, nameFor: (b) => prefix + b.name, isPublic: false, remembered,
    remember: (id, info) => { remembered[id] = { ...remembered[id], ...info }; }, verifyDelayMs: 0,
  });
}

/** Looks artists up one by one, standing in for any run of Spotify requests. */
async function lookUp(api, ids, cache = {}, concurrency = 1) {
  const queue = [...ids];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) { const id = queue.shift(); cache[id] = (await api.request("GET", `/artists/${id}`)).genres; }
  }));
  return cache;
}
const ARTISTS = ["rapper", "indie", "latin", "nogenre"];

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
  assert.deepEqual(results.map((r) => [r.bucket.id, r.count]), [["hip-hop-rap", 63], ["indie-alternative", 63], ["latin", 62]]);
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
  assert.equal(sp.playlists.get("pl1").items.length, 63);
});

test("renaming playlists in Spotify still doesn't cause duplicates", async () => {
  const sp = new FakeSpotify(library());
  await run(sp);
  sp.playlists.get("pl1").name = "my rap bangers";
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

test("a short slow-down is waited out with two careful retries", async () => {
  const sp = new FakeSpotify(library());
  const waits = [];
  const api = fakeClient(sp, { onWait: (ms) => waits.push(ms) });
  const { tracks } = await fetchLikedTracks(api);
  sp.rateLimitNext = 2;
  await lookUp(api, ARTISTS);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 30_000 && waits[0] < 33_000, `first wait covers a full 30s window: ${waits[0]}`);
  assert.ok(waits[1] >= 60_000 && waits[1] < 63_000, `second wait is longer: ${waits[1]}`);
});

test("a lockout stops at once, sends nothing more, and keeps what was found", async () => {
  const sp = new FakeSpotify(library());
  const api = fakeClient(sp);
  const { tracks } = await fetchLikedTracks(api);
  const cache = {};
  await lookUp(api, ["rapper"], cache);
  sp.rateLimitNext = 1000;
  let sent = 0;
  const realFetch = sp.fetch;
  sp.fetch = (...a) => { sent++; return realFetch(...a); };
  const err = await lookUp(api, ARTISTS, cache).catch((e) => e);
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
  const cache = await lookUp(api, ARTISTS, {}, 3);
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

test("requests are spaced out, and spacing grows after a slow-down", async () => {
  const sp = new FakeSpotify(library(40));
  const slept = [];
  const api = createClient({
    getToken: async () => "tok", onUnauthorized: async () => {}, fetchImpl: sp.fetch,
    minGapMs: 100, startGapMs: 200, sleepImpl: async (ms) => { slept.push(ms); },
  });
  const { tracks } = await fetchLikedTracks(api);
  await lookUp(api, ARTISTS);
  assert.ok(slept.length > 0, "requests waited for their turn");
});

test("Spotify's QUOTA_EXCEEDED stops at once, without any retries", async () => {
  const sp = new FakeSpotify(library());
  sp.quotaExceeded = true;
  const waits = [];
  const api = fakeClient(sp, { onWait: (ms) => waits.push(ms) });
  const err = await api.request("GET", "/me/tracks?limit=50").catch((e) => e);
  assert.ok(err instanceof RateLimitedError && err.quota, String(err));
  assert.equal(sp.log.length, 1, "one request, no retries");
  assert.equal(waits.length, 0);
});

test("re-runs leave unchanged playlists alone", async () => {
  const sp = new FakeSpotify(library());
  const remembered = {};
  await run(sp, remembered);
  sp.log = [];
  const { results } = await run(sp, remembered);
  assert.ok(results.every((r) => r.unchanged));
  assert.ok(!sp.log.some((l) => /^(PUT|POST) \/playlists/.test(l)), `no writes: ${sp.log}`);
  const playlistRequests = sp.log.filter((l) => !l.startsWith("GET /me/tracks"));
  assert.deepEqual(playlistRequests, ["GET /me/playlists"], "one request to check every playlist");
});

test("a playlist edited in Spotify, or with new songs, is rewritten exactly", async () => {
  const sp = new FakeSpotify(library());
  const remembered = {};
  await run(sp, remembered);
  sp.userAdds("pl3", "spotify:track:t0");      // someone added a rap song to Latin by hand
  sp.liked.unshift(track(900, "New Rap Song", "rapper"));
  await run(sp, remembered);
  assertNoDuplicates(sp);
  assert.equal(sp.playlists.get("pl3").items.length, 62, "hand-added song replaced by the sorted list");
  assert.equal(sp.playlists.get("pl1").items[0], "spotify:track:t900");
});

test("a clean write is checked with one count request; a troubled one is read back in full", async () => {
  const sp = new FakeSpotify(library(400));
  await run(sp);
  assert.ok(!sp.log.some((l) => /^GET \/playlists\/\w+\/items/.test(l)), "clean writes don't read every song");
  const sp2 = new FakeSpotify(library(1200));
  sp2.failAfterApply = 1;
  await run(sp2);
  assert.ok(sp2.log.some((l) => /^GET \/playlists\/\w+\/items/.test(l)), "after a failure, songs are read back");
  assertNoDuplicates(sp2);
});

// ---- running more than once: the app's real sequence (group -> resolve -> plan -> sync)

async function appRun(sp, remembered, { byArtist, songPicks = {}, isPending, selected }) {
  const api = fakeClient(sp);
  const { tracks: liked } = await fetchLikedTracks(api);
  const { tracks } = dedupeTracks(liked);
  const nameFor = (b) => `Liked · ${b.name}`;
  const all = [...NODES, UNCATEGORIZED];
  const { targets } = await resolvePlaylists(api, ME, all, nameFor, remembered);
  // Like the app: subgenres that already have a playlist stay separate.
  const existing = new Set([...targets].filter(([, t]) => !t.isNew).map(([id]) => id));
  const groups = groupSongs(tracks, picksFor(tracks, byArtist, songPicks), NODES, { isPending, keepIds: existing });
  // Like the app: everything ticked except Uncategorized (and Not sorted yet can't be ticked).
  const pick = selected || new Set(groups.map((g) => g.bucket.id).filter((id) => ![NOT_SORTED_YET.id, UNCATEGORIZED.id].includes(id)));
  const plan = planSync(groups, targets, pick, NODES);
  return syncPlaylists(api, {
    userId: ME, groups: plan, nameFor, isPublic: false, remembered, verifyDelayMs: 0, knownBuckets: all,
    remember: (id, info) => { remembered[id] = { ...remembered[id], ...info }; },
  });
}

/** Every liked song is in at most one of the account's playlists, and no playlist repeats a song. */
function assertEachSongOnce(sp) {
  assertNoDuplicates(sp);
  const all = sp.followed.flatMap((id) => sp.playlists.get(id).items);
  assert.equal(new Set(all).size, all.length, "a song is in two playlists");
}

function swiftLibrary() {
  const liked = [];
  for (let i = 0; i < 12; i++) liked.push(track(i, `Swift ${i}`, "swift"));
  for (let i = 12; i < 20; i++) liked.push(track(i, `Bryan ${i}`, "bryan"));
  return { liked, artists: {} };
}

test("a song that changes genre on a later run is never left in two playlists, even if unticked", async () => {
  const sp = new FakeSpotify(swiftLibrary());
  const remembered = {};
  const byArtist = { swift: "country", bryan: "country" };
  await appRun(sp, remembered, { byArtist });
  assert.equal(sp.followed.length, 1, "day 1: everything is Country");

  // Day 2: a re-sort puts most of Swift's songs in Pop. The user only ticks Pop.
  const songPicks = Object.fromEntries([...Array(9).keys()].map((i) => [`spotify:track:t${i}`, "pop"]));
  await appRun(sp, remembered, { byArtist, songPicks, selected: new Set(["pop"]) });
  assertEachSongOnce(sp);
  const country = sp.playlists.get("pl1").items;
  assert.equal(country.length, 11, "Country was updated even though it wasn't ticked");
  assert.ok(!country.includes("spotify:track:t0"));
});

test("a genre whose songs all moved away is emptied, not left stale", async () => {
  const sp = new FakeSpotify(swiftLibrary());
  const remembered = {};
  await appRun(sp, remembered, { byArtist: { swift: "country", bryan: "pop" } });
  assert.equal(sp.followed.length, 2);
  await appRun(sp, remembered, { byArtist: { swift: "pop", bryan: "pop" } });
  assertEachSongOnce(sp);
  // Pop comes before Country in taxonomy.json, so pl1 is Pop and pl2 is Country.
  assert.equal(sp.playlists.get("pl2").items.length, 0, "Country is now empty");
  assert.equal(sp.playlists.get("pl1").items.length, 20);
});

test("a partial first day then a full second day uses the same playlists, every song once", async () => {
  const lib = library(400);
  const sp = new FakeSpotify(lib);
  const remembered = {};
  // Day 1: Groq ran out before "latin" and "indie" were sorted.
  await appRun(sp, remembered, { byArtist: lib.playlists, isPending: (t) => ["latin", "indie"].includes(t.artistIds[0]) });
  assert.equal(sp.followed.length, 1, "only Hip-Hop on day 1; Not sorted yet is never a playlist");
  await appRun(sp, remembered, { byArtist: lib.playlists });
  await appRun(sp, remembered, { byArtist: lib.playlists }); // and once more, for good measure
  assertEachSongOnce(sp);
  assert.equal(sp.creates, 3);
  assert.equal(sp.followed.reduce((n, id) => n + sp.playlists.get(id).items.length, 0), 300);
});

test("running twice in a row changes nothing the second time", async () => {
  const lib = library(400);
  const sp = new FakeSpotify(lib);
  const remembered = {};
  await appRun(sp, remembered, { byArtist: lib.playlists });
  const before = JSON.stringify([...sp.playlists.values()].map((p) => p.items));
  sp.log = [];
  const { results } = await appRun(sp, remembered, { byArtist: lib.playlists });
  assert.ok(results.every((r) => r.unchanged));
  assert.equal(JSON.stringify([...sp.playlists.values()].map((p) => p.items)), before);
  assert.equal(sp.creates, 3);
});

// ---- subgenres: own playlist only with enough songs, and no flip-flopping

function edmLibrary(deep, house) {
  const liked = [];
  let i = 0;
  for (let k = 0; k < deep; k++) liked.push(track(i++, `Deep ${k}`, "deepdj"));
  for (let k = 0; k < house; k++) liked.push(track(i++, `House ${k}`, "housedj"));
  return { liked, artists: {} };
}

test("a subgenre gets its own playlist from 15 songs; fewer roll up into the broad genre", () => {
  const tracks = edmLibrary(15, 14).liked.map((e) => ({ uri: e.track.uri, name: e.track.name, artistIds: [e.track.artists[0].id], artistNames: [] }));
  const groups = groupSongs(tracks, picksFor(tracks, { deepdj: "deep-house", housedj: "house" }), NODES);
  assert.deepEqual(groups.map((g) => [g.bucket.id, g.tracks.length]), [["electronic-dance", 14], ["deep-house", 15]]);
});

test("songs answered 'none', or given an id that isn't in the list, go to Uncategorized", () => {
  const tracks = ["a", "b", "c"].map((u) => ({ uri: u, name: u, artistIds: ["x"], artistNames: [] }));
  const groups = groupSongs(tracks, { a: "k-pop", b: "none", c: "made-up-genre" }, NODES);
  assert.deepEqual(groups.map((g) => [g.bucket.id, g.tracks.length]), [["k-pop", 1], ["uncategorized", 2]]);
});

test("K-Pop and J-Pop are separate playlists", () => {
  const tracks = ["a", "b"].map((u) => ({ uri: u, name: u, artistIds: ["x"], artistNames: [] }));
  const groups = groupSongs(tracks, { a: "k-pop", b: "j-pop" }, NODES);
  assert.deepEqual(groups.map((g) => g.bucket.id), ["k-pop", "j-pop"]);
});

test("a subgenre playlist that exists stays separate when it dips under 15 songs", async () => {
  const sp = new FakeSpotify(edmLibrary(16, 20));
  const remembered = {};
  const byArtist = { deepdj: "deep-house", housedj: "house" };
  await appRun(sp, remembered, { byArtist });
  const names = () => sp.followed.map((id) => `${sp.playlists.get(id).name}:${sp.playlists.get(id).items.length}`).sort();
  assert.deepEqual(names(), ["Liked · Deep House:16", "Liked · House:20"]);
  // Two Deep House songs get re-sorted as House: Deep House now has 14, under the threshold.
  const songPicks = { "spotify:track:t0": "house", "spotify:track:t1": "house" };
  await appRun(sp, remembered, { byArtist, songPicks });
  await appRun(sp, {}, { byArtist, songPicks }); // and from another browser
  assert.deepEqual(names(), ["Liked · Deep House:14", "Liked · House:22"], "no flip into Electronic & Dance");
  assertEachSongOnce(sp);
});

test("playlists for genres no longer in the list are emptied and reported, never left with songs", async () => {
  const sp = new FakeSpotify(edmLibrary(3, 0));
  sp.addPlaylist({ id: "old", name: "Liked · K-Pop & J-Pop", description: "Your K-Pop & J-Pop songs. [gs:k-pop-j-pop]",
    items: ["spotify:track:t0", "spotify:track:t1"] });
  const remembered = {};
  const { retired } = await appRun(sp, remembered, { byArtist: { deepdj: "k-pop" } });
  assert.deepEqual(retired.map((r) => r.playlistId), ["old"]);
  assert.equal(sp.playlists.get("old").items.length, 0, "emptied");
  assert.match(sp.playlists.get("old").description, /Safe to delete/);
  assertEachSongOnce(sp);
  sp.log = [];
  await appRun(sp, remembered, { byArtist: { deepdj: "k-pop" } });
  assert.ok(!sp.log.some((l) => l === "PUT /playlists/old/items"), "an already-empty retired playlist isn't rewritten");
});

test("syncing without the full playlist list never empties other playlists", async () => {
  const sp = new FakeSpotify(library());
  await run(sp, {});
  const before = sp.followed.map((id) => sp.playlists.get(id).items.length);
  // A sync of just one genre, without knownBuckets: the other two must be left alone.
  const api = fakeClient(sp);
  const { tracks } = dedupeTracks((await fetchLikedTracks(api)).tracks);
  const latin = groupSongs(tracks, picksFor(tracks, LIB_PICKS), NODES).filter((g) => g.bucket.id === "latin");
  const { retired } = await syncPlaylists(api, { userId: ME, groups: latin, nameFor: (b) => `Liked · ${b.name}`, isPublic: false,
    remembered: {}, remember: () => {}, verifyDelayMs: 0 });
  assert.deepEqual(retired, []);
  assert.deepEqual(sp.followed.map((id) => sp.playlists.get(id).items.length), before);
});

