# Genre Sorter for Spotify Liked Songs

Sorts your **Liked Songs** into one playlist per genre (Hip-Hop & Rap, Indie & Alternative, Latin, ...)
with the click of a button. It's a single web page, so there's nothing to install, and it runs
entirely in the visitor's browser: there's no server, and data only goes to Spotify and Groq.

## Use it

**[kwong0419.github.io/SpotifyGenrePlaylistsGenerator](https://kwong0419.github.io/SpotifyGenrePlaylistsGenerator/)**

The first visit walks you through two one-time steps, about 5 minutes in total:

1. **Your own Spotify app** (free). Spotify only lets each developer app be used by 5 people, so
   everyone creates their own and pastes its Client ID into the page. You need **Spotify Premium**,
   because Spotify requires it for these apps.
2. **A Groq API key** (free, no credit card) from [console.groq.com/keys](https://console.groq.com/keys).

After that it's *Log in with Spotify → preview your genres → Create playlists*. Before a long sort the
page shows how many songs there are, roughly how long it will take and whether it needs more than
one day of Groq's free allowance. While it runs, the tab's title shows the progress and turns into ✓
when it's done.

## How songs are sorted

1. Reads your Liked Songs from Spotify (50 per request; skipped if nothing changed since last time).
2. Sends your songs to **Groq** (a free AI service), about 90 per request, as "title by artist" (plus
   featured artists). The model judges **each song on its own** and picks the most specific playlist
   it fits from [`docs/taxonomy.json`](docs/taxonomy.json): 26 genres with subgenres, like
   *Electronic & Dance → Deep House, Techno, Dubstep…*, *Hip-Hop & Rap → Trap, Drill, Melodic Rap…*,
   and K-Pop and J-Pop as separate playlists. It answers "none" when it doesn't know a song, rather
   than guessing.
3. **A subgenre becomes its own playlist once it has 15 songs** (or already has a playlist from an
   earlier run, so playlists don't flip between runs). Otherwise its songs go into the broad genre's
   playlist, so a library with three techno songs gets them in *Electronic & Dance*, not a tiny playlist.
4. Every answer says how sure the model is and repeats the first two words of the song's title, so
   an answer meant for a different song is caught and asked again. The model is told never to judge
   by names, a title's language or its capitals (an all-caps title isn't a sign of K-Pop).
5. **Songs it's unsure about get a second, more careful look**, with real catalog data the model
   can't look up itself: the genre Apple Music gives the song (free, no key; e.g. "Classical
   Crossover" for Tony Ann's *ICARUS*) and, with a free Last.fm key, listener tags for the song
   ("piano", "instrumental"). Anything still unsure goes to Uncategorized, not a guessed playlist.
6. **You can move any song** from the preview ("Move to…"). Your choice always wins, and your
   choices are shown to the model as examples of your taste on later runs.

Groq replies use [strict structured outputs](https://console.groq.com/docs/structured-outputs) where
the model supports them, so the answer can only be a real playlist from the list; other models answer
in numbered lines, and anything that isn't a real playlist is ignored and asked again.

Answers are saved in your browser, so later runs only send newly liked songs. When the model's free
daily allowance runs out, the app stops and asks: wait for it to reset, make playlists from what's
sorted, or carry on with another model (each Groq model has its own allowance; smaller ones are less
accurate). A model picked there is only used until your usual model's allowance resets. A 7,000-song
library takes a few days of allowance the first time; you can make playlists from what's sorted on
day one. When the sorting method improves, songs are re-checked the same way, and
each keeps its current playlist until it has been.

### Check the accuracy first

[`accuracy.html`](https://kwong0419.github.io/SpotifyGenrePlaylistsGenerator/accuracy.html) sorts
about 120 well-known songs with known genres ([`docs/benchmark.json`](docs/benchmark.json)) using
your Groq key, exactly like the real run, and shows how many land in the right playlist and which
don't. It uses a few thousand tokens.

## Staying within the free limits

- **Spotify:** requests are spaced out. A short slow-down gets two careful retries; a lockout or used-up
  quota stops everything at once, because requests during a lockout extend it. The page shows when to
  come back. Playlists that haven't changed aren't rewritten.
- **Groq:** every request is budgeted against the free tier before it's sent, using at most 80% of the
  per-minute limit and 90% of the daily limit, tracked across reloads and tabs. If a big library needs
  more than a day's allowance, the most recently liked songs go first. You can make playlists right
  away with what's sorted, and the rest is added to the same playlists on a later run.
- Only one run at a time, even across tabs.

## Never any duplicates

- **No duplicate playlists.** Every playlist carries a tag in its description (e.g. `[gs:hip-hop-rap]`).
  Before creating anything, the app lists the user's playlists and reuses the tagged one. That still
  works after renaming the playlist, changing the name prefix, clearing the browser, or switching
  devices.
- **No duplicate songs.** Playlists are *replaced*, never appended to, so re-runs and interrupted runs
  can't stack songs. After writing, each playlist's song count is checked (and every song is read back
  if anything went wrong on the way); it's rewritten if it isn't exactly right.
  Each song goes into exactly one genre, and the same song liked from two releases (single vs. album,
  remaster) is included once.
- **No song in two playlists.** A song can move playlist on a later run (for example when a subgenre
  reaches 15 songs, or a big library finishes sorting on day 2), so every playlist the app has made is
  kept up to date on each run, ticked or not, and emptied if all its songs moved elsewhere. Playlists
  for genres that were removed or split are emptied too. To stop a playlist being updated, delete it
  in Spotify.
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

Everyone also adds their own free Groq key. A key built into the site would be visible to anyone,
and one big library uses about half a day's free allowance.

## Running it on your computer

Spotify only accepts `http` login redirects for `127.0.0.1`, so use that address rather than `localhost`:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8765/docs/` (add that exact address as a Redirect URI in your Spotify app).

To try the whole flow **without any accounts**, open `http://127.0.0.1:8765/tests/demo.html`.
It runs the real app against a simulated Spotify and Groq; any Groq key works there.
`tests/accuracy-demo.html` does the same for the accuracy check.

## Tests

```bash
npm test                                  # Node 18+
```

They simulate Spotify and Groq misbehaving (a slow-to-update playlist list, requests that succeed but
report an error, rate limits, used-up quotas, broken AI replies) and check that no duplicate playlists
or songs are ever created and that neither service is pushed past its limits.

## Customizing playlists

[`docs/taxonomy.json`](docs/taxonomy.json) lists the playlists: each genre has an `id`, a `name`, a
`hint` telling the model what belongs there, and optional `sub`genres. You can rename freely, but
changing an `id` makes a new playlist. When the list changes, songs are sorted again, and playlists
for genres no longer in the list are emptied (so no song is in two playlists) and listed so you can
delete them.

## License

[MIT](LICENSE)
