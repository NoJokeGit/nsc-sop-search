# NSC Support SOP Search

A single-page search layer over the National Safety Council customer support
SOPs that live in Scribe. There are **no guide pages on this site** — clicking a
result opens the original Scribe guide in a new tab.

Plain HTML, CSS and vanilla JavaScript. No backend, no build step, hosted on
GitHub Pages.

## Status

| Part | State |
| --- | --- |
| Home page, search, keyboard, empty states | Built |
| Search test suite | Built, 44 checks passing |
| `scrape.js` (Scribe → `search-index.json`) | Built, 50 guides, 0 failures |
| Real guide data | Live in `data/search-index.json` |

The index is generated. Do not hand-edit `data/search-index.json`; edit
`data/guides.json` (tags, category, title overrides) or `data/synonyms.json`
and re-run the scraper.

## Layout

```
index.html                 the only page
404.html                   sends stray paths back to /
.nojekyll                  stops GitHub Pages running Jekyll
assets/
  styles.css               all styling, including the brand palette
  app.js                   DOM, keyboard handling, rendering
  search.js                the search engine (no DOM; used by the tests)
  snippet.js               builds match-highlighted snippets
  fonts/                   Funnel Sans woff2 + OFL licence
vendor/
  fuse.min.mjs             Fuse.js 7.5.0, vendored (no CDN)
  FUSE-LICENSE.txt
data/
  guides.json              optional per-guide overrides, hand-edited
  synonyms.json            synonym groups, hand-edited
  search-index.json        what the site actually loads
tools/
  test-search.mjs          the search test suite
  package.json             build-time deps (Playwright, later)
```

## Run it locally

The page uses ES modules, so it must be served over HTTP. Opening
`index.html` from disk will not work.

```bash
cd nsc-sop-guide
python -m http.server 8787
```

Then open <http://127.0.0.1:8787/>.

## How the data flows

You never edit the guide list by hand.

```
tools/sources.json  (the 8 Scribe hub Pages)
        |
        |  node tools/scrape.js
        v
tools/discovery   ->  every embedded guide URL, deduplicated
        |
        v
data/search-index.json   (id, url, category, tags, title, text)
        +
data/guides.json         (tags + overrides, hand-maintained)
data/synonyms.json       (customer wording, hand-maintained)
```

To add a **whole new area**, add its Scribe hub Page to `tools/sources.json`
with the category name, then run the scraper.

A guide's category is chosen automatically: when the same guide appears on
several hub Pages, it is filed under the page that lists the *fewest* guides,
which is its most specific home.

## Add or change a guide

1. Add or edit the guide in Scribe.
2. Run `node tools/scrape.js` (see below).
3. If the wording customers use does not find it, add tags in
   `data/guides.json` under that guide's `id`.

Tags are weighted far above body text, so they are the main lever. Example:

```json
{
  "id": "BqMRCe-tScu3EmM0EC1ayw",
  "tags": ["login", "log in", "sign in", "locked out", "password"]
}
```

The `id` is the part after `__` in the Scribe viewer URL. To find it, search the
current `data/search-index.json` for the title.

## Update synonyms

`data/synonyms.json` maps groups of interchangeable terms. Every query is
expanded with them, so customer wording finds SOP wording.

```json
{
  "groups": [
    ["login", "log in", "sign in", "signin"],
    ["password reset", "reset password", "forgot password"]
  ]
}
```

Guidance:

- Both single words and whole phrases are allowed. Phrases are matched first.
- Keep groups **tight**. A loose synonym pulls unrelated guides to the top; that
  is the most common cause of a bad ranking.
- Put the wording a caller would use in the same group as the wording the SOP
  uses, not in a chain of groups.
- Adding a misspelling that people actually type is legitimate
  (`"pasword reset"` is in the list for that reason).

## Run the scraper

Requires Node 20+ and **Microsoft Edge** (or Chrome). Playwright is installed
once:

```bash
cd tools
npm install
```

Then run it:

```bash
node scrape.js              # incremental: skips guides whose text is unchanged
node scrape.js --force      # re-fetch every guide (use after editing tags)
node scrape.js --limit 5    # smoke test on 5 guides
node scrape.js --only seat  # only guides whose slug contains "seat"
node scrape.js --dry-run    # discover and list, write nothing
```

What it does:

1. Opens each hub Page in `sources.json` and reads the guide URLs out of the
   page payload.
2. Fetches each guide and reads the step list out of the server-rendered HTML.
   Every step is in the document, so no scrolling is needed.
3. Merges into `data/search-index.json`.

A live progress bar prints per guide, and `tools/.progress.json` is rewritten
each time so you can watch a long run from another shell.

Typical timings: discovery ~10 s, harvest ~1 s per guide, so a 50-guide run is
under a minute.

### If it fails

| Message | Meaning | Fix |
| --- | --- | --- |
| `AUTH_REQUIRED` | Scribe redirected to sign-in | `node scrape.js --login`, sign in, then re-run |
| `no steps found` | Guide has no captured steps yet | Nothing to do; check the guide in Scribe |
| `PENDING_GENERATION` | Scribe is still generating the guide | Wait, then re-run |
| `HTTP 404` | Guide was deleted or the link changed | Remove the guide from its hub Page in Scribe |

A failed guide **keeps its previous index entry**, so a bad run never empties the
site. Details land in `tools/scrape-report.json`.

## Run the search tests

```bash
cd tools
node --test test-search.mjs
```

No install needed — it uses Node's built-in test runner and imports the same
`assets/search.js` the browser loads, so tests cannot drift from production.

Each case is a phrase plus the guide(s) that should come first:

```js
{ q: "cant log in", want: ["Resetting a Learner Password"] },
```

When a case fails, the output names the phrase and what came back instead. The
usual fixes, in order:

1. Add the phrase to an existing synonym group.
2. Add a missing `tag` to the guide.
3. Improve `text` for that guide.
4. Only then consider changing `CONFIG` in `assets/search.js`.

## Tuning the ranking

All weights live in one place, `CONFIG` at the top of `assets/search.js`:

| Key | Meaning |
| --- | --- |
| `fieldWeight` | How much a match in title / tags / category / text counts |
| `phraseBonus` | Extra credit for an exact phrase hit |
| `synonymDiscount` | Penalty on a word-level synonym substitution |
| `phraseSubDiscount` | Penalty on a phrase-level synonym substitution |
| `termScale` | Overall scale of the per-word pass |
| `meanShare` / `bestShare` | Balance between covering every word and matching one strongly |
| `coveragePenalty` | How hard to punish a guide that misses part of the query |
| `minScore` | Results below this are dropped |

Change one value at a time and re-run the tests.

## Publish to GitHub Pages

1. Create the repository and push `nsc-sop-guide` as the repo root:

   ```bash
   git init
   git add .
   git commit -m "SOP search"
   git branch -M main
   git remote add origin https://github.com/<org>/<repo>.git
   git push -u origin main
   ```

2. On GitHub: **Settings → Pages**.
3. **Source**: *Deploy from a branch*. **Branch**: `main`, folder `/ (root)`.
4. Save. The site appears at `https://<org>.github.io/<repo>/`.

Notes:

- `.nojekyll` must stay in the repo root, or GitHub Pages will ignore files and
  folders that begin with an underscore.
- Everything is relative-path based, so it works from a project subpath without
  configuration.
- If the repo is private, Pages needs a plan that supports private publishing.

## Accessibility and design

- Body text is navy `#253b4e` on white (11.6:1). Green `#00843d` is used for
  actions and badges (4.8:1 with white text).
- Orange `#f7941d` is **decoration only** — it is 2.3:1 against white and must
  never carry text.
- Search is an ARIA combobox: results are announced, arrow keys move the
  selection, Enter opens the highlighted guide in a new tab, Escape clears.
- Tap targets are at least 44 px; the search field uses a 17 px font so mobile
  Safari does not zoom on focus.

## Licence notes

- Fuse.js is Apache-2.0 — see `vendor/FUSE-LICENSE.txt`.
- Funnel Sans is licensed under the SIL Open Font License 1.1 — see
  `assets/fonts/OFL.txt`. It is self-hosted; the page never calls Google Fonts.
