// An in-memory Spotify that misbehaves on purpose (lagging playlist list,
// requests that apply and then report failure). Used by the Node tests and by
// tests/demo.html, which runs the real web app against it.
export const ME = "me123";

export class FakeSpotify {
  constructor({ liked = [], artists = {} } = {}) {
    this.liked = liked;
    this.artists = artists;
    this.playlists = new Map(); // id -> {id, name, description, owner, items[]}
    this.followed = [];          // ids shown by /me/playlists
    this.hiddenFromList = new Set(); // simulates list lag after a create
    this.failAfterApply = 0;     // next N item POSTs apply, then return 502
    this.creates = 0;
    this.rateLimitNext = 0;      // next N requests get a 429 with no readable Retry-After
    this.quotaExceeded = false;  // every request gets Spotify's QUOTA_EXCEEDED 429
    this.artistLookups = 0;
    this.log = [];               // "METHOD /path" of every request
  }
  addPlaylist(p) {
    const pl = { owner: { id: ME }, items: [], description: "", version: 0, ...p };
    this.playlists.set(pl.id, pl);
    this.followed.push(pl.id);
    return pl;
  }
  json(status, body, headers = {}) {
    return { ok: status < 400, status, headers: { get: (k) => headers[k] ?? null },
      text: async () => (body === undefined ? "" : JSON.stringify(body)) };
  }
  page(items, offset, limit, path) {
    const slice = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? `${path}?offset=${offset + limit}&limit=${limit}` : null;
    return { items: slice, next, total: items.length };
  }
  fetch = async (url, { method, body }) => {
    const u = new URL(url);
    const path = u.pathname.replace("/v1", "");
    const offset = +(u.searchParams.get("offset") || 0);
    const limit = +(u.searchParams.get("limit") || 20);
    const data = body ? JSON.parse(body) : null;
    this.log.push(`${method} ${path}`);
    if (this.quotaExceeded) {
      return this.json(429, { error: { status: 429, message: "Quota exceeded", reason: "QUOTA_EXCEEDED" } });
    }
    if (this.rateLimitNext > 0) { this.rateLimitNext--; return this.json(429, { error: { message: "rate limited" } }); }
    let m;
    if (method === "GET" && path === "/me") return this.json(200, { id: ME, display_name: "Test User" });
    if (method === "GET" && path === "/me/tracks") return this.json(200, this.page(this.liked, offset, limit, url.split("?")[0]));
    if (method === "GET" && (m = path.match(/^\/artists\/(\w+)$/)) && ++this.artistLookups) return this.json(200, { id: m[1], name: m[1], genres: this.artists[m[1]] || [] });
    if (method === "GET" && path === "/me/playlists") {
      const visible = this.followed.filter((id) => !this.hiddenFromList.has(id)).map((id) => {
        const { items, version, ...meta } = this.playlists.get(id); return { ...meta, snapshot_id: `v${version}` };
      });
      return this.json(200, this.page(visible, offset, limit, url.split("?")[0]));
    }
    if (method === "POST" && path === "/me/playlists") {
      this.creates++;
      const pl = this.addPlaylist({ id: `pl${this.creates}`, ...data });
      return this.json(201, { id: pl.id });
    }
    if ((m = path.match(/^\/playlists\/(\w+)$/))) {
      const pl = this.playlists.get(m[1]);
      if (!pl) return this.json(404, { error: { message: "not found" } });
      if (method === "GET") {
        const { items, version, ...meta } = pl;
        return this.json(200, { ...meta, snapshot_id: `v${version}`, items: { total: items.length } });
      }
      Object.assign(pl, data); return this.json(200);
    }
    if ((m = path.match(/^\/playlists\/(\w+)\/items$/))) {
      const pl = this.playlists.get(m[1]);
      if (method === "GET") return this.json(200, this.page(pl.items.map((uri) => ({ item: { uri } })), offset, limit, url.split("?")[0]));
      if (method === "PUT") { pl.items = [...data.uris]; pl.version++; return this.json(200, { snapshot_id: `v${pl.version}` }); }
      if (method === "POST") {
        pl.items.push(...data.uris);
        pl.version++;
        if (this.failAfterApply > 0) { this.failAfterApply--; return this.json(502); }
        return this.json(201, { snapshot_id: `v${pl.version}` });
      }
    }
    return this.json(404, { error: { message: `no route ${method} ${path}` } });
  };
  /** The user adds a song to a playlist in the Spotify app. */
  userAdds(playlistId, uri) {
    const pl = this.playlists.get(playlistId);
    pl.items.push(uri);
    pl.version++;
  }
}

// A realistic-looking library for the browser demo.
export function demoLibrary() {
  const artists = {
    "Kendrick Lamar": ["conscious hip hop", "hip hop", "rap", "west coast rap"],
    "Phoebe Bridgers": ["indie pop", "la indie", "folk-pop"],
    "Bad Bunny": ["reggaeton", "trap latino", "urbano latino"],
    "Taylor Swift": ["pop"],
    "Fred again..": ["edm", "house", "stutter house"],
    "SZA": ["pop", "r&b", "rap"],
    "Arctic Monkeys": ["garage rock", "modern rock", "permanent wave", "rock"],
    "Zach Bryan": ["classic oklahoma country"],
    "NewJeans": ["k-pop", "k-pop girl group"],
    "Burna Boy": ["afrobeats", "nigerian pop"],
    "Bill Evans": ["cool jazz", "jazz", "jazz piano"],
    "Small Local Band": [],
  };
  const titles = ["Midnight", "Golden Hour", "Paper Planes", "Runaway", "Satellite", "Echoes", "Wildfire",
    "Neon Lights", "Daydream", "Silver Lining", "After Hours", "Ocean Drive", "Heartbeat", "Northern Star"];
  const liked = [];
  let i = 0;
  const names = Object.keys(artists);
  names.forEach((artist, a) => {
    const n = [22, 14, 12, 18, 9, 11, 8, 6, 7, 4, 3, 5][a];
    for (let k = 0; k < n; k++) {
      liked.push({
        added_at: new Date(Date.UTC(2026, 8, 30) - i * 864e5).toISOString(),
        track: { id: `t${i}`, uri: `spotify:track:t${i}`, name: `${titles[k % titles.length]}${k >= titles.length ? " II" : ""}`,
          type: "track", artists: [{ id: artist.replace(/\W/g, ""), name: artist }] },
      });
      i++;
    }
  });
  // The same song liked twice: once from the single, once from the album remaster.
  liked.push({ added_at: "2025-01-01T00:00:00Z", track: { id: "dup1", uri: "spotify:track:dup1",
    name: "Midnight - 2024 Remaster", type: "track", artists: [{ id: "TaylorSwift", name: "Taylor Swift" }] } });
  return { liked, artists: Object.fromEntries(names.map((n) => [n.replace(/\W/g, ""), artists[n]])) };
}
