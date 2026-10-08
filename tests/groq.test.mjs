// Run with: npm test
// Sorting songs with a fake Groq: batching, caching, strict structured replies and the line
// fallback, and every guardrail that keeps us under the free limits.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createGroq, chooseModel, clearUsageEstimates, classifySongs, estimateSongJob, answerReader,
  GroqError, GroqDailyLimitError, MODEL_LIMITS,
} from "../docs/groq.js";
import { flattenTaxonomy } from "../docs/core.js";
import { FakeGroq } from "./fake-groq.mjs";

const NODES = flattenTaxonomy(JSON.parse(readFileSync(new URL("../docs/taxonomy.json", import.meta.url))).genres);

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

const STYLES = ["deep-house", "trap", "k-pop", "j-pop", "modern-country", "indie-rock", "techno", "reggaeton"];

/** n songs by n/3 artists; the fake model knows every song except every 13th artist's. */
function library(n) {
  const artists = {};
  const songs = [];
  for (let i = 0; i < n; i++) {
    const artist = `Artist ${Math.floor(i / 3)}`;
    if (Math.floor(i / 3) % 13 !== 5) artists[artist] = STYLES[Math.floor(i / 3) % STYLES.length];
    songs.push({ uri: `s${i}`, title: `Song ${i}`, artist, featured: [] });
  }
  return { artists, songs };
}

/** Every saved answer is that song's own (never shifted onto another song). */
function assertNoWrongAnswers(cache, artists, songs) {
  for (const s of songs) {
    if (!(s.uri in cache)) continue;
    assert.equal(cache[s.uri].playlist, artists[s.artist] ?? "none", `${s.title} got someone else's playlist`);
  }
}

/** uri -> playlist, without the confidence. */
const plain = (cache) => Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, v.playlist]));
const batchOf = (...titles) => titles.map((title) => ({ title }));

// ---- basics

test("songs are sorted in batches, saved, and never sent twice", async () => {
  const { artists, songs } = library(200);
  const { client, groq } = setup({ groq: new FakeGroq({ artists }) });
  const cache = {};
  await classifySongs(client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 200);
  assert.deepEqual(groq.calls, [60, 60, 60, 20]);
  assertNoWrongAnswers(cache, artists, songs);
  await classifySongs(client, songs, NODES, cache);
  assert.equal(groq.requests, 4, "a second run sends nothing");
});

test("a song the model doesn't know is saved as 'none'", async () => {
  const { client } = setup({ groq: new FakeGroq({ artists: { Known: "k-pop" } }) });
  const cache = {};
  await classifySongs(client, [
    { uri: "a", title: "Hit", artist: "Known", featured: [] },
    { uri: "b", title: "Demo", artist: "Totally Unknown Band", featured: [] },
  ], NODES, cache);
  assert.deepEqual(plain(cache), { a: "k-pop", b: "none" });
});

test("each song is judged on its own: one artist's songs can land in different playlists", async () => {
  const groq = new FakeGroq({ artists: { Drake: "melodic-rap" }, songs: { "Passionfruit by Drake": "contemporary-rnb", "Jungle by Drake": "deep-house" } });
  const { client } = setup({ groq });
  const cache = {};
  await classifySongs(client, ["God's Plan", "Passionfruit", "Jungle"].map((t, i) => ({ uri: `d${i}`, title: t, artist: "Drake", featured: [] })), NODES, cache);
  assert.deepEqual(plain(cache), { d0: "melodic-rap", d1: "contemporary-rnb", d2: "deep-house" });
});

test("featured artists and listener tags are passed on to the model", async () => {
  const groq = new FakeGroq();
  groq.fromTags = (tags) => (tags.includes("amapiano") ? "amapiano" : "none");
  const { client } = setup({ groq });
  const cache = {};
  await classifySongs(client, [{ uri: "x", title: "Yahyuppiyah", artist: "Uncle Waffles", featured: ["Tony Duardo"], context: ["amapiano", "south african house"] }], NODES, cache);
  assert.equal(cache.x.playlist, "amapiano");
  assert.match(groq.seen[0], /feat\. Tony Duardo; listener tags for the artist: amapiano, south african house/);
});

// ---- strict structured replies (gpt-oss), and the line format as a fallback

test("with a strict-mode model every request is structured, and answers can only be real playlists", async () => {
  const { artists, songs } = library(300);
  artists["Artist 1"] = "bollywood-bangers"; // not in the list: strict mode can't return it
  const groq = new FakeGroq({ artists });
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 300);
  assert.equal(groq.structuredRequests, groq.requests);
  const ids = new Set([...NODES.map((n) => n.id), "none"]);
  assert.ok(Object.values(cache).every((v) => ids.has(v.playlist)), "every answer is a real playlist or none");
});

test("a structured reply cut off at the length limit keeps every complete answer", async () => {
  const { artists, songs } = library(90);
  const groq = new FakeGroq({ artists });
  const real = groq.fetch;
  groq.fetch = async (url, opts) => { // give the model far too little room, once
    if (!groq.squeezed && opts.body) {
      groq.squeezed = true;
      opts = { ...opts, body: JSON.stringify({ ...JSON.parse(opts.body), max_tokens: 700 }) };
    }
    return real(url, opts);
  };
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, songs, NODES, cache);
  assert.ok(groq.cutOffs > 0, "the reply really was cut off");
  assert.equal(Object.keys(cache).length, 90);
  assertNoWrongAnswers(cache, artists, songs);
});

test("if Groq turns strict mode down, the line format takes over and the run finishes", async () => {
  const { artists, songs } = library(120);
  const groq = new FakeGroq({ artists });
  groq.noSchema = true;
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 120);
  assertNoWrongAnswers(cache, artists, songs);
});

test("line format: a made-up playlist is never saved", async () => {
  const groq = new FakeGroq({ artists: { A: "k-pop" } });
  const { client } = setup({ groq });
  const cache = {};
  await classifySongs(client, [{ uri: "a", title: "One", artist: "A", featured: [] }], NODES, cache);
  groq.invent = "bollywood bangers";
  await classifySongs(client, [{ uri: "b", title: "Two", artist: "A", featured: [] }], NODES, cache).catch(() => {});
  assert.deepEqual(plain(cache), { a: "k-pop" }, "only the real answer was kept; the other is asked again next run");
});

test("line format: a playlist named instead of its id, and chatter around the answers, are understood", () => {
  const read = answerReader(NODES);
  const reply = "Sure! Here you go:\n1: Deep House\n2: k-pop\n3. \"Trap\"\n4: none\n5: drum-and-bass.";
  assert.deepEqual([...read.lines(reply, batchOf("a", "b", "c", "d", "e"))].map(([n, v]) => [n, v.playlist]),
    [["1", "deep-house"], ["2", "k-pop"], ["3", "trap"], ["4", "none"], ["5", "drum-and-bass"]]);
});

test("line format: answers without numbers are never matched by guesswork", async () => {
  const { artists, songs } = library(60);
  const groq = new FakeGroq({ artists });
  groq.unnumbered = true;
  const { client } = setup({ groq });
  const cache = {};
  const err = await classifySongs(client, songs, NODES, cache).catch((e) => e);
  assert.ok(err instanceof GroqError && err.kind === "format", String(err));
  assert.deepEqual(cache, {}, "nothing saved");
  assert.ok(groq.requests <= 3, `stopped after ${groq.requests} requests`);
});

test("the strict reply format parses, whole or cut off part-way, and checks each answer's song", () => {
  const read = answerReader(NODES);
  const batch = batchOf("Lucid Dreams", "SICKO MODE", "Unknown Demo");
  const reply = JSON.stringify({ results: [
    { n: 1, w: "Lucid Dreams", p: "melodic-rap", c: "h" }, { n: 2, w: "sicko mode", p: "trap", c: "m" }, { n: 3, w: "Unknown Demo", p: "none", c: "l" },
  ] }, null, 2);
  assert.deepEqual([...read.json(reply, batch)], [
    ["1", { playlist: "melodic-rap", confidence: "high" }], ["2", { playlist: "trap", confidence: "medium" }],
    ["3", { playlist: "none", confidence: "low" }],
  ]);
  const cut = reply.slice(0, reply.indexOf('"none"'));
  assert.deepEqual([...read.json(cut, batch)].map(([n]) => n), ["1", "2"], "the half-written answer is skipped");
  const wrongSong = JSON.stringify({ results: [{ n: 1, w: "SICKO MODE", p: "trap", c: "h" }, { n: 9, w: "x", p: "trap", c: "h" }] });
  assert.deepEqual([...read.json(wrongSong, batch)], [], "an answer naming another song's title, or a number out of range, is dropped");
  const sameStart = batchOf("The Bells", "The Thrill Is Gone");
  const swapped = JSON.stringify({ results: [{ n: 1, w: "The Thrill", p: "blues", c: "h" }, { n: 2, w: "The Thrill", p: "blues", c: "h" }] });
  assert.deepEqual([...read.json(swapped, sameStart)].map(([n]) => n), ["2"], "two words tell apart songs that both start with 'The'");
});

// ---- the free limits

test("requests are paced to stay under 80% of the per-minute token limit", async () => {
  const { artists, songs } = library(900);
  const { client, entries } = setup({ groq: new FakeGroq({ artists }) });
  await classifySongs(client, songs, NODES, {});
  const used = entries().filter((e) => e.t);
  const cap = MODEL_LIMITS["llama-3.3-70b-versatile"].tpm * 0.8;
  for (const e of used) {
    const inWindow = used.filter((x) => x.t > e.t - 60_000 && x.t <= e.t).reduce((n, x) => n + x.tokens, 0);
    assert.ok(inWindow <= cap, `${inWindow} tokens in one minute, cap ${cap}`);
  }
});

test("a per-minute 429 is waited out; repeated ones stop cleanly", async () => {
  const { artists, songs } = library(30);
  const s = setup({ groq: new FakeGroq({ artists }) });
  s.groq.minuteLimitNext = 2;
  const cache = {};
  await classifySongs(s.client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 30);
  assert.deepEqual(s.waits, [3500, 3500]);
  s.groq.minuteLimitNext = 10;
  const err = await classifySongs(s.client, [{ uri: "x", title: "X", artist: "Artist 1", featured: [] }], NODES, cache).catch((e) => e);
  assert.ok(err instanceof GroqError && err.kind === "busy");
});

test("Groq's per-day 429 stops with a resume time, keeps progress, and blocks further sends", async () => {
  const { artists, songs } = library(900);
  const s = setup({ groq: new FakeGroq({ artists }) });
  s.groq.dailyLimit = 6000;
  const cache = {};
  const err = await classifySongs(s.client, songs, NODES, cache).catch((e) => e);
  assert.ok(err instanceof GroqDailyLimitError, String(err));
  assert.equal(err.source, "groq");
  assert.ok(err.resumeAt - s.clock.now() >= 7 * 3600_000, "resume time comes from Groq's message");
  const sorted = Object.keys(cache).length;
  assert.ok(sorted > 0 && sorted < 900, `kept partial progress: ${sorted}`);
  assert.ok(cache.s0, "songs are sorted in the order given (newest liked first)");
  const before = s.groq.requests;
  await assert.rejects(classifySongs(s.client, songs, NODES, cache), GroqDailyLimitError);
  assert.equal(s.groq.requests, before, "nothing is sent while blocked");
});

test("our own daily budget stops before Groq has to refuse, and frees up after 24 hours", async () => {
  const { artists, songs } = library(50);
  const s = setup({ groq: new FakeGroq({ artists }), ledgerEntries: [{ t: Date.UTC(2026, 9, 1, 2), tokens: 88_000 }] });
  const err = await classifySongs(s.client, songs, NODES, {}).catch((e) => e);
  assert.ok(err instanceof GroqDailyLimitError);
  assert.equal(err.source, "estimate");
  assert.equal(s.groq.requests, 0, "nothing sent past 90% of the daily allowance");
  s.clock.advance(15 * 3600_000); // the morning's usage drops out of the rolling day
  const cache = {};
  await classifySongs(s.client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 50);
});

test("'check with Groq' clears our own count but never a limit Groq itself gave", async () => {
  const { artists, songs } = library(30);
  const s = setup({ groq: new FakeGroq({ artists }), ledgerEntries: [{ t: Date.UTC(2026, 9, 1, 2), tokens: 89_900 }] });
  assert.equal((await classifySongs(s.client, songs, NODES, {}).catch((e) => e)).source, "estimate");
  clearUsageEstimates(s.ledger);
  const cache = {};
  await classifySongs(s.client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 30, "Groq still had allowance");

  const t = setup({ groq: new FakeGroq({ artists }) });
  t.groq.dailyLimit = 100;
  assert.equal((await classifySongs(t.client, songs, NODES, {}).catch((e) => e)).source, "groq");
  clearUsageEstimates(t.ledger);
  await assert.rejects(classifySongs(t.client, songs, NODES, {}), GroqDailyLimitError);
  assert.equal(t.groq.requests, 0, "nothing sent while Groq's own block lasts");
});

test("estimates: the real library size takes about four days on one model; nothing starts when no request fits today", () => {
  const big = Array.from({ length: 6846 }, (_, i) => ({ uri: `u${i}`, title: "A Typical Song Title", artist: "Some Artist Name", featured: [] }));
  const fresh = { model: "openai/gpt-oss-120b", budget: () => ({ tpm: 6400, tpd: 180_000, dayLeft: 180_000 }) };
  const e = estimateSongJob(fresh, big, NODES);
  assert.equal(e.days, 4, "measured cost per song, including the careful second look");
  assert.ok(e.startsToday && e.todayShare > 0.25);
  const spent = { ...fresh, budget: () => ({ tpm: 6400, tpd: 180_000, dayLeft: 500 }) };
  assert.equal(estimateSongJob(spent, big, NODES).startsToday, false);
});

// ---- bad replies

test("broken or partial replies are retried in smaller pieces", async () => {
  const { artists, songs } = library(40);
  const s = setup({ groq: new FakeGroq({ artists }) });
  const cache = {};
  await classifySongs(s.client, songs.slice(0, 3), NODES, cache); // the format works
  s.groq.garbleNext = 1;
  await classifySongs(s.client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 40);
  assertNoWrongAnswers(cache, artists, songs);

  const t = setup({ groq: new FakeGroq({ artists }) });
  t.groq.dropEvery = 5; // the model skips some songs
  const c2 = {};
  await classifySongs(t.client, songs, NODES, c2);
  assert.equal(Object.keys(c2).length, 40);
});

test("Groq refusing a reply as invalid JSON is retried smaller, never fatal", async () => {
  const { artists, songs } = library(60);
  const s = setup({ groq: new FakeGroq({ artists }) });
  s.groq.jsonFailNext = 2;
  const cache = {};
  await classifySongs(s.client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 60);
});

test("songs the model never answers are left for the next run, not saved as 'none'", async () => {
  const { artists, songs } = library(30);
  const groq = new FakeGroq({ artists });
  groq.skip = new Set(["Song 4", "Song 9"]);
  const s = setup({ groq });
  const cache = {};
  await classifySongs(s.client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 28);
  assert.ok(!("s4" in cache) && !("s9" in cache));
});

test("one song the model always chokes on is isolated cheaply; the rest are sorted", async () => {
  const { artists, songs } = library(90);
  const s = setup({ groq: new FakeGroq({ artists }), model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(s.client, songs.slice(0, 5), NODES, cache);
  s.groq.poison = "Song 41";
  await classifySongs(s.client, songs, NODES, cache);
  assert.ok(!("s41" in cache));
  assert.equal(Object.keys(cache).length, 89);
  assert.ok(s.groq.requests < 25, `narrowed down cheaply: ${s.groq.requests} requests`);
});

test("a batch too big for a minute's allowance is split rather than stuck", async () => {
  const { artists, songs } = library(120);
  const s = setup({ groq: new FakeGroq({ artists }), limits: { rpm: 30, tpm: 3500, rpd: 1000, tpd: 100000 } });
  const cache = {};
  await classifySongs(s.client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 120);
  assert.ok(Math.max(...s.groq.calls) < 90);
});

test("reasoning models (gpt-oss) are asked to think briefly and given room, so answers aren't empty", async () => {
  const { artists, songs } = library(270);
  const groq = new FakeGroq({ artists });
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 270);
  assert.equal(groq.cutOffs || 0, 0, "no answer squeezed out by thinking");
});

test("a bad key or missing model is reported clearly, and the key's real model list picks gpt-oss-120b", async () => {
  const groq = new FakeGroq();
  groq.key = "right";
  const err = await setup({ groq }).client.listModels().catch((e) => e);
  assert.ok(err instanceof GroqError && err.kind === "auth");
  const s2 = setup({ groq: new FakeGroq({ models: ["other"] }) });
  const err2 = await classifySongs(s2.client, [{ uri: "a", title: "A", artist: "B", featured: [] }], NODES, {}).catch((e) => e);
  assert.ok(err2 instanceof GroqError && err2.kind === "model");
  const live = ["whisper-large-v3", "openai/gpt-oss-120b", "openai/gpt-oss-safeguard-20b", "allam-2-7b", "qwen/qwen3.8-27b",
    "canopylabs/orpheus-arabic-saudi", "meta-llama/llama-prompt-guard-2-86m", "openai/gpt-oss-20b"];
  assert.equal(chooseModel(live), "openai/gpt-oss-120b");
});

// ---- confidence, the careful second look, and answers meant for another song

test("answers the model meant for a neighbouring song are caught and asked again", async () => {
  const { artists, songs } = library(40);
  const groq = new FakeGroq({ artists });
  groq.shiftFrom = 20; // loses its place halfway through the first batch
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 40, "every song ends up answered");
  assertNoWrongAnswers(cache, artists, songs);
});

test("the live case: a guess from weak clues gets a careful second look with real catalog data", async () => {
  const groq = new FakeGroq({ artists: { Logic: "conscious-rap" } });
  groq.guesses = { "ICARUS by Tony Ann": "k-pop" };
  groq.fromSongTags = () => "none";
  groq.careful = {}; // the careful look only places it with the store genre:
  const realFetch = groq.fetch;
  groq.fetch = async (url, opts) => {
    if (opts.body && JSON.parse(opts.body).messages[1].content.includes("Apple Music genre: Classical Crossover")) {
      groq.careful["ICARUS by Tony Ann"] = "classical";
    }
    return realFetch(url, opts);
  };
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const looked = [];
  const cache = {};
  await classifySongs(client, [
    { uri: "i", title: "ICARUS", artist: "Tony Ann", featured: [] },
    { uri: "l", title: "A Man Free", artist: "Logic", featured: [] },
  ], NODES, cache, { moreContext: async (s) => { looked.push(s.title); return { storeGenre: "Classical Crossover" }; } });
  assert.deepEqual(looked, ["ICARUS"], "only the unsure song is looked up");
  assert.equal(groq.carefulRequests, 1, "one careful request, with more thinking");
  assert.deepEqual(cache.i, { playlist: "classical", confidence: "high", model: "openai/gpt-oss-120b" });
  assert.deepEqual(cache.l, { playlist: "conscious-rap", confidence: "medium", model: "openai/gpt-oss-120b" });
});

test("a song still unsure after the second look goes to Uncategorized, not a guessed playlist", async () => {
  const groq = new FakeGroq();
  groq.guesses = { "Silvershoes by Liana Flores": "latin-pop" };
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, [{ uri: "s", title: "Silvershoes", artist: "Liana Flores", featured: [] }], NODES, cache);
  assert.deepEqual(cache.s, { playlist: "none", confidence: "low", model: "openai/gpt-oss-120b" });
});

test("the listener's corrections are shown as examples, with the rule against judging by names", async () => {
  const groq = new FakeGroq({ artists: { A: "pop" } });
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  await classifySongs(client, [{ uri: "a", title: "One", artist: "A", featured: [] }], NODES, {}, {
    examples: [{ title: "Passionfruit", artist: "Drake", playlist: "contemporary-rnb" }],
  });
  const prompt = groq.systemPrompts[0];
  assert.match(prompt, /placed these songs themselves[\s\S]*"Passionfruit" by Drake -> contemporary-rnb/);
  assert.match(prompt, /all-caps title is not a sign of K-Pop/);
  assert.match(prompt, /Spanish or Korean surname is not a sign/);
});

test("store genres and song tags reach the model as evidence", async () => {
  const groq = new FakeGroq();
  const { client } = setup({ groq });
  await classifySongs(client, [{ uri: "x", title: "Icarus", artist: "Tony Ann", featured: [], storeGenre: "Classical Crossover", songTags: ["piano", "instrumental"] }], NODES, {});
  assert.match(groq.seen[0], /listener tags for this song: piano, instrumental; Apple Music genre: Classical Crossover/);
});

// ---- fewer wasted requests

test("titles with apostrophes, dots, '&' or a leading bracket are matched; real mismatches still aren't", () => {
  const read = answerReader(NODES);
  const one = (title, w) => read.json(JSON.stringify({ results: [{ n: 1, w, p: "pop", c: "h" }] }), batchOf(title, "Other Song")).size === 1;
  for (const [title, w] of [["Don't Start Now", "Dont Start"], ["Ain't No Mountain High Enough", "Aint No"], ["P.Y.T. (Pretty Young Thing)", "PYT Pretty"],
    ["Rock & Roll", "Rock and"], ["Rock & Roll", "Rock Roll"], ["(I Can't Get No) Satisfaction", "Satisfaction"], ["Él Me Mintió", "El Me"], ["7/11", "7 11"]]) {
    assert.ok(one(title, w), `${title} <- ${w}`);
  }
  for (const [title, w] of [["The Bells", "The Thrill"], ["Song 12", "Song 13"], ["Love Story", "Love Me"]]) {
    assert.ok(!one(title, w), `${title} <- ${w} should be rejected`);
  }
  // Just "The": fine when it's the only song in the batch starting that way, not otherwise.
  const pick = (w, ...titles) => read.json(JSON.stringify({ results: [{ n: 1, w, p: "pop", c: "h" }] }), batchOf(...titles)).size === 1;
  assert.ok(pick("The", "The Bells", "Other Song"));
  assert.ok(!pick("The", "The Bells", "The Night We Met"));
  assert.ok(!pick("Love", "The Bells", "Other Song"));
});

test("a library full of punctuated titles is sorted without wasted re-asks", async () => {
  const titles = ["Don't Start Now", "Ain't No Sunshine", "P.Y.T. (Pretty Young Thing)", "Rock & Roll", "Mr. Brightside", "(I Can't Get No) Satisfaction"];
  const songs = Array.from({ length: 60 }, (_, i) => ({ uri: `p${i}`, title: `${titles[i % titles.length]}`, artist: `Band ${i}`, featured: [] }));
  const artists = Object.fromEntries(songs.map((x) => [x.artist, "classic-rock"]));
  const groq = new FakeGroq({ artists });
  // Like gpt-oss: echoes titles without their punctuation.
  groq.echo = (title) => title.replace(/[.']/g, "").replace(/[()&]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 2).join(" ");
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 60);
  assert.equal(groq.requests, 1, "one request for the whole batch");
  assert.equal(client.stats.rejected, 0);
});

test("a reply that only echoes \"The\" is asked again in smaller pieces, not stopped as a format problem", async () => {
  const songs = ["The Less I Know the Better", "The Night We Met", "The Way Life Goes"]
    .map((title, i) => ({ uri: `t${i}`, title, artist: `Band ${i}`, featured: [] }));
  const groq = new FakeGroq({ artists: Object.fromEntries(songs.map((x) => [x.artist, "indie-rock"])) });
  groq.echo = (title) => title.split(" ")[0]; // just "The"
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, 3);
  assert.ok(Object.values(cache).every((a) => a.playlist === "indie-rock"));
  assert.equal(groq.structuredRequests, groq.requests, "stayed with strict JSON replies");

  // Asked about a single song (as on the careful second look), a one-word echo is fine.
  const one = {};
  await classifySongs(client, songs.slice(0, 1).map((x) => ({ ...x, uri: "solo" })), NODES, one, { careful: true });
  assert.equal(one.solo.playlist, "indie-rock");
});

test("a model that always echoes just one word still sorts a batch in one request when the words differ", async () => {
  const titles = ["The Night We Met", "Love Story", "Sunflower", "Blinding Lights", "Levitating", "Heat Waves"];
  const songs = titles.map((title, i) => ({ uri: `u${i}`, title, artist: `Band ${i}`, featured: [] }));
  const groq = new FakeGroq({ artists: Object.fromEntries(songs.map((x) => [x.artist, "pop"])) });
  groq.echo = (title) => title.split(" ")[0];
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, songs, NODES, cache);
  assert.equal(Object.keys(cache).length, titles.length);
  assert.equal(groq.requests, 1);
});

test("Groq's own refusal message is kept, and its real daily limit is learned", async () => {
  const { artists, songs } = library(200);
  const s = setup({ groq: new FakeGroq({ artists }) });
  s.groq.dailyLimit = 3000;
  const err = await classifySongs(s.client, songs, NODES, {}).catch((e) => e);
  assert.ok(err instanceof GroqDailyLimitError);
  assert.match(err.detail, /tokens per day \(TPD\): Limit 3000/);
  assert.ok(s.entries().some((e) => e.limitTpd === 3000), "the real limit is remembered");
  const again = createGroq({ apiKey: "k", model: "llama-3.3-70b-versatile", fetchImpl: s.groq.fetch, ledger: s.ledger });
  assert.equal(again.budget().tpd, 2700, "later budgeting uses 90% of Groq's real limit");
});

test("the counters show what happened: requests, cut-offs, rejected answers, splits", async () => {
  const { artists, songs } = library(60);
  const groq = new FakeGroq({ artists });
  groq.shiftFrom = 30;
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  await classifySongs(client, songs, NODES, {});
  assert.ok(client.stats.requests >= 2);
  assert.ok(client.stats.rejected >= 30, `answers meant for neighbours were counted: ${client.stats.rejected}`);
  assert.ok(client.stats.tokens > 0);
});

// ---- a second look for songs the model didn't know at all

test("songs the model didn't know get a careful look with catalog data, and are placed only on that data", async () => {
  const groq = new FakeGroq();
  groq.fromStoreGenre = (genre) => (genre === "Singer/Songwriter" ? "folk-acoustic" : "none");
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  const cache = {};
  await classifySongs(client, [
    { uri: "a", title: "Golden Hour", artist: "Small Local Band", featured: [], storeGenre: "Singer/Songwriter" },
    { uri: "b", title: "Basement Demo", artist: "Small Local Band", featured: [], storeGenre: "Ringtones" },
  ], NODES, cache, { careful: true });
  assert.equal(groq.carefulRequests, 1, "asked once, carefully, with more thinking");
  assert.equal(cache.a.playlist, "folk-acoustic", "placed from Apple Music's genre");
  assert.equal(cache.b.playlist, "none", "data that doesn't place it: still not guessed");
  assert.match(groq.seen[0], /Apple Music genre: Singer\/Songwriter/);
});

test("the careful look uses small batches", async () => {
  const songs = Array.from({ length: 70 }, (_, i) => ({ uri: `c${i}`, title: `Song ${i}`, artist: `Band ${i}`, featured: [], storeGenre: "Pop" }));
  const groq = new FakeGroq();
  const { client } = setup({ groq, model: "openai/gpt-oss-120b" });
  await classifySongs(client, songs, NODES, {}, { careful: true });
  assert.deepEqual(groq.calls, [30, 30, 10]);
});
