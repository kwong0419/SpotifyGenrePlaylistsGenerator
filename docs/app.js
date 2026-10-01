import { CONFIG } from "./config.js";
import {
  createClient, fetchLikedTracks, dedupeTracks, groupTracks, bucketForTags,
  resolvePlaylists, syncPlaylists, SpotifyError, RateLimitedError, UNCATEGORIZED, NOT_SORTED_YET,
} from "./core.js";
import {
  createGroq, chooseModel, tagArtists, tagSongs, GroqError, GroqDailyLimitError, PREFERRED_MODELS,
} from "./groq.js";

const ACCOUNTS = "https://accounts.spotify.com";
const SCOPES = "user-library-read playlist-read-private playlist-modify-private playlist-modify-public";
const MIN_SONGS_PRESELECTED = 5;
// tests/demo.html sets __GS_DEMO__ to run against a simulated Spotify. Real visitors
// never have it, so they always use the real Spotify and the real login.
const DEMO = window.__GS_DEMO__ || null;
const fetchImpl = DEMO?.fetch || window.fetch.bind(window);
const groqFetch = DEMO?.groqFetch || window.fetch.bind(window);
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

const state = { me: null, buckets: [], groups: [], targets: new Map(), selected: new Set(), dupesRemoved: 0, total: 0 };

const clientId = () => store.get("clientId") || sharedClientId;
const prefix = () => store.get("prefix", "Liked · ");
const nameFor = (bucket) => prefix() + bucket.name;

// --------------------------------------------------------------------------- screens

function show(name) {
  document.querySelectorAll("main > section").forEach((s) => { s.hidden = s.id !== `screen-${name}`; });
  $("settings-btn").hidden = !store.get("token");
  window.scrollTo(0, 0);
}

function progress(title, done, total, text = "") {
  show("progress");
  $("progress-title").textContent = title;
  $("progress-fill").style.width = total ? `${Math.min(100, (done / total) * 100)}%` : "8%";
  $("progress-text").textContent = text;
  $("progress-hint").textContent = "";
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
function showPause(ms, service = "Spotify") {
  const until = Date.now() + ms;
  clearInterval(pauseTimer);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) { clearInterval(pauseTimer); $("progress-hint").textContent = ""; return; }
    $("progress-hint").textContent =
      `${service} limits how quickly apps can ask for data, so we're taking a short break. Resuming in ${left}s. Your progress is saved.`;
  };
  tick();
  pauseTimer = setInterval(tick, 1000);
}

const api = createClient({ getToken, onUnauthorized: refreshToken, fetchImpl, onWait: showPause });

// --------------------------------------------------------------------------- Groq

function groqClient(key = store.get("groqKey", ""), model = store.get("groqModel", PREFERRED_MODELS[0])) {
  if (!key) return null;
  return createGroq({
    apiKey: key, model, fetchImpl: groqFetch,
    // Shared by every tab via localStorage, so the daily budget holds across reloads.
    ledger: { load: () => store.get("groqLedger", []), save: (e) => store.set("groqLedger", e) },
    onWait: (ms) => showPause(ms, "Groq"),
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
  progress("Connecting to Spotify…", 0, 0);
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
    progress("Reading your Liked Songs…", n, total, `${n.toLocaleString()} of ${total.toLocaleString()} songs`),
    store.get("liked", null));
  store.set("liked", snapshot);
  const { tracks, removed } = dedupeTracks(liked);
  state.tracks = tracks;
  state.total = tracks.length;
  state.dupesRemoved = removed;

  // One entry per main artist (a song is sorted by its main artist), with a couple of
  // their song titles so the model can tell apart artists who share a name.
  const artists = new Map();
  for (const t of tracks) {
    const id = t.artistIds[0];
    if (!id) continue;
    const a = artists.get(id) || { id, name: t.artistNames[0], titles: [], songCount: 0 };
    a.songCount++;
    if (a.titles.length < 2) a.titles.push(t.name);
    artists.set(id, a);
  }

  // Genres Spotify gave us on earlier runs are still good and cost nothing to reuse.
  const spotifyGenres = store.get("artists", {});
  const sortable = (tags) => !!bucketForTags(tags, state.buckets);
  const artistTags = store.get("artistTags", {});
  const songTags = store.get("songTags", {});
  let paused = null;

  try {
    const need = [...artists.values()].filter((a) => !sortable(spotifyGenres[a.id]));
    await tagArtists(groq, need, artistTags, {
      onProgress: (done, total) => progress("Sorting your artists…", done, total,
        `${done.toLocaleString()} of ${total.toLocaleString()} artists · ${timeLeft((total - done) * 30 / groq.budget().tpm * 60000)}. `
        + "Only needed the first time; later runs just sort new artists. You can leave this tab in the background."),
      onSaved: (c) => saveThrottled("artistTags", c),
    });

    // Artists whose songs span different genres: sort those songs one by one.
    const songs = tracks
      .filter((t) => artistTags[t.artistIds[0]]?.mixed)
      .map((t) => ({ uri: t.uri, title: t.name, artist: t.artistNames[0] }));
    await tagSongs(groq, songs, songTags, {
      onProgress: (done, total) => progress("Sorting songs by artists who mix genres…", done, total,
        `${done.toLocaleString()} of ${total.toLocaleString()} songs · ${timeLeft((total - done) * 24 / groq.budget().tpm * 60000)}`),
      onSaved: (c) => saveThrottled("songTags", c),
    });
  } catch (err) {
    if (!(err instanceof GroqDailyLimitError)) throw err;
    paused = err;
  } finally {
    saveThrottled("artistTags", artistTags, true);
    saveThrottled("songTags", songTags, true);
  }

  // Everything known about each main artist, best source first.
  const genres = {};
  for (const id of artists.keys()) {
    genres[id] = sortable(spotifyGenres[id]) ? spotifyGenres[id] : artistTags[id]?.tags || [];
  }

  // Last.fm helps artists the model didn't know (optional; real listener tags).
  const lastfmKey = store.get("lastfm", "");
  if (lastfmKey) {
    const lfm = store.get("lastfmTags", {});
    const need = [...artists.values()].filter((a) => a.id in artistTags && !sortable(genres[a.id]) && !(a.id in lfm));
    try {
      for (const [i, a] of need.entries()) {
        progress("Filling in missing genres from Last.fm…", i, need.length, `${i} of ${need.length} artists`);
        const tags = await lastfmTags(a.name, lastfmKey);
        if (tags) lfm[a.id] = tags;
        if (i % 25 === 0) store.set("lastfmTags", lfm);
        await new Promise((r) => setTimeout(r, 220)); // Last.fm allows about 5 requests a second
      }
    } finally {
      store.set("lastfmTags", lfm);
    }
    for (const id of artists.keys()) if (!sortable(genres[id]) && sortable(lfm[id])) genres[id] = lfm[id];
  }

  const songGenres = Object.fromEntries(Object.entries(songTags).map(([uri, v]) => [uri, v.tags]));
  const isPending = (t) => !!t.artistIds[0] && !sortable(spotifyGenres[t.artistIds[0]]) && !(t.artistIds[0] in artistTags);
  state.groups = groupTracks(tracks, genres, state.buckets, { songGenres, isPending });
  state.selected = new Set(state.groups
    .filter((g) => ![UNCATEGORIZED.id, NOT_SORTED_YET.id].includes(g.bucket.id) && g.tracks.length >= MIN_SONGS_PRESELECTED)
    .map((g) => g.bucket.id));
  state.groqResumeAt = paused?.resumeAt || null;

  if (paused) {
    const unsorted = [...artists.keys()].filter((id) => !sortable(spotifyGenres[id]) && !(id in artistTags)).length;
    return showGroqPaused(paused, artists.size - unsorted, artists.size);
  }
  return showPreview();
}

/** Groq's daily allowance ran out: say when it resets, and offer to go ahead with what's sorted. */
function showGroqPaused(err, sortedArtists, totalArtists) {
  const pendingSongs = state.groups.find((g) => g.bucket.id === NOT_SORTED_YET.id)?.tracks.length || 0;
  $("budget-when").textContent = `Groq's free allowance frees up again after ${formatWhen(err.resumeAt)}.`;
  $("budget-progress").textContent = pendingSongs
    ? `${sortedArtists.toLocaleString()} of ${totalArtists.toLocaleString()} artists are sorted, covering `
      + `${(state.total - pendingSongs).toLocaleString()} of ${state.total.toLocaleString()} songs. Artists with the most songs went first.`
    : "All your artists are sorted. A few songs by artists who mix genres will be fine-tuned next time.";
  show("budget");
}

function formatWhen(ts) {
  const when = new Date(ts);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return when.toDateString() === new Date().toDateString() ? time : `${time} tomorrow`;
}

function timeLeft(ms) {
  const min = Math.round(ms / 60000);
  return min < 1 ? "less than a minute left" : `about ${min} minute${min === 1 ? "" : "s"} left`;
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
  progress("Checking your existing playlists…", 0, 0);
  try {
    const { targets } = await resolvePlaylists(api, state.me.id, state.groups.map((g) => g.bucket), nameFor,
      store.get("playlists", {}));
    state.targets = targets;
  } catch {
    state.targets = new Map(); // only used for the New/Update labels
  }
  renderPreview();
}

function renderPreview() {
  const uncategorized = state.groups.find((g) => g.bucket.id === UNCATEGORIZED.id)?.tracks.length || 0;
  const genreCount = state.groups.filter((g) => ![UNCATEGORIZED.id, NOT_SORTED_YET.id].includes(g.bucket.id)).length;
  const parts = [`${state.total.toLocaleString()} songs in ${genreCount} genres.`];
  if (state.dupesRemoved) parts.push(`${state.dupesRemoved} duplicate${state.dupesRemoved === 1 ? "" : "s"} skipped.`);
  if (uncategorized) parts.push(`${uncategorized} song${uncategorized === 1 ? "" : "s"} couldn't be matched to a genre.`);
  const pending = state.groups.find((g) => g.bucket.id === NOT_SORTED_YET.id)?.tracks.length || 0;
  if (pending) {
    parts.push(`${pending.toLocaleString()} song${pending === 1 ? " isn't" : "s aren't"} sorted yet${state.groqResumeAt
      ? `; run again after ${formatWhen(state.groqResumeAt)} to sort ${pending === 1 ? "it" : "them"}` : ""}.`);
  }
  $("summary").textContent = parts.join(" ");

  const list = $("genre-list");
  list.replaceChildren(...state.groups.map(genreRow));
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
    badge.textContent = "Updates existing";
    name.append(badge);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = topArtists(tracks);
  text.append(name, meta);

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = `${tracks.length.toLocaleString()} songs`;

  let songs = null;
  const toggleSongs = () => {
    if (songs) { songs.remove(); songs = null; return; }
    songs = document.createElement("ol");
    songs.className = "songs";
    for (const t of tracks) {
      const s = document.createElement("li");
      s.textContent = `${t.name} — ${t.artistNames.join(", ")}`;
      songs.append(s);
    }
    li.append(songs);
  };
  text.addEventListener("click", toggleSongs);
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSongs(); } });

  head.append(box, text, count);
  li.append(head);
  return li;
}

function updateCreateButton() {
  const n = state.selected.size;
  const btn = $("create-btn");
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? "Pick at least one genre" : `Create ${n} playlist${n === 1 ? "" : "s"}`;
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
  const groups = state.groups.filter((g) => state.selected.has(g.bucket.id));
  const remembered = store.get("playlists", {});
  const { results, warnings } = await syncPlaylists(api, {
    userId: state.me.id,
    groups,
    nameFor,
    isPublic: store.get("public", false),
    remembered,
    remember: (bucketId, info) => {
      remembered[bucketId] = { ...remembered[bucketId], ...info };
      store.set("playlists", remembered);
    },
    onStep: ({ phase, index, total, bucket }) => {
      if (phase === "checking") progress("Checking your existing playlists…", 0, 0);
      else progress(`Saving ${bucket.name}…`, index, total, `Playlist ${index + 1} of ${total}`);
    },
  });
  showDone(results, warnings);
}

function showDone(results, warnings) {
  const made = results.filter((r) => r.isNew).length;
  const same = results.filter((r) => r.unchanged).length;
  const updated = results.length - made - same;
  const bits = [];
  if (made) bits.push(`${made} new playlist${made === 1 ? "" : "s"} created`);
  if (updated) bits.push(`${updated} updated`);
  if (same) bits.push(`${same} already up to date`);
  $("done-summary").textContent = `${bits.join(", ")}. Every song appears once.`;

  $("result-list").replaceChildren(...results.map((r) => {
    const li = document.createElement("li");
    li.className = "genre";
    li.innerHTML = `<div class="genre-head"><div class="text"><div class="name"></div><div class="meta"></div></div><a class="open" target="_blank" rel="noopener">Open ↗</a></div>`;
    li.querySelector(".name").textContent = nameFor(r.bucket);
    li.querySelector(".meta").textContent = `${r.count.toLocaleString()} songs · ${r.isNew ? "new" : r.unchanged ? "no changes" : "updated"}`;
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
    if (!confirm("Sort every artist again from scratch? This uses Groq's daily allowance again, so a big library may take more than a day.")) return;
    ["artists", "artistTags", "songTags", "lastfmTags"].forEach((k) => store.del(k));
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
    state.buckets = (await (await fetch(new URL("./genres.json", import.meta.url))).json()).buckets;
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
  if (store.get("token")) return activeCooldown() ? showCooldown() : scan();
  return clientId() ? show("welcome") : showSetup();
}

start();
