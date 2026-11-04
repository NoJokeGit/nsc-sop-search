# Run service (Cloudflare Worker)

The **RUN PULL** button needs this. A static page cannot trigger GitHub Actions,
because GitHub requires an authenticated request, so this Worker holds the token
and does it for you.

It is ~40 lines of routing and contains **no AI and no stored data**. Everything
it knows arrives per request.

## Status

Deployed at **<https://sop-pull.nsc-sop-guide.workers.dev>**.

| Route | Method | Purpose |
| --- | --- | --- |
| `/pull` | POST | Checks the password, dispatches the `refresh-index` workflow |
| `/status` | GET | Returns the newest run so the console can show progress |

## 1. Create the GitHub token

1. Open <https://github.com/settings/personal-access-tokens/new>
2. **Repository access** → *Only select repositories* → `nsc-sop-search`
3. **Permissions** → *Repository permissions* → **Actions: Read and write**
4. Nothing else. Choose an expiry you are comfortable with.
5. Generate and copy the token.

## 2. Deploy the Worker

```bash
npx wrangler login
npx wrangler deploy --config worker/wrangler.toml
```

## 3. Add the secrets

```bash
cd worker
npx wrangler secret put GITHUB_TOKEN --config wrangler.toml
npx wrangler secret put BOB_PASS     --config wrangler.toml
```

| Name | Value |
| --- | --- |
| `GITHUB_TOKEN` | the token from step 1 |
| `BOB_PASS` | `Atlas123` (must match `assets/admin-gate.js`) |

`ALLOWED_ORIGIN` is not a secret; it lives in `wrangler.toml` as a comma-separated
list. It is what stops other websites calling the Worker from a visitor's browser.

## 4. Point the console at it

`assets/admin.js` already contains:

```js
endpoint: "https://sop-pull.nsc-sop-guide.workers.dev",
```

If that value is empty, the console hides the run button and shows the DIRECT
links instead.

## Security, stated plainly

- The console password (`Atlas123`) is in the page source. Anyone can read it.
  It is a speed bump, not a lock.
- The **real** control is `BOB_PASS` on the Worker plus the GitHub token, neither
  of which is ever in the page.
- Worst case if someone triggers a pull: public guide pages get re-read and a
  commit lands. No secrets are exposed, no data is lost, and any guide that fails
  keeps its existing entry.
- GitHub's own rate limits bound a runaway loop.

## If you would rather not run it

Leave `endpoint` empty in `assets/admin.js`. The console still shows index
statistics, category counts, and direct links to Actions where you can press
**Run workflow** yourself.
