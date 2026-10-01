"""Run with: python3 -m unittest discover tests
Drives spotify_genres.main() against an in-memory Spotify to prove re-runs and
flaky writes never create duplicate playlists or songs."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import spotify_genres as sg  # noqa: E402

ME = "me123"


class FakeSpotify:
    def __init__(self, n=250):
        kinds = ["rapper", "indie", "latin", "nogenre"]
        self.liked = [{"track": {"id": f"t{i}", "uri": f"spotify:track:t{i}", "name": f"Song {i}",
                                 "artists": [{"id": kinds[i % 4], "name": kinds[i % 4]}]}} for i in range(n)]
        # the same song liked twice from two releases
        self.liked.append({"track": {"id": "dup", "uri": "spotify:track:dup", "name": "Song 0 - 2011 Remaster",
                                     "artists": [{"id": "rapper", "name": "rapper"}]}})
        self.artists = {"rapper": ["chicago drill"], "indie": ["bedroom pop"], "latin": ["reggaeton"], "nogenre": []}
        self.playlists, self.followed = {}, []
        self.creates = 0
        self.fail_after_apply = 0

    def page(self, items, path):
        offset = int(dict(p.split("=") for p in path.split("?")[1].split("&")).get("offset", 0)) if "?" in path else 0
        limit = 50
        nxt = f"{path.split('?')[0]}?offset={offset + limit}" if offset + limit < len(items) else None
        return {"items": items[offset:offset + limit], "next": nxt, "total": len(items)}

    def request(self, method, path, json=None, **_):
        path = path.replace(sg.API, "")
        base = path.split("?")[0]
        parts = base.strip("/").split("/")
        if base == "/me":
            return {"id": ME}
        if base == "/me/tracks":
            return self.page(self.liked, path)
        if parts[0] == "artists":
            return {"id": parts[1], "name": parts[1], "genres": self.artists[parts[1]]}
        if base == "/me/playlists" and method == "GET":
            return self.page([{k: v for k, v in self.playlists[i].items() if k != "items"} for i in self.followed], path)
        if base == "/me/playlists" and method == "POST":
            self.creates += 1
            pid = f"pl{self.creates}"
            self.playlists[pid] = {"id": pid, "owner": {"id": ME}, "items": [], **json}
            self.followed.append(pid)
            return {"id": pid}
        pl = self.playlists[parts[1]]
        if len(parts) == 2:
            if method == "PUT":
                pl.update(json)
            return pl
        if method == "GET":
            return self.page([{"item": {"uri": u}} for u in pl["items"]], path)
        if method == "PUT":
            pl["items"] = list(json["uris"])
            return {}
        pl["items"].extend(json["uris"])
        if self.fail_after_apply:
            self.fail_after_apply -= 1
            raise sg.AmbiguousWriteError("502 after applying")
        return {}


class CliTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        patches = [
            mock.patch.object(sg, "ARTIST_CACHE_FILE", tmp / "a.json"),
            mock.patch.object(sg, "PLAYLIST_STATE_FILE", tmp / "p.json"),
            mock.patch.object(sg, "LIKED_CACHE_FILE", tmp / "l.json"),
            mock.patch.object(sg.Spotify, "__init__", lambda self, *a: None),
            mock.patch.object(sg.time, "sleep", lambda s: None),
            mock.patch.dict(os.environ, {"SPOTIFY_CLIENT_ID": "x"}),
            mock.patch("builtins.print"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.state_file = tmp / "p.json"
        self.fake = FakeSpotify()
        p = mock.patch.object(sg.Spotify, "request", lambda _self, *a, **k: self.fake.request(*a, **k))
        p.start()
        self.addCleanup(p.stop)

    def run_cli(self, *args):
        with mock.patch.object(sys, "argv", ["spotify_genres.py", *args]):
            sg.main()

    def assert_no_duplicates(self):
        lists = [self.fake.playlists[i] for i in self.fake.followed]
        names = [p["name"] for p in lists]
        self.assertEqual(len(names), len(set(names)), names)
        all_songs = [u for p in lists for u in p["items"]]
        self.assertEqual(len(all_songs), len(set(all_songs)))

    def test_reruns_and_new_machine_reuse_playlists(self):
        self.run_cli()
        self.run_cli()
        self.state_file.unlink()  # a different computer
        self.run_cli("--prefix", "🎧 ")
        self.assertEqual(self.fake.creates, 3)
        self.assert_no_duplicates()
        self.assertEqual(sorted(len(p["items"]) for p in self.fake.playlists.values()), [62, 63, 63])

    def test_failed_append_that_actually_applied_is_not_doubled(self):
        self.fake = FakeSpotify(1200)
        self.fake.fail_after_apply = 2
        self.run_cli()
        self.assert_no_duplicates()
        self.assertEqual([len(p["items"]) for p in self.fake.playlists.values()], [300, 300, 300])

    def test_shares_playlists_with_the_web_app(self):
        # A playlist the web app made (tagged, renamed by the user) is found, not recreated.
        self.fake.playlists["web1"] = {"id": "web1", "owner": {"id": ME}, "name": "my rap", "items": [],
                                       "description": "sorted by Genre Sorter. [gs:hip-hop-rap]"}
        self.fake.followed.append("web1")
        self.run_cli()
        self.assertEqual(self.fake.creates, 2)
        self.assertEqual(len(self.fake.playlists["web1"]["items"]), 63)


class RateLimitTest(unittest.TestCase):
    def make_client(self, statuses):
        sp = sg.Spotify.__new__(sg.Spotify)
        sp.token = {"access_token": "t", "expires_at": float("inf")}
        sp.gap, sp.last_request, sp.ok_streak = 0, 0.0, 0
        responses = iter(statuses)

        def fake_request(method, url, **_):
            status = next(responses)
            r = mock.Mock(status_code=status, ok=status < 400, content=b'{"ok": 1}', headers={})
            r.json.return_value = {"ok": 1}
            return r
        sp.session = mock.Mock(request=fake_request)
        return sp

    def test_short_slowdown_gets_two_careful_retries(self):
        sleeps = []
        sp = self.make_client([429, 429, 200])
        with mock.patch.object(sg.time, "sleep", sleeps.append), mock.patch("builtins.print"):
            self.assertEqual(sp.request("GET", "/artists/x"), {"ok": 1})
        self.assertEqual([s for s in sleeps if s >= 10], [30, 60])

    def test_lockout_stops_without_hammering(self):
        sp = self.make_client([429] * 50)
        with mock.patch.object(sg.time, "sleep", lambda s: None), mock.patch("builtins.print"):
            with self.assertRaises(sg.RateLimitedError) as ctx:
                sp.request("GET", "/artists/x")
        self.assertIn("Progress is saved", ctx.exception.message)

    def test_long_retry_after_is_reported_not_slept_through(self):
        sp = self.make_client([429])
        sp.session.request = lambda *a, **k: mock.Mock(status_code=429, ok=False, headers={"Retry-After": "49000"})
        with self.assertRaises(sg.RateLimitedError) as ctx:
            sp.request("GET", "/artists/x")
        self.assertIn("13h 37m", ctx.exception.message)

if __name__ == "__main__":
    unittest.main()
