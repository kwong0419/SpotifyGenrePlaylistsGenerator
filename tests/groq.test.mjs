// Run with: npm test
// Groq tagging against a fake Groq: batching, caching, and every guardrail that keeps us
// under the free limits (per minute, per day, bad replies, bad keys).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createGroq, chooseModel, tagArtists, tagSongs, GroqError, GroqDailyLimitError, MODEL_LIMITS,
} from "../docs/groq.js";
import { groupTracks } from "../docs/core.js";
import { FakeGroq } from "./fake-groq.mjs";

const BUCKETS = JSON.parse(readFileSync(new URL("../docs/genres.json", import.meta.url))).buckets;

/** A fake clock that only moves when the code under test sleeps. */
function clock(start = Date.UTC(2026, 9, 1, 12)) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

function setup({ groq = new FakeGroq(), limits, ledgerEntries = [], model = "llama-3.3-70b-versatile" } = {}) {
  const c = clock();
  let saved = ledgerEntries;
  const ledger = { load: () => saved, save: (e) => { saved = e; } };
  const waits = [];
  const client = createGroq({
    apiKey: "k", model, fetchImpl: groq.fetch, sleepImpl: c.sleep, now: c.now, ledger, limits,
    onWait: (ms) => waits.push(ms),
  });
  return { client, groq, clock: c, ledger, waits, entries: () => saved };
}

function manyArtists(n) {
  const artists = {};
  const list = [];
  for (let i = 0; i < n; i++) {
    const name = `Artist ${i}`;
    artists[name] = { tags: [i % 2 ? "chicago drill" : "bedroom pop"] };
    list.push({ id: `a${i}`, name, titles: [`Song ${i}`], songCount: n - i });
  }
  return { artists, list };
}

test("artists are tagged in batches, saved, and never sent twice", async () => {
  const { artists, list } = manyArtists(200);
  const { client, groq } = setup({ groq: new FakeGroq({ artists }) });
  const cache = {};
  await tagArtists(client, list, cache, { batchSize: 80 });
  assert.equal(Object.keys(cache).length, 200);
  assert.deepEqual(groq.calls, [80, 80, 40]);
  assert.deepEqual(cache.a1.tags, ["chicago drill"]);
  await tagArtists(client, list, cache);
  assert.equal(groq.requests, 3, "a second run sends nothing");
});

test("unknown artists get no tags instead of a guess", async () => {
  const { client } = setup({ groq: new FakeGroq({ artists: { Known: { tags: ["reggaeton"] } } }) });
  const cache = {};
  await tagArtists(client, [
    { id: "k", name: "Known", titles: [], songCount: 1 },
    { id: "u", name: "Totally Unknown Band", titles: [], songCount: 1 },
  ], cache);
  assert.deepEqual(cache.u, { tags: [], mixed: false });
});

test("artists who mix genres get their songs tagged one by one, and songs win", async () => {
  const groq = new FakeGroq({
    artists: { Post: { tags: ["melodic rap", "pop rap"], mixed: true } },
    songs: { "Rock Song": ["alternative rock"] },
  });
  const { client } = setup({ groq });
  const artistTags = {};
  await tagArtists(client, [{ id: "post", name: "Post", titles: ["Rap Song", "Rock Song"], songCount: 2 }], artistTags);
  assert.equal(artistTags.post.mixed, true);
  const songTags = {};
  await tagSongs(client, [
    { uri: "s1", title: "Rap Song", artist: "Post" },
    { uri: "s2", title: "Rock Song", artist: "Post" },
  ], songTags);
  const tracks = [
    { uri: "s1", name: "Rap Song", artistIds: ["post"], artistNames: ["Post"] },
    { uri: "s2", name: "Rock Song", artistIds: ["post"], artistNames: ["Post"] },
  ];
  const groups = groupTracks(tracks, { post: artistTags.post.tags }, BUCKETS, {
    songGenres: Object.fromEntries(Object.entries(songTags).map(([k, v]) => [k, v.tags])),
  });
  const where = Object.fromEntries(groups.flatMap((g) => g.tracks.map((t) => [t.uri, g.bucket.id])));
  assert.deepEqual(where, { s1: "hip-hop-rap", s2: "indie-alternative" }, "unknown song falls back to the artist");
});

test("requests are paced to stay under 80% of the per-minute token limit", async () => {
  const { artists, list } = manyArtists(600);
  const { client, entries } = setup({ groq: new FakeGroq({ artists }) });
  await tagArtists(client, list, {});
  const used = entries().filter((e) => e.t);
  const cap = MODEL_LIMITS["llama-3.3-70b-versatile"].tpm * 0.8;
  for (const e of used) {
    const inWindow = used.filter((x) => x.t > e.t - 60_000 && x.t <= e.t).reduce((n, x) => n + x.tokens, 0);
    assert.ok(inWindow <= cap, `${inWindow} tokens in one minute, cap ${cap}`);
  }
});

test("a per-minute 429 is waited out; repeated ones stop cleanly", async () => {
  const { artists, list } = manyArtists(10);
  const s = setup({ groq: new FakeGroq({ artists }) });
  s.groq.minuteLimitNext = 2;
  const cache = {};
  await tagArtists(s.client, list, cache);
  assert.equal(Object.keys(cache).length, 10);
  assert.deepEqual(s.waits, [3500, 3500]);
  s.groq.minuteLimitNext = 10;
  const err = await tagArtists(s.client, [{ id: "x", name: "Artist 1", titles: [], songCount: 1 }], cache).catch((e) => e);
  assert.ok(err instanceof GroqError && err.kind === "busy");
});

test("Groq's per-day 429 stops with a resume time, keeps progress, and blocks further sends", async () => {
  const { artists, list } = manyArtists(300);
  const s = setup({ groq: new FakeGroq({ artists }) });
  s.groq.dailyLimit = 2000;
  const cache = {};
  const err = await tagArtists(s.client, list, cache).catch((e) => e);
  assert.ok(err instanceof GroqDailyLimitError, String(err));
  assert.ok(err.resumeAt - s.clock.now() >= 7 * 3600_000, "resume time comes from Groq's message");
  const sorted = Object.keys(cache).length;
  assert.ok(sorted > 0 && sorted < 300, `kept partial progress: ${sorted}`);
  assert.ok(cache.a0, "artists with the most songs go first");
  const before = s.groq.requests;
  await assert.rejects(tagArtists(s.client, list, cache), GroqDailyLimitError);
  assert.equal(s.groq.requests, before, "nothing is sent while blocked");
});

test("our own daily budget stops before Groq has to refuse, and frees up after 24 hours", async () => {
  const { artists, list } = manyArtists(50);
  const s = setup({
    groq: new FakeGroq({ artists }),
    ledgerEntries: [{ t: Date.UTC(2026, 9, 1, 2), tokens: 89_500 }], // used earlier today
  });
  const err = await tagArtists(s.client, list, {}).catch((e) => e);
  assert.ok(err instanceof GroqDailyLimitError);
  assert.equal(s.groq.requests, 0, "nothing sent past 90% of the daily allowance");
  assert.equal(err.resumeAt, Date.UTC(2026, 9, 2, 2) + 1000);
  s.clock.advance(15 * 3600_000); // the morning's usage drops out of the rolling day
  const cache = {};
  await tagArtists(s.client, list, cache);
  assert.equal(Object.keys(cache).length, 50);
});

test("broken or partial replies are retried in smaller pieces", async () => {
  const { artists, list } = manyArtists(40);
  const s = setup({ groq: new FakeGroq({ artists }) });
  s.groq.garbleNext = 1;
  s.groq.dropEvery = 0;
  const cache = {};
  await tagArtists(s.client, list, cache);
  assert.equal(Object.keys(cache).length, 40);
  assert.ok(Object.values(cache).every((v) => v.tags.length), "all recovered after the split");

  const s2 = setup({ groq: new FakeGroq({ artists }) });
  s2.groq.dropEvery = 5; // the model skips some artists
  const cache2 = {};
  await tagArtists(s2.client, list.slice(0, 10), cache2);
  assert.equal(Object.keys(cache2).length, 10);
});

test("a batch too big for a minute's allowance is split rather than stuck", async () => {
  const { artists, list } = manyArtists(120);
  const s = setup({ groq: new FakeGroq({ artists }), limits: { rpm: 30, tpm: 2000, rpd: 1000, tpd: 100000 } });
  const cache = {};
  await tagArtists(s.client, list, cache, { batchSize: 120 });
  assert.equal(Object.keys(cache).length, 120);
  assert.ok(Math.max(...s.groq.calls) < 120);
});

test("a bad key or missing model is reported clearly", async () => {
  const groq = new FakeGroq();
  groq.key = "right";
  const s = setup({ groq });
  const err = await s.client.listModels().catch((e) => e);
  assert.ok(err instanceof GroqError && err.kind === "auth");
  const s2 = setup({ groq: new FakeGroq({ models: ["other"] }) });
  const err2 = await tagArtists(s2.client, [{ id: "a", name: "A", titles: [], songCount: 1 }], {}).catch((e) => e);
  assert.ok(err2 instanceof GroqError && err2.kind === "model");
  assert.equal(chooseModel(["whisper-large-v3", "llama-3.1-8b-instant"]), "llama-3.1-8b-instant");
  assert.equal(chooseModel(["whisper-large-v3", "some-new-model"]), "some-new-model");
});

test("a full batch of realistic three-tag replies fits in the reply room", async () => {
  const artists = {};
  const list = [];
  for (let i = 0; i < 120; i++) {
    artists[`Artist Number ${i}`] = { tags: ["conscious hip hop", "west coast rap", "alternative r&b"], mixed: i % 7 === 0 };
    list.push({ id: `a${i}`, name: `Artist Number ${i}`, titles: ["A Fairly Long Song Title Here", "Another One"], songCount: 1 });
  }
  const { client, groq } = setup({ groq: new FakeGroq({ artists }) });
  const cache = {};
  await tagArtists(client, list, cache);
  assert.equal(groq.cutOffs || 0, 0, "no reply was cut off");
  assert.equal(Object.values(cache).filter((v) => v.tags.length === 3).length, 120);
});

test("Groq refusing a reply as invalid JSON is retried smaller, never fatal", async () => {
  const { artists, list } = manyArtists(60);
  const s = setup({ groq: new FakeGroq({ artists }) });
  s.groq.jsonFailNext = 2;
  const cache = {};
  await tagArtists(s.client, list, cache);
  assert.equal(Object.keys(cache).length, 60);
  assert.ok(Object.values(cache).every((v) => v.tags.length), "everything recovered");
});

test("one artist the model always chokes on becomes unknown; the rest are sorted", async () => {
  const { artists, list } = manyArtists(60);
  const s = setup({ groq: new FakeGroq({ artists }) });
  s.groq.poison = "Artist 17";
  const cache = {};
  await tagArtists(s.client, list, cache);
  assert.deepEqual(cache.a17, { tags: [], mixed: false });
  assert.ok(Object.keys(cache).length === 60);
  assert.equal(Object.values(cache).filter((v) => v.tags.length).length, 59);
});

test("a reply cut off at the length limit keeps its complete lines and asks only for the rest", async () => {
  const artists = {};
  const list = [];
  for (let i = 0; i < 40; i++) {
    // Long tags: each answer line is bigger than the room allowed per artist.
    artists[`Band ${i}`] = { tags: ["progressive melodic metalcore revival", "atmospheric post-hardcore emo", "experimental mathcore ambient"] };
    list.push({ id: `b${i}`, name: `Band ${i}`, titles: [], songCount: 1 });
  }
  const groq = new FakeGroq({ artists });
  const s = setup({ groq });
  const cache = {};
  await tagArtists(s.client, list, cache, { batchSize: 40 });
  assert.ok(groq.cutOffs > 0, "replies really were cut off");
  assert.equal(Object.keys(cache).length, 40);
  assert.ok(Object.values(cache).every((v) => v.tags.length === 3 && v.tags.every((t) => artists["Band 0"].tags.includes(t))),
    "no half-written tags saved");
});

test("chatter around the answers is ignored", async () => {
  const { artists, list } = manyArtists(20);
  const groq = new FakeGroq({ artists });
  groq.preamble = "Sure! Here are the Spotify-style genres:\n\n";
  const s = setup({ groq });
  const cache = {};
  await tagArtists(s.client, list, cache);
  assert.equal(Object.values(cache).filter((v) => v.tags.length).length, 20);
  assert.equal(groq.requests, 1);
});
