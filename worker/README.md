# Run service (Cloudflare Worker)

The **PULL NEW SCRIBES** button needs this. A static page cannot trigger GitHub
Actions, because GitHub requires an authenticated request — so this Worker holds
the token and does it for you.

It is ~40 lines of routing and contains **no AI and no stored data**. Everything
it knows is passed in per request.

## What it does

| Route | Method | Purpose |
| --- | --- | --- |
| `/pull` | POST | Checks the passphrase, dispatches the `refresh-index` workflow |
| `/status` | GET | Returns the newest run so the console can show progress |

## 1. Create the token

1. <https://github.com/settings/personal-access-tokens/new>
2. **Repository access** → *Only select repositories* → `nsc-sop-search`
3. **Permissions** → *Repository permissions* → **Actions: Read and write**
4. Nothing else. Set an expiry you are comfortable with.
5. Generate and copy the token.

## 2. Create the Worker

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create**
2. **Worker** → name it `sop-pull` → **Deploy**
3. **Edit code** → replace everything with the contents of `bob-pull.js`
4. **Deploy**

## 3. Add the secrets

In the Worker → **Settings** → **Variables and Secrets**:

| Name | Type | Value |
| --- | --- | --- |
| `GITHUB_TOKEN` | Secret | the token from step 1 |
| `BOB_PASS` | Secret | `123` (or whatever you choose) |
| `ALLOWED_ORIGIN` | Text | `https://nojokegit.github.io` |

`ALLOWED_ORIGIN` matters: it is what stops other websites from calling your
Worker from a visitor's browser.

## 4. Point the console at it

Your Worker URL looks like `https://sop-pull.<subdomain>.workers.dev`.

Open `assets/admin.js` and set:

```js
endpoint: "https://sop-pull.<subdomain>.workers.dev",
```

Commit and push. The button now works.

## Security, stated plainly

- The console passphrase (`123`) is in the page source. Anyone can read it.
  It is a speed bump, not a lock.
- The **real** control is `BOB_PASS` on the Worker plus the GitHub token, neither
  of which is ever in the page.
- Worst case if someone triggers a pull: public guide pages get re-read and a
  commit lands. No secrets are exposed and no data is lost, and failed guides
  keep their existing entries.
- Rate limits are handled by GitHub; a runaway loop would simply hit its limits.

## If you would rather not deploy it

Leave `endpoint` empty in `assets/admin.js`. The console still shows index
statistics, category counts, and direct links to Actions where you can press
**Run workflow** yourself.
