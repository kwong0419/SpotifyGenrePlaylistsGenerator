// Accuracy check: sorts the well-known songs in benchmark.json with the user's Groq key and
// model, through exactly the same code as the real run, and scores the answers.
import { flattenTaxonomy, scoreAnswer as score } from "./core.js";
import { createGroq, classifySongs, estimateSongJob, GroqDailyLimitError, PREFERRED_MODELS } from "./groq.js";

// tests/accuracy-demo.html sets __GS_DEMO__ to run against a simulated Groq.
const DEMO = window.__GS_DEMO__ || null;
const groqFetch = DEMO?.groqFetch || window.fetch.bind(window);
const STORE_PREFIX = DEMO ? "gs-demo." : "gs.";
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(STORE_PREFIX + key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ } },
};
const $ = (id) => document.getElementById(id);


async function start() {
  const [taxonomy, bench] = await Promise.all([
    fetch(new URL("./taxonomy.json", import.meta.url)).then((r) => r.json()),
    fetch(new URL("./benchmark.json", import.meta.url)).then((r) => r.json()),
  ]);
  const nodes = flattenTaxonomy(taxonomy.genres);
  const songs = bench.songs.map((s, i) => ({ uri: `bench:${i}`, title: s.title, artist: s.artist, featured: [], ok: s.ok }));
  const key = store.get("groqKey", "");
  const model = store.get("groqModel", PREFERRED_MODELS[0]);
  $("count").textContent = songs.length;
  $("model").textContent = model;

  if (!key) {
    $("setup-note").textContent = "Add your Groq key in the app first (it asks for it after you log in), then come back here.";
    $("run").disabled = true;
    return;
  }
  const pause = (ms) => {
    $("progress-text").textContent = `⏳ Pacing to stay inside Groq's free per-minute limit: next batch in ${Math.ceil(ms / 1000)}s.`;
  };
  const groq = createGroq({
    apiKey: key, model, fetchImpl: groqFetch, onPace: pause, onWait: pause,
    // The same daily budget as the app, so the check counts against today's allowance.
    ledger: { load: () => store.get(`groqLedger:${model}`, []), save: (e) => store.set(`groqLedger:${model}`, e) },
  });
  $("cost").textContent = `${Math.round(estimateSongJob(groq, songs, nodes).tokens / 100) * 100}`.replace(/\B(?=(\d{3})+$)/g, ",");

  $("run").addEventListener("click", async () => {
    $("run").disabled = true;
    $("error").hidden = true;
    $("progress-card").hidden = false;
    const answers = {};
    try {
      await classifySongs(groq, songs, nodes, answers, {
        onProgress: (done, total) => {
          $("progress-fill").style.width = `${total ? Math.round((done / total) * 100) : 5}%`;
          $("progress-text").textContent = `${done} of ${total} songs`;
        },
      });
      showResults(songs, answers, nodes);
    } catch (err) {
      $("error").textContent = err instanceof GroqDailyLimitError
        ? "Today's Groq allowance for this model is used up. Try again later, or pick another model in the app's Settings."
        : err.message;
      $("error").hidden = false;
    } finally {
      $("progress-card").hidden = true;
      $("run").disabled = false;
      $("run").textContent = "Run the check again";
    }
  });
}

function showResults(songs, answers, nodes) {
  const name = (id) => (id === "none" ? "didn't know it" : nodes.find((n) => n.id === id)?.name || id);
  const counts = { exact: 0, family: 0, wrong: 0, unknown: 0 };
  const misses = [];
  for (const s of songs) {
    const got = answers[s.uri];
    const result = got === undefined ? "unknown" : score(got, s.ok, nodes);
    counts[result]++;
    if (result !== "exact") misses.push({ s, got, result });
  }
  const answered = songs.length - counts.unknown;
  const pct = (n) => `${Math.round((n / Math.max(1, answered)) * 100)}%`;
  $("exact").textContent = pct(counts.exact);
  $("family").textContent = pct(counts.family);
  $("wrong").textContent = pct(counts.wrong);
  $("verdict").textContent = `${counts.exact + counts.family} of ${answered} answered songs landed in the right genre `
    + `(${pct(counts.exact + counts.family)}), and ${counts.exact} in exactly the right playlist.`;
  $("unknown").textContent = counts.unknown
    ? `The model didn't know ${counts.unknown} of the ${songs.length} songs; percentages are of the ones it answered.`
    : "";
  const order = { wrong: 0, family: 1, unknown: 2 };
  misses.sort((a, b) => order[a.result] - order[b.result]);
  $("misses").replaceChildren(...misses.map(({ s, got, result }) => {
    const li = document.createElement("li");
    li.className = "genre";
    li.innerHTML = '<div class="genre-head"><div class="text"><div class="name"></div><div class="meta"></div></div><span class="badge"></span></div>';
    li.querySelector(".name").textContent = `${s.title} — ${s.artist}`;
    li.querySelector(".meta").textContent = `Got: ${name(got ?? "none")} · Expected: ${s.ok.map(name).join(" or ")}`;
    li.querySelector(".badge").textContent = { wrong: "Wrong genre", family: "Close", unknown: "Unknown" }[result];
    return li;
  }));
  $("results").hidden = false;
}

start().catch((err) => {
  $("error").textContent = `Couldn't load the check: ${err.message}`;
  $("error").hidden = false;
});
