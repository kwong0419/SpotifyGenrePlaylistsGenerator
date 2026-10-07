import { CONFIG } from "./config.js";
import {
  createClient, fetchLikedTracks, dedupeTracks, flattenTaxonomy, groupSongs,
  resolvePlaylists, syncPlaylists, planSync, SpotifyError, RateLimitedError, UNCATEGORIZED, NOT_SORTED_YET,
} from "./core.js";
import {
  createGroq, chooseModel, chatModels, clearUsageEstimates, classifySongs, estimateSongJob, firstWord,
  GroqError, GroqDailyLimitError, PREFERRED_MODELS,
} from "./groq.js";

const ACCOUNTS = "https://accounts.spotify.com";
const SCOPES = "user-library-read playlist-read-private playlist-modify-private playlist-modify-public";
const MIN_SONGS_PRESELECTED = 5;
// tests/demo.html sets __GS_DEMO__ to run against a simulated Spotify. Real visitors
// never have it, so they always use the real Spotify and the real login.
const DEMO = window.__GS_DEMO__ || null;
const fetchImpl = DEMO?.fetch || window.fetch.bind(window);
const groqFetch = DEMO?.groqFetch || window.fetch.bind(window);
const appleFetch = DEMO?.appleFetch || window.fetch.bind(window);
const sharedClientId = DEMO ? DEMO.sharedClientId : CONFIG.clientId;

const $ = (id) => document.getElementById(id);
const redirectUri = location.origin + location.pathname.replace(/index\.html$/, "");

// localStorage can throw (private mode, blocked storage), so every access is guarded.
// The demo keeps its own keys so it can never leave fake logins behind for the real app.
const STORE_PREFIX = DEMO ? "gs-demo." : "gs.";
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(STORE_PREFIX + key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ } },
  del(key) { try { localStorage.removeItem(STORE_PREFIX + key); } catch { /* ignore */ } },
};

const state = { expanded: new Set(), me: null, buckets: [], groups: [], targets: new Map(), selected: new Set(), dupesRemoved: 0, total: 0 };

const clientId = () => store.get("clientId") || sharedClientId;
const prefix = () => store.get("prefix", "Liked · ");
const nameFor = (bucket) => prefix() + bucket.name;

// --------------------------------------------------------------------------- screens

function show(name) {
  const changing = $(`screen-${name}`).hidden;
  document.querySelectorAll("main > section").forEach((s) => { s.hidden = s.id !== `screen-${name}`; });
  $("settings-btn").hidden = !store.get("token");
  if (changing) window.scrollTo(0, 0);
}

const APP_TITLE = "Genre Sorter";
const STEPS = { read: "Step 1 of 3 · Reading your library", sort: "Step 2 of 3 · Working out genres", save: "Step 3 of 3 · Saving playlists" };

function progress(title, done, total, text = "", step = "") {
  show("progress");
  $("progress-step").textContent = step;
  $("progress-title").textContent = title;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null;
  $("progress-fill").style.width = pct === null ? "8%" : `${pct}%`;
  $("progress-text").textContent = text;
  // The tab title shows progress, so it can be followed from another tab.
  document.title = `${pct === null ? "…" : `${pct}%`} · ${title.replace(/…$/, "")} — ${APP_TITLE}`;
}

function minutesText(ms) {
  const min = Math.round(ms / 60000);
  return min < 1 ? "less than a minute" : `${min} minute${min === 1 ? "" : "s"}`;
}

/**
 * A progress line whose time left and time so far tick every second, even while waiting
 * between batches. Time left is the larger of the estimate's remaining share and the pace
 * measured so far: the first batches go out at once, before pacing kicks in, so the
 * measured pace alone would promise too much early on.
 */
let liveTimer = null;
function liveProgress(title, unit, estimateMs, step) {
  const start = Date.now();
  let done = 0;
  let total = 0;
  const render = () => {
    const elapsed = Date.now() - start;
    const share = total ? (total - done) / total : 1;
    const byPace = done && elapsed > 20000 ? (elapsed / done) * (total - done) : 0;
    const left = Math.max(estimateMs * share, byPace);
    progress(title, done, total, `${done.toLocaleString()} of ${total.toLocaleString()} ${unit} · `
      + `${done >= total ? "finishing up" : left < 60000 ? "less than a minute left" : `about ${minutesText(left)} left`} · `
      + `${minutesText(elapsed)} so far`, step);
  };
  clearInterval(liveTimer);
  liveTimer = setInterval(render, 1000);
  return {
    update(d, t) { done = d; total = t; render(); },
    stop() { clearInterval(liveTimer); },
  };
}

function showError(err) {
  if (err instanceof RateLimitedError) return showCooldown(err);
  console.error(err);
  $("error-text").textContent = err.message || String(err);
  show("error");
}

function showSetup() {
  const shared = !!sharedClientId;
  $("setup-why").textContent = shared
    ? "Spotify only lets each app be used by a handful of people, so you'll create your own free Spotify app. It takes about 3 minutes."
    : "Spotify requires a free developer app to sort your library. Creating one takes about 3 minutes.";
  $("setup-back").hidden = !shared;
  $("redirect-uri").textContent = redirectUri;
  $("client-id-input").value = store.get("clientId", "");
  $("client-id-error").hidden = true;
  show("setup");
}

// --------------------------------------------------------------------------- auth (PKCE)

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function login() {
  if (DEMO) {
    store.set("token", { access_token: "demo", refresh_token: "demo", expires_at: Date.now() + 36e5, clientId: clientId() });
    return scan();
  }
  const verifier = randomString(64);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const authState = randomString(16);
  store.set("pkce", { verifier, state: authState, clientId: clientId() });
  location.assign(`${ACCOUNTS}/authorize?${new URLSearchParams({
    client_id: clientId(), response_type: "code", redirect_uri: redirectUri, scope: SCOPES,
    state: authState, code_challenge_method: "S256", code_challenge: challenge,
  })}`);
}

async function tokenRequest(params) {
  const resp = await fetchImpl(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error_description || data.error || `Login failed (${resp.status})`);
  return data;
}

function saveToken(data, forClientId) {
  const old = store.get("token") || {};
  store.set("token", {
    access_token: data.access_token,
    refresh_token: data.refresh_token || old.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
    clientId: forClientId,
  });
}

/** Returns true if this page load is the return from Spotify's login screen. */
async function handleLoginReturn() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return false;
  history.replaceState(null, "", redirectUri);
  const pkce = store.get("pkce");
  store.del("pkce");
  if (params.get("error")) {
    throw new Error(params.get("error") === "access_denied"
      ? "Spotify login was cancelled."
      : `Spotify login failed: ${params.get("error")}`);
  }
  if (!pkce || params.get("state") !== pkce.state) throw new Error("Login expired. Please try again.");
  const data = await tokenRequest({
    grant_type: "authorization_code", code: params.get("code"), redirect_uri: redirectUri,
    client_id: pkce.clientId, code_verifier: pkce.verifier,
  });
  saveToken(data, pkce.clientId);
  return true;
}

let refreshing = null;
async function refreshToken() {
  // Several parallel requests can hit an expired token at once; refresh only once.
  refreshing ||= (async () => {
    const token = store.get("token");
    try {
      saveToken(await tokenRequest({
        grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: token.clientId,
      }), token.clientId);
    } catch {
      store.del("token");
      throw new Error("Your Spotify login expired. Please log in again.");
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function getToken() {
  const token = store.get("token");
  if (!token) throw new Error("Not logged in.");
  if (Date.now() >= token.expires_at) await refreshToken();
  return store.get("token").access_token;
}

// Shows a live countdown while Spotify has asked us to pause.
let pauseTimer = null;
function showPause(ms, service = "Spotify", planned = false) {
  const until = Date.now() + ms;
  clearInterval(pauseTimer);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) { clearInterval(pauseTimer); $("progress-hint").textContent = ""; return; }
    $("progress-hint").textContent = planned
      ? `⏳ Pacing to stay inside Groq's free limit. Next batch in ${left}s. This is expected and already counted in the time left.`
      : `${service} limits how quickly apps can ask for data, so we're taking a short break. Resuming in ${left}s. Your progress is saved.`;
  };
  tick();
  pauseTimer = setInterval(tick, 1000);
}

const api = createClient({ getToken, onUnauthorized: refreshToken, fetchImpl, onWait: showPause });

// --------------------------------------------------------------------------- Groq

// Groq's free limits are per model, so each model has its own daily budget. Shared by
// every tab via localStorage, so it holds across reloads.
const groqLedger = (model) => ({
  load: () => store.get(`groqLedger:${model}`, []),
  save: (e) => store.set(`groqLedger:${model}`, e),
});
const currentModel = () => store.get("groqModel", PREFERRED_MODELS[0]);

function groqClient(key = store.get("groqKey", ""), model = store.get("groqModel", PREFERRED_MODELS[0])) {
  if (!key) return null;
  return createGroq({
    apiKey: key, model, fetchImpl: groqFetch, ledger: groqLedger(model),
    onWait: (ms) => showPause(ms, "Groq"),
    onPace: (ms) => showPause(ms, "Groq", true),
  });
}

function showGroqSetup(message = "") {
  $("groq-key-input").value = store.get("groqKey", "");
  $("groq-error").textContent = message;
  $("groq-error").hidden = !message;
  show("groq");
}

/** Checks a Groq key (listing models costs no tokens) and picks a model it can use. */
async function saveGroqKey() {
  const key = $("groq-key-input").value.trim();
  const btn = $("save-groq-key");
  if (!key) return showGroqSetup("Paste your Groq API key first.");
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const models = await groqClient(key).listModels();
    const model = chooseModel(models);
    if (!model) throw new Error("This Groq key has no text models available.");
    store.set("groqKey", key);
    store.set("groqModel", model);
    scan();
  } catch (err) {
    showGroqSetup(err instanceof GroqError && err.kind === "auth"
      ? "Groq didn't accept that key. Copy it again from console.groq.com/keys."
      : err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Continue";
  }
}

// --------------------------------------------------------------------------- reading the library

// Saving big caches on every batch would be wasteful; at most every 2s is plenty.
const lastSave = {};
function saveThrottled(key, value, force = false) {
  if (!force && Date.now() - (lastSave[key] || 0) < 2000) return;
  lastSave[key] = Date.now();
  store.set(key, value);
}

/**
 * Last.fm's top tags for an artist, or null if Last.fm couldn't be asked (network
 * trouble, rate limit), in which case nothing is saved and it's retried next run.
 * A rejected key throws, so a typo can't quietly mark every artist as "no tags".
 */
async function lastfmTags(name, key) {
  let data;
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?${new URLSearchParams({
      method: "artist.gettoptags", artist: name, api_key: key, format: "json",
    })}`;
    data = await (await fetch(url)).json();
  } catch {
    return null;
  }
  if (data.error === 10 || data.error === 26) {
    throw new Error("Last.fm didn't accept your API key. Check it in Settings, or clear it to skip Last.fm.");
  }
  if (data.error === 6) return []; // Last.fm doesn't know this artist
  if (data.error) return null;
  return (data.toptags?.tag || []).slice(0, 5).filter((t) => +t.count >= 20).map((t) => t.name.toLowerCase());
}

/**
 * Last.fm's top listener tags for one song (often about its sound: "piano", "chill",
 * "instrumental"), or null if Last.fm couldn't be asked (retried next run). A rejected
 * key throws.
 */
async function lastfmSongTags(artist, title, key) {
  let data;
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?${new URLSearchParams({
      method: "track.gettoptags", artist, track: title, api_key: key, format: "json", autocorrect: "1",
    })}`;
    data = await (await fetch(url)).json();
  } catch {
    return null;
  }
  if (data.error === 10 || data.error === 26) {
    throw new Error("Last.fm didn't accept your API key. Check it in Settings, or clear it to skip Last.fm.");
  }
  if (data.error === 6) return []; // Last.fm doesn't know this song
  if (data.error) return null;
  return (data.toptags?.tag || []).slice(0, 6).filter((t) => +t.count >= 10).map((t) => t.name.toLowerCase());
}

/**
 * The genre Apple Music's catalog gives one song (set by its label, e.g. "Classical
 * Crossover"), from Apple's free public search. "" if Apple doesn't have it, null if it
 * couldn't be asked. Apple allows about 20 searches a minute, so searches are spaced 3s
 * apart, and if Apple ever refuses, lookups pause for 10 minutes (sorting carries on).
 */
let appleNext = 0;
let applePausedUntil = 0;
async function appleMusicGenre(title, artist) {
  if (Date.now() < applePausedUntil) return null;
  const wait = appleNext - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  appleNext = Date.now() + 3100;
  try {
    const resp = await appleFetch(`https://itunes.apple.com/search?${new URLSearchParams({
      term: `${artist} ${title}`, entity: "song", limit: "8",
    })}`);
    if (resp.status === 403 || resp.status === 429) { applePausedUntil = Date.now() + 10 * 60_000; return null; }
    if (!resp.ok) return null;
    const plain = (x) => String(x || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    const artistWord = plain(artist).split(/[\s,&]+/).find(Boolean) || "";
    // The same song: its artist and the first word of its title have to match.
    const hit = ((await resp.json()).results || []).find((r) => plain(r.artistName).includes(artistWord)
      && firstWord(r.trackName) === firstWord(title));
    return hit?.primaryGenreName || "";
  } catch {
    return null;
  }
}

/** Runs `fn` unless another tab is already running, so two tabs never double the requests. */
async function withRunLock(fn) {
  if (!navigator.locks) return fn();
  return navigator.locks.request("gs-run", { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("Genre Sorter is already running in another tab. Let it finish there, then reload this one.");
    return fn();
  });
}

function scan() {
  return withRunLock(scanLibrary).catch(showError);
}

async function scanLibrary() {
  state.sortedMs = null;
  progress("Connecting to Spotify…", 0, 0, "", STEPS.read);
  try {
    state.me = await api.request("GET", "/me");
  } catch (err) {
    if (err instanceof SpotifyError && err.status === 403) return showNotAllowed();
    throw err;
  }
  // Ask for the Groq key before reading the library, so no Spotify requests are wasted.
  const groq = groqClient();
  if (!groq) return showGroqSetup();

  // A saved copy of Liked Songs is reused when nothing changed, so resuming costs 1 request.
  const { tracks: liked, snapshot } = await fetchLikedTracks(api, (n, total) =>
    progress("Reading your Liked Songs…", n, total, `${n.toLocaleString()} of ${total.toLocaleString()} songs`, STEPS.read),
    store.get("liked", null));
  store.set("liked", snapshot);
  const { tracks, removed } = dedupeTracks(liked);
  state.tracks = tracks;
  state.total = tracks.length;
  state.dupesRemoved = removed;

  forgetOldVersionData();
  // Answers are saved per song ("songAnswers": uri -> { playlist, confidence }) and tied to
  // the playlist list they were chosen from: if that list changes (a genre added or split),
  // songs are sorted again. Placements from the previous, unchecked method ("songPicks":
  // uri -> playlist) only stand in until each song is re-checked, so playlists don't empty
  // out meanwhile. The listener's own corrections ("corrections") always win.
  const listId = state.nodes.map((n) => n.id).join(",");
  if (store.get("songAnswersFor", "") !== listId) {
    store.del("songAnswers");
    store.del("lastfmTried");
    store.set("songAnswersFor", listId);
  }
  if (store.get("songPicksFor", "") !== listId) store.del("songPicks");
  const answers = store.get("songAnswers", {});
  const previous = store.get("songPicks", {});
  const corrections = store.get("corrections", {});
  const lfm = store.get("lastfmTags", {});
  const songTagCache = store.get("lastfmSongTags", {});
  const storeGenreCache = store.get("appleGenres", {});
  const lastfmKey = store.get("lastfm", "");
  const byUri = new Map(tracks.map((t) => [t.uri, t]));
  const toSong = (t) => ({
    uri: t.uri, title: t.name, artist: t.artistNames[0] || "", featured: t.artistNames.slice(1, 4),
    context: lfm[t.artistIds[0]] || [], songTags: songTagCache[t.uri] || [], storeGenre: storeGenreCache[t.uri] || "",
  });
  // The listener's corrections, newest first, shown to the model as examples of their taste.
  const examples = Object.entries(corrections)
    .sort((a, b) => b[1].at - a[1].at)
    .map(([uri, c]) => byUri.get(uri) && { title: byUri.get(uri).name, artist: byUri.get(uri).artistNames[0], playlist: c.playlist })
    .filter((e) => e && e.playlist !== "none");
  // Extra evidence for songs the model is unsure about, from real catalogs: the genre Apple
  // Music gives the song (free, no key) and, if set up, Last.fm's listener tags for it
  // (often about its sound: "piano", "instrumental", "chill"). Looked up once per song.
  const moreContext = async (song) => {
    if (!(song.uri in storeGenreCache)) {
      const genre = await appleMusicGenre(song.title, song.artist);
      if (genre !== null) {
        storeGenreCache[song.uri] = genre;
        store.set("appleGenres", storeGenreCache);
      }
    }
    if (lastfmKey && !(song.uri in songTagCache)) {
      const tags = await lastfmSongTags(song.artist, song.title, lastfmKey);
      if (tags) songTagCache[song.uri] = tags;
      store.set("lastfmSongTags", songTagCache);
    }
    return { storeGenre: storeGenreCache[song.uri] || "", songTags: songTagCache[song.uri] || [] };
  };
  let paused = null;

  try {
    const todo = tracks.filter((t) => !(t.uri in answers) && !(t.uri in corrections)).map(toSong);
    const rechecking = todo.filter((x) => x.uri in previous).length;
    const estimate = estimateSongJob(groq, todo, state.nodes);
    // If nothing fits today, skip the plan: classifySongs stops before sending anything and
    // the allowance screen offers the ways forward (check with Groq, another model).
    if (todo.length && estimate.startsToday && (estimate.minutes >= 3 || estimate.days > 1)) {
      await confirmPlan(estimate, todo.length, tracks.length - todo.length, rechecking);
    }
    const startedAt = Date.now();
    const line = liveProgress(rechecking ? "Re-checking your songs…" : "Sorting your songs…", "songs", estimate.minutes * 60000, STEPS.sort);
    try {
      await classifySongs(groq, todo, state.nodes, answers, {
        examples, moreContext,
        onProgress: (done, total) => line.update(done, total),
        onSaved: (c) => saveThrottled("songAnswers", c),
        onLookup: (i, n) => {
          line.stop();
          progress("Looking up songs Groq was unsure about…", i, n,
            `${i.toLocaleString()} of ${n.toLocaleString()} songs · checking Apple Music${lastfmKey ? " and Last.fm" : ""} `
            + `· about ${minutesText((n - i) * 3100)} left`, STEPS.sort);
        },
      });
    } finally {
      line.stop();
      saveThrottled("songAnswers", answers, true);
    }

    // Optional second chance with real listener tags: songs Groq didn't know at all ("none")
    // are asked again with Last.fm's tags for their artist and the song. Once per song.
    if (lastfmKey) {
      const tried = new Set(store.get("lastfmTried", []));
      const unplaced = tracks.filter((t) => answers[t.uri]?.playlist === "none" && !tried.has(t.uri) && t.artistIds[0]);
      const names = new Map(unplaced.map((t) => [t.artistIds[0], t.artistNames[0]]));
      const need = [...names.keys()].filter((id) => !(id in lfm));
      try {
        for (const [i, id] of need.entries()) {
          progress("Looking up artists on Last.fm…", i, need.length, `${i} of ${need.length} artists`, STEPS.sort);
          const tags = await lastfmTags(names.get(id), lastfmKey);
          if (tags) lfm[id] = tags;
          if (i % 25 === 0) store.set("lastfmTags", lfm);
          await new Promise((r) => setTimeout(r, 220)); // Last.fm allows about 5 requests a second
        }
      } finally {
        store.set("lastfmTags", lfm);
      }
      const retry = unplaced.filter((t) => lfm[t.artistIds[0]]?.length);
      for (const t of retry) delete answers[t.uri];
      for (const t of unplaced) tried.add(t.uri);
      store.set("lastfmTried", [...tried]);
      if (retry.length) {
        const again = liveProgress("Sorting songs again with Last.fm's tags…", "songs",
          ((retry.length * 30) / groq.budget().tpm) * 60000, STEPS.sort);
        try {
          await classifySongs(groq, retry.map(toSong), state.nodes, answers, {
            examples, moreContext,
            onProgress: (done, total) => again.update(done, total),
            onSaved: (c) => saveThrottled("songAnswers", c),
          });
        } finally {
          again.stop();
        }
      }
    }
    state.sortedMs = Date.now() - startedAt;
  } catch (err) {
    if (!(err instanceof GroqDailyLimitError)) throw err;
    paused = err;
  } finally {
    saveThrottled("songAnswers", answers, true);
  }
  // Once every song has a checked answer (or a correction), the old placements aren't needed.
  if (tracks.every((t) => t.uri in answers || t.uri in corrections)) store.del("songPicks");

  // Where each song goes: the listener's correction, else the checked answer, else (until
  // it's re-checked) its previous placement. Grouping is redone once existing playlists are
  // known (see showPreview): a subgenre that already has a playlist stays separate.
  state.corrections = corrections;
  state.answers = answers;
  state.regroup = (keepIds = new Set()) => {
    const picks = {};
    for (const t of tracks) {
      const p = corrections[t.uri]?.playlist ?? answers[t.uri]?.playlist ?? previous[t.uri];
      if (p !== undefined) picks[t.uri] = p;
    }
    return groupSongs(tracks, picks, state.nodes, { isPending: (t) => !(t.uri in picks), keepIds });
  };
  state.groups = state.regroup(new Set(Object.keys(store.get("playlists", {}))));
  // Songs still placed by the previous method, waiting to be re-checked.
  state.awaitingRecheck = tracks.filter((t) => !(t.uri in answers) && !(t.uri in corrections) && t.uri in previous).length;
  state.leftover = {
    hasLastfm: !!lastfmKey,
    unsure: tracks.filter((t) => answers[t.uri]?.confidence === "low" && !(t.uri in corrections)).length,
  };
  state.selected = new Set(state.groups
    .filter((g) => ![UNCATEGORIZED.id, NOT_SORTED_YET.id].includes(g.bucket.id) && g.tracks.length >= MIN_SONGS_PRESELECTED)
    .map((g) => g.bucket.id));
  state.groqResumeAt = paused?.resumeAt || null;

  if (!paused) store.del("groqDays"); // fully sorted: a future multi-day run starts at day 1
  if (paused) return showGroqPaused(paused);
  return showPreview();
}

/** Saved data from versions that sorted by artist; none of it is used any more. */
function forgetOldVersionData() {
  if (store.get("dataVersion", 0) >= 3) return;
  ["artists", "artistTags", "songTags", "tagsFormat", "playlistPicks", "playlistPicksFor"].forEach((k) => store.del(k));
  store.set("dataVersion", 3);
}

/** Before a long sort: how many songs, roughly how long, and whether it spans days. Waits for Start. */
function confirmPlan(estimate, todo, alreadySorted, rechecking = 0) {
  $("plan-lead").textContent = rechecking
    ? `Re-checking ${rechecking.toLocaleString()} songs with the improved sorting (confidence checks, a careful second look `
      + "for unsure songs, and your corrections as examples). Your playlists keep their current songs until each one is re-checked."
    : alreadySorted
    ? `Picking up where you left off: ${alreadySorted.toLocaleString()} songs are already sorted.`
    : "Groq will pick the playlist each song fits best, judging every song on its own. This only happens once; later runs just sort newly liked songs.";
  $("plan-artists").textContent = todo.toLocaleString();
  $("plan-time").textContent = `~${estimate.minutes} min`;
  $("plan-time-label").textContent = estimate.days > 1 ? "estimated time today" : "estimated time";
  $("plan-days").textContent = estimate.days > 1 ? `${estimate.days} days` : "1 day";
  $("plan-note").textContent = estimate.days > 1
    ? `Your library will probably need more than one day of Groq's free allowance, so at least ${Math.round(estimate.todayShare * 100)}% gets sorted today, `
      + "most recently liked songs first. You can make playlists right away and run again on the following days to sort the rest. "
      + "Nothing is duplicated."
    : "You can switch to another tab while it runs. The tab's title shows the progress and changes to ✓ when it's done.";
  document.title = `Ready to start — ${APP_TITLE}`;
  show("plan");
  return new Promise((resolve) => { $("plan-start").onclick = () => resolve(); });
}

/**
 * Groq's daily allowance ran out (or our cautious count says so): show how far along we
 * are and the ways forward: ask Groq directly, switch to a model with its own allowance,
 * or make playlists with what's sorted.
 */
function showGroqPaused(err) {
  const pendingSongs = state.groups.find((g) => g.bucket.id === NOT_SORTED_YET.id)?.tracks.length || 0;
  const sortedSongs = state.total - pendingSongs;
  const model = currentModel();
  if (sortedSongs) {
    const daysDone = store.get("groqDays", 0) + 1;
    store.set("groqDays", daysDone);
    $("budget-day").textContent = `Day ${daysDone} done`;
    $("budget-title").textContent = "Groq's free allowance is used up for today";
    $("budget-lead").textContent = "Everything sorted so far is saved.";
  } else {
    $("budget-day").textContent = "";
    $("budget-title").textContent = "Nothing could be sorted yet";
    $("budget-lead").textContent = `Today's free allowance for ${model} looks used up, so sorting couldn't start. Nothing is lost.`;
  }
  const waiting = state.awaitingRecheck || 0;
  const checked = sortedSongs - waiting;
  $("budget-fill").style.width = `${Math.round(((waiting ? checked : sortedSongs) / Math.max(1, state.total)) * 100)}%`;
  $("budget-progress").textContent = waiting
    ? `${checked.toLocaleString()} of ${state.total.toLocaleString()} songs re-checked with the improved sorting (most recently liked first). `
      + `The other ${waiting.toLocaleString()} keep their current playlist until they're re-checked.`
    : `${sortedSongs.toLocaleString()} of ${state.total.toLocaleString()} songs sorted` + (pendingSongs ? " (most recently liked first)." : ".");
  $("budget-when").textContent = err.source === "groq"
    ? `Groq says ${model}'s allowance resets after ${formatWhen(err.resumeAt)}. Open this page again then and it continues where it stopped.`
    : `By the app's count, ${model}'s allowance frees up after ${formatWhen(err.resumeAt)}. Open this page again then and it continues where it stopped.`;
  $("budget-check-box").hidden = err.source !== "estimate";
  $("budget-continue-box").hidden = sortedSongs === 0;
  document.title = `Paused until ${formatWhen(err.resumeAt)} — ${APP_TITLE}`;
  show("budget");
  offerOtherModels(model);
}

/** Fills the "continue with another model" list from the models this key can use. */
async function offerOtherModels(current) {
  $("budget-models-box").hidden = true;
  try {
    const others = chatModels(await groqClient().listModels()).filter((m) => m !== current);
    // Best first: our preference order, then the rest.
    others.sort((a, b) => (PREFERRED_MODELS.indexOf(a) + 1 || 99) - (PREFERRED_MODELS.indexOf(b) + 1 || 99));
    $("budget-model").replaceChildren(...others.map((m) => Object.assign(document.createElement("option"), { value: m, textContent: m })));
    $("budget-models-box").hidden = !others.length;
  } catch { /* the list is optional */ }
}

function formatWhen(ts) {
  const when = new Date(ts);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return when.toDateString() === new Date().toDateString() ? time : `${time} tomorrow`;
}

// --------------------------------------------------------------------------- Spotify lockouts

// Spotify can lock an app out for hours if it asks too much too fast, and asking during a
// lockout can extend it. Browsers can't see how long it lasts, so we guess, starting at
// an hour and doubling if it's hit again soon after. Nothing is sent until it's over.
function startCooldown(err) {
  const prev = store.get("cooldown", null);
  const strikes = prev && Date.now() - prev.until < 24 * 36e5 ? prev.strikes + 1 : 1;
  // A used-up quota has been observed to last ~20 hours, so assume a day when Spotify
  // doesn't say; a plain rate-limit lockout starts at an hour and doubles.
  const guess = err.quota ? 24 : Math.min(24, 2 ** (strikes - 1));
  const ms = err.retryAfterMs ?? guess * 36e5;
  const cooldown = { until: Date.now() + ms, strikes, known: err.retryAfterMs != null, quota: !!err.quota };
  store.set("cooldown", cooldown);
  return cooldown;
}

function activeCooldown() {
  const c = store.get("cooldown", null);
  return c && Date.now() < c.until ? c : null;
}

function showCooldown(err) {
  const c = err ? startCooldown(err) : activeCooldown();
  $("cooldown-when").textContent = `${c.quota ? "Your Spotify developer account has used up its request allowance. " : ""}`
    + `${c.known ? "Spotify says to come back" : "Come back"} after ${formatWhen(c.until)}.`;
  $("cooldown-progress").textContent = "Everything found so far is saved. Next time picks up from there.";
  show("cooldown");
}

function showNotAllowed() {
  $("ask-owner").textContent = CONFIG.ownerName ? `Ask ${CONFIG.ownerName}` : "Ask the person who shared this link";
  show("not-allowed");
}

// --------------------------------------------------------------------------- preview

async function showPreview() {
  progress("Checking your existing playlists…", 0, 0, "", STEPS.save);
  try {
    const { targets } = await resolvePlaylists(api, state.me.id, [...state.nodes, UNCATEGORIZED], nameFor,
      store.get("playlists", {}));
    state.targets = targets;
  } catch {
    state.targets = new Map(); // only used for labels and keeping existing playlists separate
  }
  applyExistingPlaylists();
  renderPreview();
}

/** Re-groups so subgenres that already have a playlist stay separate (no flip-flopping). */
function applyExistingPlaylists() {
  if (!state.regroup) return;
  const existing = new Set([...state.targets].filter(([, t]) => !t.isNew).map(([id]) => id));
  state.groups = state.regroup(existing);
}

function renderPreview() {
  const pendingAll = state.groups.find((g) => g.bucket.id === NOT_SORTED_YET.id)?.tracks.length || 0;
  $("ready-banner").hidden = false;
  $("ready-banner").textContent = pendingAll === state.total
    ? "Nothing is sorted yet. Run again once Groq's allowance is back, or pick another model in Settings."
    : pendingAll
    ? `✓ Sorting is done for today. ${(state.total - pendingAll).toLocaleString()} of ${state.total.toLocaleString()} songs have a genre.`
    : state.sortedMs > 60000
      ? `✓ Sorting finished in ${minutesText(state.sortedMs)}. Review your genres, then create your playlists.`
      : "✓ Your library is sorted. Review your genres, then create your playlists.";
  document.title = `✓ Ready to review — ${APP_TITLE}`;
  const uncategorized = state.groups.find((g) => g.bucket.id === UNCATEGORIZED.id)?.tracks.length || 0;
  const genreCount = state.groups.filter((g) => ![UNCATEGORIZED.id, NOT_SORTED_YET.id].includes(g.bucket.id)).length;
  const parts = [`${state.total.toLocaleString()} songs in ${genreCount} playlists.`];
  if (state.dupesRemoved) parts.push(`${state.dupesRemoved} duplicate${state.dupesRemoved === 1 ? "" : "s"} skipped.`);
  if (uncategorized) {
    const unsure = state.leftover?.unsure || 0;
    parts.push(`${uncategorized.toLocaleString()} song${uncategorized === 1 ? "" : "s"} Groq couldn't place`
      + (unsure ? `, including ${unsure.toLocaleString()} it wasn't sure enough about to put in a playlist` : "")
      + `${state.leftover?.hasLastfm ? "" : " (a free Last.fm key in Settings can help with these)"}. You can move any song yourself.`);
  }
  if (state.awaitingRecheck) {
    parts.push(`${state.awaitingRecheck.toLocaleString()} song${state.awaitingRecheck === 1 ? " is" : "s are"} still in their previous `
      + `playlist until re-checked${state.groqResumeAt ? ` (after ${formatWhen(state.groqResumeAt)})` : " (next run)"}.`);
  }
  const pending = state.groups.find((g) => g.bucket.id === NOT_SORTED_YET.id)?.tracks.length || 0;
  if (pending) {
    parts.push(`${pending.toLocaleString()} song${pending === 1 ? " isn't" : "s aren't"} sorted yet${state.groqResumeAt
      ? `; run again after ${formatWhen(state.groqResumeAt)} to sort ${pending === 1 ? "it" : "them"}` : ""}.`);
  }
  $("summary").textContent = parts.join(" ");

  // Genres that already have a playlist but no songs now (they all moved elsewhere).
  const shown = new Set(state.groups.map((g) => g.bucket.id));
  const emptied = [...state.nodes, UNCATEGORIZED]
    .filter((b) => !shown.has(b.id) && state.targets.get(b.id) && !state.targets.get(b.id).isNew)
    .map((bucket) => ({ bucket, tracks: [] }));
  const list = $("genre-list");
  list.replaceChildren(...[...state.groups, ...emptied].map(genreRow));
  updateCreateButton();
  show("preview");
}

function topArtists(tracks) {
  const counts = new Map();
  for (const t of tracks) counts.set(t.artistNames[0], (counts.get(t.artistNames[0]) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n).join(", ");
}

function genreRow(group) {
  const { bucket, tracks } = group;
  const li = document.createElement("li");
  li.className = "genre";
  const head = document.createElement("div");
  head.className = "genre-head";

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = state.selected.has(bucket.id);
  box.setAttribute("aria-label", `Include ${bucket.name}`);
  if (bucket.id === NOT_SORTED_YET.id) box.disabled = true; // never made into a playlist
  // A playlist made on an earlier run is always kept up to date, so a song that moved
  // genre can't be left behind in it. To drop it, delete it in Spotify.
  const keptUpToDate = state.targets.get(bucket.id) && !state.targets.get(bucket.id).isNew;
  if (keptUpToDate) {
    box.checked = true;
    box.disabled = true;
    box.title = "Already created, so it's kept up to date. Delete it in Spotify to stop.";
  }
  box.addEventListener("change", () => {
    box.checked ? state.selected.add(bucket.id) : state.selected.delete(bucket.id);
    li.classList.toggle("off", !box.checked);
    updateCreateButton();
  });
  li.classList.toggle("off", !box.checked);

  const text = document.createElement("div");
  text.className = "text";
  text.setAttribute("role", "button");
  text.tabIndex = 0;
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = bucket.name;
  const target = state.targets.get(bucket.id);
  if (bucket.id === NOT_SORTED_YET.id) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = state.groqResumeAt ? `Sorted after ${formatWhen(state.groqResumeAt)}` : "Sorted next run";
    name.append(badge);
  } else if (target && !target.isNew) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = tracks.length ? "Kept up to date" : "Will be emptied";
    name.append(badge);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  const parentName = bucket.parent ? state.nodes.find((n) => n.id === bucket.parent)?.name : "";
  meta.textContent = (parentName ? `${parentName} · ` : "")
    + (tracks.length ? topArtists(tracks) : "Its songs now belong to other playlists.");
  text.append(name, meta);

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = `${tracks.length.toLocaleString()} songs`;

  let songs = null;
  const openSongs = () => {
    songs = document.createElement("ol");
    songs.className = "songs";
    for (const t of tracks) songs.append(songItem(t));
    li.append(songs);
  };
  // Open playlists stay open when the list is redrawn (e.g. after moving a song).
  const toggleSongs = () => {
    if (songs) { songs.remove(); songs = null; state.expanded.delete(bucket.id); return; }
    state.expanded.add(bucket.id);
    openSongs();
  };
  text.addEventListener("click", toggleSongs);
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSongs(); } });

  if (bucket.id === UNCATEGORIZED.id && tracks.length) {
    const again = document.createElement("button");
    again.className = "link again";
    again.textContent = "Ask again";
    again.title = "Ask Groq again about the songs in Uncategorized";
    again.addEventListener("click", (e) => { e.stopPropagation(); askAgain(tracks); });
    head.append(box, text, count, again);
  } else {
    head.append(box, text, count);
  }
  li.append(head);
  if (state.expanded.has(bucket.id) && tracks.length) openSongs();
  return li;
}

/** One song in an open playlist, with a "Move to…" menu. */
function songItem(t) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = `${t.name} — ${t.artistNames.join(", ")}`;
  const mine = state.corrections?.[t.uri];
  if (mine) {
    const tick = document.createElement("span");
    tick.className = "mine";
    tick.textContent = " ✓ your choice";
    label.append(tick);
  }
  const move = document.createElement("select");
  move.className = "move";
  move.setAttribute("aria-label", `Move ${t.name} to another playlist`);
  move.innerHTML = moveOptions(!!mine);
  move.addEventListener("click", (e) => e.stopPropagation());
  move.addEventListener("change", () => moveSong(t, move.value));
  item.append(label, move);
  return item;
}

/** The "Move to…" menu: every playlist (subgenres under their genre), Uncategorized, undo. */
function moveOptions(corrected) {
  state.moveOptionsHtml ||= state.nodes
    .map((n) => `<option value="${n.id}">${n.parent ? "\u00a0\u00a0\u21b3 " : ""}${n.name.replace(/&/g, "&amp;")}</option>`)
    .join("") + '<option value="none">Uncategorized</option>';
  return '<option value="" selected>Move to…</option>'
    + (corrected ? '<option value="__undo">Undo my choice</option>' : "")
    + state.moveOptionsHtml;
}

/**
 * Moves a song to the playlist chosen (or undoes an earlier move). Saved as a correction,
 * which always wins over Groq's answer and is shown to Groq as an example of your taste
 * on later runs. No Groq request; the preview just updates.
 */
function moveSong(t, value) {
  if (!value) return;
  const corrections = state.corrections;
  if (value === "__undo") delete corrections[t.uri];
  else corrections[t.uri] = { playlist: value, at: Date.now() };
  store.set("corrections", corrections);
  applyExistingPlaylists();
  renderPreview();
}

function syncPlan() {
  return planSync(state.groups, state.targets, state.selected, state.nodes);
}

/** Forgets the saved answers for these songs, so the next run asks Groq about them again. */
function askAgain(tracks) {
  if (!confirm(`Ask Groq again about ${tracks.length.toLocaleString()} song${tracks.length === 1 ? "" : "s"} in Uncategorized? `
    + "This uses some of today's Groq allowance. Songs Groq still can't place will stay in Uncategorized.")) return;
  const answers = store.get("songAnswers", {});
  const previous = store.get("songPicks", {});
  const tried = new Set(store.get("lastfmTried", []));
  for (const t of tracks) { delete answers[t.uri]; delete previous[t.uri]; tried.delete(t.uri); }
  store.set("songAnswers", answers);
  store.set("songPicks", previous);
  store.set("lastfmTried", [...tried]);
  scan();
}

function updateCreateButton() {
  const n = syncPlan().length;
  const btn = $("create-btn");
  btn.disabled = n === 0;
  const existing = syncPlan().filter((g) => state.targets.get(g.bucket.id) && !state.targets.get(g.bucket.id).isNew).length;
  btn.textContent = n === 0 ? "Pick at least one genre"
    : existing === n ? `Update ${n} playlist${n === 1 ? "" : "s"}`
      : `Create ${n - existing}${existing ? ` and update ${existing}` : ""} playlist${n === 1 ? "" : "s"}`;
}

// --------------------------------------------------------------------------- creating playlists

let running = false;

async function create() {
  if (running) return;
  running = true;
  $("create-btn").disabled = true;
  try {
    await withRunLock(runSync); // the same lock as reading, so two tabs never overlap
  } catch (err) {
    showError(err);
  } finally {
    running = false;
    updateCreateButton();
  }
}

async function runSync() {
  // Re-resolved inside syncPlaylists; this just decides which playlists to write.
  const { targets } = await resolvePlaylists(api, state.me.id, [...state.nodes, UNCATEGORIZED], nameFor, store.get("playlists", {}));
  state.targets = targets;
  applyExistingPlaylists();
  const groups = syncPlan();
  const remembered = store.get("playlists", {});
  const { results, warnings, retired } = await syncPlaylists(api, {
    userId: state.me.id,
    knownBuckets: [...state.nodes, UNCATEGORIZED],
    groups,
    nameFor,
    isPublic: store.get("public", false),
    remembered,
    remember: (bucketId, info) => {
      remembered[bucketId] = { ...remembered[bucketId], ...info };
      store.set("playlists", remembered);
    },
    onStep: ({ phase, index, total, bucket }) => {
      if (phase === "checking") progress("Checking your existing playlists…", 0, 0, "", STEPS.save);
      else progress(`Saving ${bucket.name}…`, index, total, `Playlist ${index + 1} of ${total}`, STEPS.save);
    },
  });
  showDone(results, warnings, retired);
}

function showDone(results, warnings, retired = []) {
  const made = results.filter((r) => r.isNew).length;
  const same = results.filter((r) => r.unchanged).length;
  const updated = results.length - made - same;
  const bits = [];
  if (made) bits.push(`${made} new playlist${made === 1 ? "" : "s"} created`);
  if (updated) bits.push(`${updated} updated`);
  if (same) bits.push(`${same} already up to date`);
  $("done-summary").textContent = `${bits.join(", ")}. Every song appears in exactly one playlist.`;
  document.title = `✓ Playlists ready — ${APP_TITLE}`;

  $("result-list").replaceChildren(...results.map((r) => {
    const li = document.createElement("li");
    li.className = "genre";
    li.innerHTML = `<div class="genre-head"><div class="text"><div class="name"></div><div class="meta"></div></div><a class="open" target="_blank" rel="noopener">Open ↗</a></div>`;
    li.querySelector(".name").textContent = nameFor(r.bucket);
    li.querySelector(".meta").textContent = r.count === 0 ? "emptied: its songs moved to other genres"
      : `${r.count.toLocaleString()} songs · ${r.isNew ? "new" : r.unchanged ? "no changes" : "updated"}`;
    li.querySelector("a").href = `https://open.spotify.com/playlist/${r.playlistId}`;
    return li;
  }));

  const box = $("warnings");
  box.replaceChildren();
  if (warnings.length) {
    const div = document.createElement("div");
    div.className = "warning";
    div.innerHTML = "<strong>You already had some duplicate playlists.</strong> We updated one of each and left the others alone. You can delete these extra copies in Spotify:<ul></ul>";
    for (const w of warnings) {
      for (const id of w.extraIds) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = `https://open.spotify.com/playlist/${id}`;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = `Extra "${w.bucket.name}" playlist`;
        li.append(a);
        div.querySelector("ul").append(li);
      }
    }
    box.append(div);
  }
  if (retired.length) {
    const div = document.createElement("div");
    div.className = "warning";
    div.innerHTML = "<strong>Some older playlists aren't used any more</strong> (for example after K-Pop and J-Pop were split). "
      + "They've been emptied so no song is in two playlists, and you can delete them in Spotify:<ul></ul>";
    for (const r of retired) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `https://open.spotify.com/playlist/${r.playlistId}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = r.name;
      li.append(a);
      div.querySelector("ul").append(li);
    }
    box.append(div);
  }
  show("done");
}

// --------------------------------------------------------------------------- settings

function openSettings() {
  $("opt-prefix").value = prefix();
  $("opt-public").checked = store.get("public", false);
  $("opt-lastfm").value = store.get("lastfm", "");
  $("opt-groq-key").value = store.get("groqKey", "");
  $("opt-groq-model").value = store.get("groqModel", PREFERRED_MODELS[0]);
  const own = store.get("clientId");
  $("app-source").textContent = own
    ? `Using your own Spotify app (Client ID …${own.slice(-4)}).`
    : "Using the shared Spotify app.";
  $("settings").showModal();
}

function saveSettings() {
  const newPrefix = $("opt-prefix").value;
  const lastfmBefore = store.get("lastfm", "");
  store.set("prefix", newPrefix);
  store.set("public", $("opt-public").checked);
  store.set("lastfm", $("opt-lastfm").value.trim());
  const groqKey = $("opt-groq-key").value.trim();
  const groqModel = $("opt-groq-model").value.trim() || PREFERRED_MODELS[0];
  const groqChanged = groqKey !== store.get("groqKey", "") || groqModel !== store.get("groqModel", PREFERRED_MODELS[0]);
  store.set("groqKey", groqKey);
  store.set("groqModel", groqModel);
  if (!$("screen-preview").hidden) {
    if (store.get("lastfm", "") !== lastfmBefore || groqChanged) scan();
    else showPreview();
  }
}

// --------------------------------------------------------------------------- wiring

function wire() {
  $("login-btn").addEventListener("click", login);
  $("create-btn").addEventListener("click", create);
  $("again-btn").addEventListener("click", showPreview);
  $("retry-btn").addEventListener("click", scan);
  $("save-groq-key").addEventListener("click", saveGroqKey);
  $("budget-continue").addEventListener("click", showPreview);
  $("budget-check").addEventListener("click", () => { clearUsageEstimates(groqLedger(currentModel())); scan(); });
  $("budget-switch").addEventListener("click", () => {
    if (!$("budget-model").value) return;
    store.set("groqModel", $("budget-model").value);
    scan();
  });
  $("cooldown-retry").addEventListener("click", () => {
    if (!confirm("If Spotify is still paused, trying now restarts the wait and can make it longer. Try anyway?")) return;
    const c = store.get("cooldown", null);
    if (c) store.set("cooldown", { ...c, until: Date.now() });
    location.reload(); // a fresh start, so the paused request queue is gone
  });
  $("error-retry").addEventListener("click", () => (store.get("token") ? scan() : show("welcome")));
  $("settings-btn").addEventListener("click", openSettings);
  $("settings").addEventListener("close", () => { if ($("settings").returnValue === "close") saveSettings(); });
  $("select-all").addEventListener("click", () => { state.groups.filter((g) => g.bucket.id !== NOT_SORTED_YET.id).forEach((g) => state.selected.add(g.bucket.id)); renderPreview(); });
  $("select-none").addEventListener("click", () => { state.selected.clear(); renderPreview(); });
  $("copy-uri").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(redirectUri); $("copy-uri").textContent = "Copied"; } catch { /* select manually */ }
  });
  $("save-client-id").addEventListener("click", () => {
    const value = $("client-id-input").value.trim();
    if (!/^[0-9a-f]{32}$/i.test(value)) {
      $("client-id-error").textContent = "That doesn't look like a Client ID. It's 32 letters and numbers, shown on your app's page under Basic Information.";
      $("client-id-error").hidden = false;
      return;
    }
    store.set("clientId", value);
    store.del("token"); // the old login belongs to a different app
    login();
  });
  $("refresh-genres").addEventListener("click", () => {
    if (!confirm("Sort every song again from scratch? This uses Groq's daily allowance again, so a big library may take more than a day.")) return;
    // Your own corrections are kept.
    ["songAnswers", "songPicks", "lastfmTried", "lastfmTags", "lastfmSongTags", "appleGenres"].forEach((k) => store.del(k));
    $("settings").close();
    if (store.get("token")) scan();
  });
  $("logout").addEventListener("click", () => {
    store.del("token");
    $("settings").close();
    show("welcome");
  });
  document.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => {
    if ($("settings").open) $("settings").close();
    el.dataset.go === "setup" ? showSetup() : show(el.dataset.go);
  }));
}

async function start() {
  wire();
  $("own-app-hint").hidden = !sharedClientId;
  // Older versions of the demo saved a fake Client ID under the real app's keys.
  if (!DEMO && /^0{32}$/.test(store.get("clientId", ""))) {
    ["clientId", "token", "artists", "artistsAt", "playlists"].forEach((k) => store.del(k));
  }
  try {
    state.nodes = flattenTaxonomy((await (await fetch(new URL("./taxonomy.json", import.meta.url))).json()).genres);
  } catch {
    return showError(new Error("Couldn't load the genre list. Please refresh the page."));
  }
  try {
    await handleLoginReturn();
  } catch (err) {
    return showError(err);
  }
  // A login saved for a different Spotify app can't be used with this one.
  if (store.get("token")?.clientId !== clientId()) store.del("token");
  // The Groq budget used to be one ledger for all models; it belongs to the model in use.
  const oldLedger = store.get("groqLedger", null);
  if (oldLedger) {
    store.set(`groqLedger:${store.get("groqModel", PREFERRED_MODELS[0])}`, oldLedger);
    store.del("groqLedger");
  }
  if (store.get("token")) return activeCooldown() ? showCooldown() : scan();
  return clientId() ? show("welcome") : showSetup();
}

start();
