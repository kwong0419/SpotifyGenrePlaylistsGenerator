#!/usr/bin/env python3
"""Sort your Spotify Liked Songs into one playlist per genre (command-line version).

The web app in docs/ does the same thing with buttons; this script is for people
who prefer a terminal. Both use docs/genres.json and recognise each other's playlists.

Spotify has no genre on tracks, only on artists, so each song takes the genres
of its main artist. Spotify's micro-genres ("chicago drill", "bedroom pop") are
folded into broad buckets defined in docs/genres.json.

Usage:
    python spotify_genres.py --dry-run        # preview, creates nothing
    python spotify_genres.py                  # create / update the playlists
    python spotify_genres.py --list-genres    # show raw Spotify genres you have
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse
import webbrowser
from collections import Counter, defaultdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / ".cache"
TOKEN_FILE = CACHE_DIR / "token.json"
ARTIST_CACHE_FILE = CACHE_DIR / "artists.json"
PLAYLIST_STATE_FILE = CACHE_DIR / "playlists.json"
LIKED_CACHE_FILE = CACHE_DIR / "liked.json"

API = "https://api.spotify.com/v1"
ACCOUNTS = "https://accounts.spotify.com"
# playlist-read-private lets us see our own private playlists, which is how
# existing ones are found instead of being created again.
SCOPES = "user-library-read playlist-read-private playlist-modify-private playlist-modify-public"
UNCATEGORIZED = {"id": "uncategorized", "name": "Uncategorized", "keywords": []}
RECENT_CREATE_SECONDS = 3600
MIN_GAP_SECONDS = 0.4          # steady spacing between requests, see Spotify.request
START_GAP_SECONDS = 0.8
MAX_SHORT_WAIT = 120           # a longer Retry-After means a lockout: stop instead of waiting


class RateLimitedError(RuntimeError):
    """Spotify has locked this app out for a while. Requests during a lockout can extend
    it, so the script stops instead of retrying."""

    def __init__(self, retry_after: int | None):
        self.retry_after = retry_after
        if retry_after is None:
            wait = "a few hours"
        else:
            h, m = divmod(retry_after // 60 + 1, 60)
            wait = f"{h}h {m}m" if h else f"{m} minutes"
        super().__init__(
            f"Spotify has paused this app for sending too many requests. Spotify says to wait {wait}"
            if retry_after is not None else
            f"Spotify has paused this app for sending too many requests. Wait {wait}")
        self.message = (f"{self.args[0]} before running again; trying sooner can make the pause longer. "
                        "Progress is saved in .cache/, so the next run picks up where this one stopped.")


class AmbiguousWriteError(RuntimeError):
    """Spotify failed in a way that leaves it unknown whether the write was applied."""


# --------------------------------------------------------------------------- config

def load_dotenv(path: Path = ROOT / ".env") -> None:
    """Minimal .env reader so the only dependency is `requests`."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, data) -> None:
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


# --------------------------------------------------------------------------- auth (PKCE)

class _CallbackHandler(BaseHTTPRequestHandler):
    result: dict = {}

    def do_GET(self):  # noqa: N802
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        _CallbackHandler.result = {k: v[0] for k, v in query.items()}
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h2>Spotify login complete. You can close this tab.</h2>")

    def log_message(self, *args):
        pass


def _login(client_id: str, redirect_uri: str) -> dict:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    url = f"{ACCOUNTS}/authorize?" + urllib.parse.urlencode({
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": SCOPES,
        "state": state,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
    })

    parsed = urllib.parse.urlparse(redirect_uri)
    server = HTTPServer((parsed.hostname, parsed.port), _CallbackHandler)
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    print("Opening Spotify login in your browser. If it doesn't open, visit:\n" + url)
    webbrowser.open(url)
    thread.join(timeout=300)
    server.server_close()

    result = _CallbackHandler.result
    if result.get("state") != state or "code" not in result:
        sys.exit(f"Login failed: {result.get('error', 'no authorization code received')}")

    resp = requests.post(f"{ACCOUNTS}/api/token", data={
        "grant_type": "authorization_code",
        "code": result["code"],
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": verifier,
    }, timeout=30)
    resp.raise_for_status()
    return resp.json()


class Spotify:
    def __init__(self, client_id: str, redirect_uri: str):
        self.client_id = client_id
        self.redirect_uri = redirect_uri
        self.session = requests.Session()
        self.gap = START_GAP_SECONDS
        self.last_request = 0.0
        self.ok_streak = 0
        self.token = read_json(TOKEN_FILE, None)
        if not self.token or self.token.get("scope_requested") != SCOPES:
            self._save_token(_login(client_id, redirect_uri))

    def _save_token(self, token: dict) -> None:
        if self.token and "refresh_token" not in token:
            token["refresh_token"] = self.token["refresh_token"]
        token["expires_at"] = time.time() + token["expires_in"] - 60
        token["scope_requested"] = SCOPES
        self.token = token
        write_json(TOKEN_FILE, token)

    def _refresh(self) -> None:
        resp = requests.post(f"{ACCOUNTS}/api/token", data={
            "grant_type": "refresh_token",
            "refresh_token": self.token["refresh_token"],
            "client_id": self.client_id,
        }, timeout=30)
        if resp.status_code == 400:  # refresh token revoked/expired: log in again
            self.token = None
            self._save_token(_login(self.client_id, self.redirect_uri))
            return
        resp.raise_for_status()
        self._save_token(resp.json())

    def request(self, method: str, path: str, **kwargs):
        """Spotify limits each app's requests over a rolling 30s window. Requests are spaced
        out (the gap doubles on each 429 and slowly shrinks while things go well), and on a
        429 we wait as long as Spotify says, or back off 10s, 20s, 40s... up to 2 min.

        429 is always retried (nothing was applied). 5xx and network errors are only
        retried for GET/PUT, which are safe to repeat; a POST that adds songs may already
        have gone through, so it raises AmbiguousWriteError instead."""
        url = path if path.startswith("http") else API + path
        repeatable = method in ("GET", "PUT")
        failures, limited, refreshed = 0, 0, False
        while True:
            pause = self.last_request + self.gap - time.time()
            if pause > 0:
                time.sleep(pause)
            self.last_request = time.time()
            if time.time() >= self.token["expires_at"]:
                self._refresh()
            headers = {"Authorization": f"Bearer {self.token['access_token']}"}
            try:
                resp = self.session.request(method, url, headers=headers, timeout=30, **kwargs)
            except requests.RequestException as err:
                if repeatable and failures < 4:
                    time.sleep(2 ** failures)
                    failures += 1
                    continue
                raise AmbiguousWriteError(f"{method} {path}: {err}") from err
            if resp.status_code == 401 and not refreshed:
                refreshed = True
                self._refresh()
                continue
            if resp.status_code == 429:
                self.gap = min(5.0, self.gap * 2)
                self.ok_streak = 0
                limited += 1
                header = resp.headers.get("Retry-After", "")
                if header.isdigit() and int(header) > MAX_SHORT_WAIT or not header.isdigit() and limited > 2:
                    raise RateLimitedError(int(header) if header.isdigit() else None)
                wait = int(header) + 1 if header.isdigit() else 30 * limited
                print(f"\n  Spotify asked us to slow down, waiting {wait}s (progress is saved)...")
                time.sleep(wait)
                continue
            if resp.status_code >= 500:
                if repeatable and failures < 4:
                    time.sleep(2 ** failures)
                    failures += 1
                    continue
                raise AmbiguousWriteError(f"{method} {path} -> {resp.status_code}")
            self.ok_streak += 1
            if self.ok_streak >= 20 and self.gap > MIN_GAP_SECONDS:
                self.gap = max(MIN_GAP_SECONDS, self.gap * 0.85)
                self.ok_streak = 0
            if not resp.ok:
                raise RuntimeError(f"{method} {path} -> {resp.status_code}: {resp.text[:300]}")
            return resp.json() if resp.content else None

    def all_pages(self, path: str) -> list:
        items, url = [], path
        while url:
            page = self.request("GET", url)
            items.extend(page["items"])
            url = page.get("next")
        return items


# --------------------------------------------------------------------------- data

def _to_track(entry: dict) -> dict | None:
    track = entry.get("track") or entry.get("item")
    if not track or not track.get("id") or track.get("is_local"):
        return None  # local files and unavailable tracks can't go in playlists
    return {
        "uri": track["uri"],
        "name": track["name"],
        "artist_ids": [a["id"] for a in track["artists"] if a.get("id")],
        "artist_names": [a["name"] for a in track["artists"]],
    }


def fetch_liked_tracks(sp: Spotify) -> list[dict]:
    """Liked Songs, newest first. If the song count and the 50 newest songs match the copy
    saved last run, that copy is reused, so a resumed run costs one request, not ~150."""
    first = sp.request("GET", "/me/tracks?limit=50")
    first_uris = [((e.get("track") or e.get("item")) or {}).get("uri") for e in first["items"]]
    saved = read_json(LIKED_CACHE_FILE, None)
    if saved and saved["total"] == first["total"] and saved["first_uris"] == first_uris:
        print(f"  {len(saved['tracks'])} liked songs (unchanged since last run)")
        return saved["tracks"]
    tracks = [t for e in first["items"] if (t := _to_track(e))]
    url = first.get("next")
    while url:
        page = sp.request("GET", url)
        tracks.extend(t for e in page["items"] if (t := _to_track(e)))
        url = page.get("next")
        print(f"\r  fetched {len(tracks)} liked songs", end="", flush=True)
    print()
    write_json(LIKED_CACHE_FILE, {"total": first["total"], "first_uris": first_uris, "tracks": tracks})
    return tracks  # newest liked first, the same order as Liked Songs


def song_key(track: dict) -> str:
    """'Song - 2011 Remaster' and 'Song (Remastered)' are the same song."""
    title = track["name"].lower()
    title = re.sub(r"\s+-\s+.*remaster.*$", "", title)
    title = re.sub(r"\s*[(\[][^)\]]*remaster[^)\]]*[)\]]", "", title)
    title = re.sub(r"\s+", " ", title).strip()
    artist = track["artist_ids"][0] if track["artist_ids"] else track["artist_names"][0]
    return f"{title}|{artist}"


def dedupe_tracks(tracks: list[dict]) -> tuple[list[dict], int]:
    """Drops the same track liked twice and the same song saved from different releases
    (single vs album, explicit vs clean, remasters). Keeps the most recently liked copy."""
    seen_uri, seen_song, kept = set(), set(), []
    for t in tracks:
        key = song_key(t)
        if t["uri"] in seen_uri or key in seen_song:
            continue
        seen_uri.add(t["uri"])
        seen_song.add(key)
        kept.append(t)
    return kept, len(tracks) - len(kept)


def lastfm_tags(artist_name: str, api_key: str) -> list[str] | None:
    """Fallback for artists Spotify can't place. None means Last.fm couldn't be asked
    (nothing is cached, so it's retried next run); a rejected key stops the script."""
    try:
        data = requests.get("https://ws.audioscrobbler.com/2.0/", params={
            "method": "artist.gettoptags", "artist": artist_name,
            "api_key": api_key, "format": "json",
        }, timeout=15).json()
    except (requests.RequestException, ValueError):
        return None
    if data.get("error") in (10, 26):
        sys.exit("Last.fm didn't accept LASTFM_API_KEY. Fix it in .env, or remove it to skip Last.fm.")
    if data.get("error") == 6:  # Last.fm doesn't know this artist
        return []
    if data.get("error"):
        return None
    tags = data.get("toptags", {}).get("tag", [])
    # Keep only tags with meaningful weight; Last.fm also has junk like "seen live".
    return [t["name"].lower() for t in tags[:5] if int(t.get("count", 0)) >= 20]


def fetch_artist_genres(sp: Spotify, tracks: list[dict], buckets: list[dict],
                        lastfm_key: str | None) -> dict[str, list[str]]:
    """Artist id -> genres, cached on disk. Spotify only allows one artist per request now,
    so only main artists are looked up, plus featured artists of songs whose main artist
    has no usable genre (songs are sorted by their main artist)."""
    cache: dict[str, dict] = read_json(ARTIST_CACHE_FILE, {})
    names = {}
    for t in tracks:
        names.update(zip(t["artist_ids"], t["artist_names"]))

    def look_up(ids):
        missing = [aid for aid in dict.fromkeys(ids) if aid not in cache]
        try:
            for i, aid in enumerate(missing, 1):
                artist = sp.request("GET", f"/artists/{aid}")
                cache[aid] = {"name": artist["name"], "genres": artist.get("genres") or [], "source": "spotify"}
                print(f"\r  artists {i}/{len(missing)}", end="", flush=True)
                if i % 25 == 0:
                    write_json(ARTIST_CACHE_FILE, cache)
        finally:
            write_json(ARTIST_CACHE_FILE, cache)  # keep progress even if Spotify stops us
        if missing:
            print()

    def sortable(aid):
        return aid in cache and any(bucket_for_genre(g, buckets) for g in cache[aid]["genres"])

    look_up(t["artist_ids"][0] for t in tracks if t["artist_ids"])
    look_up(aid for t in tracks if t["artist_ids"] and not sortable(t["artist_ids"][0]) for aid in t["artist_ids"][1:])

    if lastfm_key:
        main = {t["artist_ids"][0] for t in tracks if t["artist_ids"]}
        need = [aid for aid in main if not sortable(aid) and cache[aid]["source"] != "lastfm"]
        if need:
            print(f"  asking Last.fm about {len(need)} artists Spotify has no genres for")
        for aid in need:
            tags = lastfm_tags(cache[aid]["name"], lastfm_key)
            if tags is not None:
                if any(bucket_for_genre(g, buckets) for g in tags):
                    cache[aid]["genres"] = tags
                cache[aid]["source"] = "lastfm"
            time.sleep(0.2)

    write_json(ARTIST_CACHE_FILE, cache)
    return {aid: cache[aid]["genres"] for aid in names if aid in cache}


# --------------------------------------------------------------------------- classification

def load_buckets(path: Path) -> list[dict]:
    data = read_json(path, None)
    if not data:
        sys.exit(f"Could not read genre buckets from {path}")
    return [{**b, "keywords": [k.lower() for k in b["keywords"]]} for b in data["buckets"]]


def bucket_for_genre(genre: str, buckets: list[dict]) -> dict | None:
    genre = genre.lower()
    return next((b for b in buckets if any(k in genre for k in b["keywords"])), None)


def classify_track(track: dict, artist_genres: dict, buckets: list[dict]) -> dict:
    """The single bucket a track belongs to: the one most of its main artist's genres map to."""
    # Featured artists are only consulted when the main artist has no usable genres.
    for aid in track["artist_ids"]:
        votes = Counter(b["id"] for g in artist_genres.get(aid, []) if (b := bucket_for_genre(g, buckets)))
        if votes:
            top = max(votes.values())
            return next(b for b in buckets if votes.get(b["id"]) == top)  # ties: earlier bucket
    return UNCATEGORIZED


# --------------------------------------------------------------------------- playlists
# Same rules as docs/core.js, so the script and the web app share playlists.

def tag_for(bucket_id: str) -> str:
    return f"[gs:{bucket_id}]"


def description_for(bucket: dict) -> str:
    return f"Your {bucket['name']} songs from Liked Songs, sorted by Genre Sorter. {tag_for(bucket['id'])}"


def resolve_playlists(sp: Spotify, user_id: str, buckets: list[dict], name_for, remembered: dict):
    """Bucket id -> existing playlist id (or None to create). Matches, in order: a playlist
    you own tagged with the bucket id; one you own with exactly the expected name; one this
    script created within the hour (Spotify's playlist list can lag behind a create).
    Extra matches mean duplicates already exist: one is used and the rest are reported."""
    owned = [p for p in sp.all_pages("/me/playlists?limit=50") if p and (p.get("owner") or {}).get("id") == user_id]
    targets, warnings = {}, []
    for bucket in buckets:
        matches = [p for p in owned if tag_for(bucket["id"]) in (p.get("description") or "")]
        if not matches:
            matches = [p for p in owned if p["name"] == name_for(bucket)]
        mem = remembered.get(bucket["id"])
        if isinstance(mem, str):  # state saved by an older version of this script
            mem = {"id": mem, "created_at": 0}
        if matches:
            chosen = next((p for p in matches if mem and p["id"] == mem["id"]), matches[0])
            targets[bucket["id"]] = chosen["id"]
            extras = [p["id"] for p in matches if p is not chosen]
            if extras:
                warnings.append((bucket, extras))
        elif mem and time.time() - mem["created_at"] < RECENT_CREATE_SECONDS:
            try:
                p = sp.request("GET", f"/playlists/{mem['id']}")
                targets[bucket["id"]] = p["id"] if (p.get("owner") or {}).get("id") == user_id else None
            except RuntimeError:
                targets[bucket["id"]] = None
        else:
            targets[bucket["id"]] = None
    return targets, warnings


def read_playlist_uris(sp: Spotify, pid: str) -> list[str]:
    items = sp.all_pages(f"/playlists/{pid}/items?limit=100")
    return [u for e in items if (u := ((e.get("item") or e.get("track")) or {}).get("uri"))]


def write_playlist(sp: Spotify, pid: str, uris: list[str]) -> None:
    """Make the playlist contain exactly `uris`, in order, once each. The first 100 go in with
    a replace, which wipes whatever was there, so re-runs and retries never stack songs. Then
    the playlist is read back, and rewritten if it doesn't match."""
    uris = list(dict.fromkeys(uris))
    problem = ""
    for _ in range(3):
        try:
            sp.request("PUT", f"/playlists/{pid}/items", json={"uris": uris[:100]})
            for i in range(100, len(uris), 100):
                sp.request("POST", f"/playlists/{pid}/items", json={"uris": uris[i:i + 100]})
        except AmbiguousWriteError as err:
            problem = str(err)  # unknown whether it applied: start over with a replace
            continue
        for wait in (0.8, 2.4):  # Spotify can take a moment to reflect a write
            time.sleep(wait)
            actual = read_playlist_uris(sp, pid)
            if actual == uris:
                return
            problem = f"playlist has {len(actual)} songs, expected {len(uris)}"
    raise RuntimeError(f"Could not confirm playlist {pid} was written correctly ({problem}).")


# --------------------------------------------------------------------------- main

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="show what would be created, change nothing")
    parser.add_argument("--list-genres", action="store_true", help="print raw Spotify genres and which bucket each maps to")
    parser.add_argument("--min-tracks", type=int, default=5, help="skip genres with fewer songs (default 5)")
    parser.add_argument("--include-uncategorized", action="store_true", help="also make a playlist for songs with no genre")
    parser.add_argument("--prefix", default="Liked · ", help='playlist name prefix (default "Liked · ")')
    parser.add_argument("--public", action="store_true", help="make new playlists public (default private)")
    parser.add_argument("--genres-file", type=Path, default=ROOT / "docs" / "genres.json")
    args = parser.parse_args()

    load_dotenv()
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    if not client_id:
        sys.exit("Set SPOTIFY_CLIENT_ID in .env (see README.md).")
    redirect_uri = os.environ.get("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8888/callback")

    buckets = load_buckets(args.genres_file)
    sp = Spotify(client_id, redirect_uri)
    user_id = sp.request("GET", "/me")["id"]

    print("Reading Liked Songs...")
    tracks, removed = dedupe_tracks(fetch_liked_tracks(sp))
    if removed:
        print(f"  skipped {removed} duplicate{'s' if removed != 1 else ''} (same song liked more than once)")
    print("Reading artist genres...")
    artist_genres = fetch_artist_genres(sp, tracks, buckets, os.environ.get("LASTFM_API_KEY"))

    if args.list_genres:
        counts = Counter(g for t in tracks for g in artist_genres.get(t["artist_ids"][0], []) if t["artist_ids"])
        print(f"\n{'songs':>6}  {'spotify genre':<40} bucket")
        for genre, n in counts.most_common():
            b = bucket_for_genre(genre, buckets)
            print(f"{n:>6}  {genre:<40} {b['name'] if b else '-- unmatched --'}")
        return

    groups: dict[str, list[str]] = defaultdict(list)
    for t in tracks:  # each song goes into exactly one genre
        groups[classify_track(t, artist_genres, buckets)["id"]].append(t["uri"])

    print(f"\n{len(tracks)} liked songs:")
    keep = []
    for bucket in buckets + [UNCATEGORIZED]:
        uris = groups.get(bucket["id"])
        if not uris:
            continue
        skip = (bucket is UNCATEGORIZED and not args.include_uncategorized) or len(uris) < args.min_tracks
        print(f"  {len(uris):>5}  {bucket['name']}{'   (skipped)' if skip else ''}")
        if not skip:
            keep.append((bucket, uris))

    if args.dry_run:
        print("\nDry run: no playlists changed. Run without --dry-run to create them.")
        return

    name_for = lambda b: args.prefix + b["name"]  # noqa: E731
    state = read_json(PLAYLIST_STATE_FILE, {})
    targets, warnings = resolve_playlists(sp, user_id, [b for b, _ in keep], name_for, state)
    print()
    for bucket, uris in keep:
        pid = targets[bucket["id"]]
        if pid:
            sp.request("PUT", f"/playlists/{pid}", json={"name": name_for(bucket), "description": description_for(bucket)})
            status = "updated"
        else:
            pid = sp.request("POST", "/me/playlists", json={
                "name": name_for(bucket), "public": args.public, "description": description_for(bucket),
            })["id"]
            # Saved immediately, so even a crash right after can't lead to a second copy.
            state[bucket["id"]] = {"id": pid, "created_at": time.time()}
            write_json(PLAYLIST_STATE_FILE, state)
            status = "new"
        write_playlist(sp, pid, uris)
        print(f"  ✓ {name_for(bucket)} ({len(uris)} songs, {status})  https://open.spotify.com/playlist/{pid}")

    for bucket, extras in warnings:
        print(f"\nNote: you already had more than one '{bucket['name']}' playlist. One was updated; "
              "these extra copies were left alone and can be deleted in Spotify:")
        for pid in extras:
            print(f"    https://open.spotify.com/playlist/{pid}")
    print("\nDone. Re-run any time; the same playlists are updated in place, never duplicated.")


if __name__ == "__main__":
    try:
        main()
    except RateLimitedError as err:
        sys.exit("\n" + err.message)
