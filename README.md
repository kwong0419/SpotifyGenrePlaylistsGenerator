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
page shows how many artists there are, roughly how long it will take and whether it needs more than
one day of Groq's free allowance. While it runs, the tab's title shows the progress and turns into ✓
when it's done.

## How genres are worked out

Spotify only lets a development app look up a few hundred artists before it blocks the whole developer
account for about a day. So instead of asking Spotify for each artist's genres, the app:

1. Reads your Liked Songs from Spotify (50 per request; skipped if nothing changed since last time).
2. Sends your artists' names, with a couple of song titles each, to **Groq** (a free AI service),
   about 80 per request. The model tags each artist the way Spotify would ("chicago drill",
   "bedroom pop"), or says it doesn't know rather than guessing.
3. For artists whose songs span different genres (say, hip hop and rock), it tags each of their
   songs separately, so the songs can land in different playlists.
4. Runs the tags through the keyword rules in [`docs/genres.json`](docs/genres.json) to pick one of
   24 playlists per song. Optionally, Last.fm fills in artists the model didn't know.
5. For artists whose tags still fit no playlist, a second pass asks the model to pick the best
   playlist from the actual list, using everything known (tags, Last.fm tags, who they work with,
   their songs). The answer can only be a real playlist or "none", and artists with no basis to
   place them stay in **Uncategorized** rather than being guessed. The preview says why songs are
   left there, and **Ask again** on that row re-sorts just those artists.

Groq replies use [strict structured outputs](https://console.groq.com/docs/structured-outputs) where
the model supports them, so the reply format can't drift; other models answer in numbered lines.

Results are saved in your browser, so later runs only send newly liked artists. A 7,400-song
library takes about 350 Spotify requests on the first run and only a handful after that.

## Staying within the free limits

- **Spotify:** requests are spaced out. A short slow-down gets two careful retries; a lockout or used-up
  quota stops everything at once, because requests during a lockout extend it. The page shows when to
  come back. Playlists that haven't changed aren't rewritten.
- **Groq:** every request is budgeted against the free tier before it's sent, using at most 80% of the
  per-minute limit and 90% of the daily limit, tracked across reloads and tabs. If a big library needs
  more than a day's allowance, the artists with the most songs go first. You can make playlists right
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
- **No song in two playlists.** A song can move genre on a later run (for example when a big library
  finishes sorting on day 2), so every genre playlist the app has made is kept up to date on each run,
  ticked or not, and emptied if all its songs moved elsewhere. To stop a playlist being updated,
  delete it in Spotify.
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

## Tests

```bash
npm test                                  # Node 18+
```

They simulate Spotify and Groq misbehaving (a slow-to-update playlist list, requests that succeed but
report an error, rate limits, used-up quotas, broken AI replies) and check that no duplicate playlists
or songs are ever created and that neither service is pushed past its limits.

## Customizing genres

Each genre in `docs/genres.json` has an `id`, a display `name` and `keywords`. A genre tag goes to
the **first** genre with a keyword inside it, so specific genres go above broad ones (`K-Pop` above `Pop`).
A song goes where most of its tags point; a tie goes to the tag listed first. You can rename a genre
freely, but changing its `id` makes a new playlist. Changing the rules doesn't use any Groq allowance.

## License

[MIT](LICENSE)
