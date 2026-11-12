# Music Vault — app

The public half of Music Vault: a static web page for browsing and editing a
private album collection from a phone. Built on the same pattern as Movie Vault.

**This repo contains no music data.** No titles, no ratings, no notes, no
artwork. It is only HTML, CSS and JavaScript. It is safe for it to be public.

## How it works

There is no server and no build step. Opening the page asks for a GitHub
fine-grained token, which is stored in that browser and nowhere else. Every read
and write is a direct call to the GitHub API against your **private** data repo.
Each edit becomes a real commit.

Album details (tracklist, label, year) come from **MusicBrainz** and covers
from the **Cover Art Archive**, called straight from the browser. Neither needs
an account or key.

```
┌──────────────┐   token in browser    ┌──────────────────┐
│  this repo   │ ────────────────────▶ │ private data repo │
│  (public)    │   GitHub REST API     │  albums/ artwork/ │
│  page only   │ ◀──────────────────── │  index.json       │
└──────────────┘                       └──────────────────┘
        │
        └──── MusicBrainz + Cover Art Archive (album details, covers)
```

## What it does

- **Library / Shopping list** tabs. Same fields and detail for both.
- Search by album, artist or label; filter by format, genre, decade, rating,
  label, artist. Tap an artist or label on an album to see the rest of theirs.
- Rate (half stars), set formats, set genre, write notes.
- **Add** an album by searching MusicBrainz — tracklist, label, year and cover
  fill in — to either the library or the shopping list. Or enter it by hand.
- **Got it — move to library** on a shopping-list album asks which format you
  got and moves it in one commit.
- **Fill from MusicBrainz** on any album fills what is missing (label,
  tracklist, cover) and never overwrites what is there.
- Random pick from whatever is on screen.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page shell |
| `style.css` | Phone-first styling |
| `frontmatter.js` | Surgical markdown editing — the safety-critical part |
| `app.js` | Everything else: API, gallery, filters, editors, MusicBrainz |
| `test-frontmatter.js` | Runs the editors over every real album |

## Editing rule

`frontmatter.js` never parses YAML into an object and writes it back out.
It replaces only the exact lines it targets. Any change to it must keep the
test passing:

```sh
node test-frontmatter.js ../music-vault-data
```

## Running it locally

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

## Publishing

Settings → Pages → Deploy from branch → `main` / root.
