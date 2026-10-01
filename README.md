# Genre Sorter for Spotify Liked Songs

Sorts your **Liked Songs** into one playlist per genre (Hip-Hop & Rap, Indie & Alternative, Latin, ...)
with the click of a button. It's a single web page, so there's nothing to install, and it runs
entirely in the visitor's browser, so there's no server and no data leaves their device except to Spotify.

Spotify doesn't tag songs with genres, only artists, so each song goes into its main artist's genre.
Spotify's thousands of micro-genres ("chicago drill", "bedroom pop") are grouped into about 20 broad
genres defined in [`docs/genres.json`](docs/genres.json).

## Use it

**[kwong0419.github.io/SpotifyGenrePlaylistsGenerator](https://kwong0419.github.io/SpotifyGenrePlaylistsGenerator/)**

The first visit walks you through a one-time, 3-minute setup: Spotify only lets each developer app
be used by 5 people, so everyone creates their own free Spotify app and pastes its Client ID into the
page. You need **Spotify Premium**, because Spotify requires it for these apps. After that it's
*Log in with Spotify → preview your genres → Create playlists*.

**Large libraries:** Spotify allows one artist per request and limits how fast apps can ask, so the
first run on a big library (thousands of artists) takes a while, and Spotify may pause the app for a
few hours partway through. The page tells you when to come back, and everything found so far is saved.
Later runs only look up newly liked artists.

## Never any duplicates

- **No duplicate playlists.** Every playlist carries a tag in its description (e.g. `[gs:hip-hop-rap]`).
  Before creating anything, the app lists the user's playlists and reuses the tagged one. That still
  works after renaming the playlist, changing the name prefix, clearing the browser, or switching
  devices, and between the web app and the Python script.
- **No duplicate songs.** Playlists are *replaced*, never appended to, so re-runs and interrupted runs
  can't stack songs. After writing, each playlist is read back and rewritten if it isn't exactly right.
  Each song goes into exactly one genre, and the same song liked from two releases (single vs. album,
  remaster) is included once.
- Only one run at a time: the button locks, and a second browser tab is refused.

## Hosting your own copy (one time, about 10 minutes)

Fork this repo if you'd rather run your own copy, e.g. to give up to 5 friends one-click access
without the setup step.

1. **Create a Spotify app.** In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
   click **Create app**, tick **Web API**, and add the Redirect URI where the site will live, e.g.
   `https://YOUR-GITHUB-NAME.github.io/SpotifyGenrePlaylistsGenerator/` (the trailing `/` matters).
   You need Spotify Premium; Spotify requires it for the app owner.
2. **Put the Client ID in [`docs/config.js`](docs/config.js)**, plus your first name for the
   "ask Kevin to add you" message. A Client ID isn't a secret; it's fine to publish.
3. **Turn on GitHub Pages.** Push this repo to GitHub, then go to *Settings → Pages* and choose
   *Deploy from a branch → `main` → `/docs`*. The site appears at the URL from step 1 within a minute.
   On a free GitHub account the repo must be public for Pages to work.
4. **Add your friends.** In your Spotify app's dashboard, open *User Management* and add each person's
   name and the email of their Spotify account. Spotify allows **5 people in total** (including you).

Then send people the link.

### What other people see

- **Friends you added:** *Log in with Spotify → preview their genres → Create playlists.* That's it.
- **Anyone else:** Spotify blocks them from your app, so the site tells them and offers a guided
  3-minute setup where they create their own free Spotify app and paste its Client ID. They then use
  the same one-click flow, with no limit on how many people can do this. They need Spotify Premium.

## Running it on your computer

Spotify only accepts `http` login redirects for `127.0.0.1`, so use that address rather than `localhost`:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8765/docs/` (add that exact address as a Redirect URI in your Spotify app).

To try the whole flow **without a Spotify account**, open `http://127.0.0.1:8765/tests/demo.html`.
It runs the real app against a simulated Spotify.

## Tests

```bash
npm test                                  # web app logic (Node 18+)
python3 -m unittest discover tests        # Python script
```

They simulate Spotify misbehaving (a slow-to-update playlist list, requests that succeed but report
an error) and check that no duplicate playlists or songs are ever created.

## Customizing genres

Each genre in `docs/genres.json` has an `id`, a display `name` and `keywords`. A Spotify genre goes to
the **first** genre with a keyword inside it, so specific genres go above broad ones (`K-Pop` above `Pop`).
You can rename a genre freely, but changing its `id` makes a new playlist.

## Command-line version

[`spotify_genres.py`](spotify_genres.py) does the same from a terminal, and finds the same playlists
as the web app.

```bash
pip install -r requirements.txt
cp .env.example .env                      # paste your Client ID
python3 spotify_genres.py --dry-run       # preview
python3 spotify_genres.py                 # create / update playlists
python3 spotify_genres.py --list-genres   # which Spotify genre lands where
```

Its Spotify app needs the Redirect URI `http://127.0.0.1:8888/callback`.

## License

[MIT](LICENSE)
