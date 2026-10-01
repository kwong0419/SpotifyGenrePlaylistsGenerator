import { CONFIG } from "./config.js";
import {
  createClient, fetchLikedTracks, fetchArtistGenres, dedupeTracks, groupTracks,
  resolvePlaylists, syncPlaylists, SpotifyError, RateLimitedError, UNCATEGORIZED, bucketForGenre,
} from "./core.js";

const ACCOUNTS = "https://accounts.spotify.com";
const SCOPES = "user-library-read playlist-read-private playlist-modify-private playlist-modify-public";
const MIN_SONGS_PRESELECTED = 5;
// tests/demo.html sets __GS_DEMO__ to run against a simulated Spotify. Real visitors
// never have it, so they always use the real Spotify and the real login.
const DEMO = window.__GS_DEMO__ || null;
const fetchImpl = DEMO?.fetch || window.fetch.bind(window);
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
function showPause(ms) {
  const until = Date.now() + ms;
  clearInterval(pauseTimer);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) { clearInterval(pauseTimer); $("progress-hint").textContent = ""; return; }
    $("progress-hint").textContent =
      `Spotify limits how quickly apps can ask for data, so we're taking a short break. Resuming in ${left}s. Your progress is saved.`;
  };
  tick();
  pauseTimer = setInterval(tick, 1000);
}

const api = createClient({ getToken, onUnauthorized: refreshToken, fetchImpl, onWait: showPause });

// --------------------------------------------------------------------------- reading the library

// Saving the whole cache after every artist would be wasteful; at most every 2s is plenty.
let lastSave = 0;
function saveArtists(cache, force = false) {
  if (!force && Date.now() - lastSave < 2000) return;
  lastSave = Date.now();
  store.set("artists", cache);
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

async function scan() {
  try {
    progress("Connecting to Spotify…", 0, 0);
    try {
      state.me = await api.request("GET", "/me");
    } catch (err) {
      if (err instanceof SpotifyError && err.status === 403) return showNotAllowed();
      throw err;
    }

    // A saved copy of Liked Songs is reused when nothing changed, so resuming costs 1 request.
    const { tracks: liked, snapshot } = await fetchLikedTracks(api, (n, total) =>
      progress("Reading your Liked Songs…", n, total, `${n.toLocaleString()} of ${total.toLocaleString()} songs`),
      store.get("liked", null));
    store.set("liked", snapshot);
    const { tracks, removed } = dedupeTracks(liked);
    state.tracks = tracks;
    state.total = tracks.length;
    state.dupesRemoved = removed;

    // Genres found on earlier runs are kept (artists rarely change genre), so only
    // new artists are looked up. Settings → "Re-check artist genres" starts fresh.
    const cache = store.get("artists", {});
    const names = Object.fromEntries(tracks.flatMap((t) => t.artistIds.map((id, i) => [id, t.artistNames[i]])));
    try {
      await fetchArtistGenres(api, tracks, cache, state.buckets, {
        onProgress: (done, total) => progress("Looking up genres…", done, total,
          `${done.toLocaleString()} of ${total.toLocaleString()} artists · ${timeLeft(api.estimateMs(total - done))}. `
          + "Only needed the first time; later runs just check new artists. You can leave this tab in the background."),
        onSaved: (c) => saveArtists(c),
      });
    } finally {
      saveArtists(cache, true);
    }

    // Last.fm helps main artists Spotify can't place: no genres, or none that match a playlist.
    const genres = { ...cache };
    const lastfmKey = store.get("lastfm", "");
    const sortable = (gs) => (gs || []).some((g) => bucketForGenre(g, state.buckets));
    if (lastfmKey) {
      const lfm = store.get("lastfmTags", {});
      const need = [...new Set(tracks.map((t) => t.artistIds[0]))]
        .filter((id) => id && !sortable(genres[id]) && !(id in lfm));
      try {
        for (const [i, id] of need.entries()) {
          progress("Filling in missing genres from Last.fm…", i, need.length, `${i} of ${need.length} artists`);
          const tags = await lastfmTags(names[id], lastfmKey);
          if (tags) lfm[id] = tags;
          if (i % 25 === 0) store.set("lastfmTags", lfm);
          await new Promise((r) => setTimeout(r, 220)); // Last.fm allows about 5 requests a second
        }
      } finally {
        store.set("lastfmTags", lfm);
      }
      for (const id of Object.keys(names)) if (!sortable(genres[id]) && sortable(lfm[id])) genres[id] = lfm[id];
    }

    state.groups = groupTracks(tracks, genres, state.buckets);
    state.selected = new Set(state.groups
      .filter((g) => g.bucket.id !== UNCATEGORIZED.id && g.tracks.length >= MIN_SONGS_PRESELECTED)
      .map((g) => g.bucket.id));
    await showPreview();
  } catch (err) {
    showError(err);
  }
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
  const ms = err.retryAfterMs ?? Math.min(24, 2 ** (strikes - 1)) * 36e5;
  const cooldown = { until: Date.now() + ms, strikes, known: err.retryAfterMs != null };
  store.set("cooldown", cooldown);
  return cooldown;
}

function activeCooldown() {
  const c = store.get("cooldown", null);
  return c && Date.now() < c.until ? c : null;
}

function showCooldown(err) {
  const c = err ? startCooldown(err) : activeCooldown();
  const when = new Date(c.until);
  const sameDay = when.toDateString() === new Date().toDateString();
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("cooldown-when").textContent = `${c.known ? "Spotify says to come back" : "Come back"} after ${sameDay ? time : `${time} tomorrow`}.`;

  const saved = store.get("artists", {});
  const mains = [...new Set((state.tracks || []).map((t) => t.artistIds[0]).filter(Boolean))];
  const done = mains.filter((id) => id in saved).length;
  $("cooldown-progress").textContent = mains.length
    ? `Your progress is saved: ${done.toLocaleString()} of ${mains.length.toLocaleString()} artists checked. Next time picks up from there.`
    : "Everything found so far is saved. Next time picks up from there.";
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
  const parts = [`${state.total.toLocaleString()} songs in ${state.groups.length - (uncategorized ? 1 : 0)} genres.`];
  if (state.dupesRemoved) parts.push(`${state.dupesRemoved} duplicate${state.dupesRemoved === 1 ? "" : "s"} skipped.`);
  if (uncategorized) parts.push(`${uncategorized} song${uncategorized === 1 ? "" : "s"} couldn't be matched to a genre.`);
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
  if (target && !target.isNew) {
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
    // A browser-wide lock stops a second tab from running at the same time.
    if (navigator.locks) {
      const ran = await navigator.locks.request("gs-sync", { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        await runSync();
        return true;
      });
      if (!ran) alert("Genre Sorter is already running in another tab. Let it finish there.");
    } else {
      await runSync();
    }
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
    remember: (bucketId, playlistId) => {
      remembered[bucketId] = { id: playlistId, createdAt: Date.now() };
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
  const updated = results.length - made;
  const bits = [];
  if (made) bits.push(`${made} new playlist${made === 1 ? "" : "s"} created`);
  if (updated) bits.push(`${updated} updated`);
  $("done-summary").textContent = `${bits.join(", ")}. Every song appears once.`;

  $("result-list").replaceChildren(...results.map((r) => {
    const li = document.createElement("li");
    li.className = "genre";
    li.innerHTML = `<div class="genre-head"><div class="text"><div class="name"></div><div class="meta"></div></div><a class="open" target="_blank" rel="noopener">Open ↗</a></div>`;
    li.querySelector(".name").textContent = nameFor(r.bucket);
    li.querySelector(".meta").textContent = `${r.count.toLocaleString()} songs · ${r.isNew ? "new" : "updated"}`;
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
  if (!$("screen-preview").hidden) {
    if (store.get("lastfm", "") !== lastfmBefore) scan();
    else showPreview();
  }
}

// --------------------------------------------------------------------------- wiring

function wire() {
  $("login-btn").addEventListener("click", login);
  $("create-btn").addEventListener("click", create);
  $("again-btn").addEventListener("click", showPreview);
  $("retry-btn").addEventListener("click", scan);
  $("cooldown-retry").addEventListener("click", () => {
    if (!confirm("If Spotify is still paused, trying now restarts the wait and can make it longer. Try anyway?")) return;
    const c = store.get("cooldown", null);
    if (c) store.set("cooldown", { ...c, until: Date.now() });
    location.reload(); // a fresh start, so the paused request queue is gone
  });
  $("error-retry").addEventListener("click", () => (store.get("token") ? scan() : show("welcome")));
  $("settings-btn").addEventListener("click", openSettings);
  $("settings").addEventListener("close", () => { if ($("settings").returnValue === "close") saveSettings(); });
  $("select-all").addEventListener("click", () => { state.groups.forEach((g) => state.selected.add(g.bucket.id)); renderPreview(); });
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
    store.del("artists"); store.del("lastfmTags");
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
