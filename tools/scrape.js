#!/usr/bin/env node
// Rebuilds data/search-index.json from the hub Pages in sources.json.
//
// discover: read the guide URLs out of each hub page's __NEXT_DATA__ payload
// harvest:  fetch each guide and pull the steps out of the server-rendered HTML
// merge:    upsert, keeping the old entry whenever a guide fails
//
// Flags: --force, --headful, --only <text>, --limit N, --dry-run, --login

import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const PATHS = {
  sources: join(here, "sources.json"),
  overrides: join(root, "data", "guides.json"),
  categories: join(root, "data", "categories.json"),
  index: join(root, "data", "search-index.json"),
  state: join(here, ".scrape-state.json"),
  report: join(here, "scrape-report.json"),
  progress: join(here, ".progress.json"),
  profile: join(here, ".browser-profile"),
};

// Edge first. Chrome is the fallback, then bundled Chromium, which is all a
// Linux CI runner has.
const CHANNELS = ["msedge", "chrome", null];

// Scrubbed from every guide before it reaches the index. Personal data only.
// Internal hostnames stay, because the steps are useless without them.
const REDACTIONS = [
  // Staff names and addresses used as examples inside the steps.
  [/\bChance McLain\b/g, "an example learner"],
  [/\b[A-Za-z0-9._%+-]+@nsc\.org\b/gi, (match) =>
    /^no-?reply@/i.test(match) ? match : "example@nsc.org"],
  // Test mailboxes from when the guides were written.
  [/\b[A-Za-z0-9._%+-]+@yopmail\.com\b/gi, "test@example.com"],
];

const args = parseArgs(process.argv.slice(2));

main().catch(async (error) => {
  await writeProgress({ state: "error", message: error.message }).catch(() => {});
  console.error(`\nFATAL: ${error.message}`);
  process.exit(1);
});

async function main() {
  const sources = await readJson(PATHS.sources);
  const pages = sources.pages ?? [];
  if (!pages.length) throw new Error("sources.json has no pages");

  const overrides = await readJson(PATHS.overrides).catch(() => ({ guides: [] }));
  const overrideById = new Map(
    (overrides.guides ?? []).map((guide) => [guide.id, guide]),
  );
  const taxonomy = await readJson(PATHS.categories).catch(() => ({}));

  const previous = await readJson(PATHS.index).catch(() => ({ guides: [] }));
  const previousById = new Map(
    (previous.guides ?? []).map((guide) => [guide.id, guide]),
  );
  const state = await readJson(PATHS.state).catch(() => ({}));

  if (args.login) {
    await login();
    return;
  }

  console.log("Scribe SOP scraper");
  console.log(`  pages     ${pages.length}`);
  console.log(`  mode      ${args.force ? "force" : "incremental"}`);
  console.log(`  browser   ${args.headful ? "visible" : "headless"}`);
  console.log("");

  await writeProgress({ state: "starting", total: 0, done: 0 });

  const context = await launch(args.headful);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    // ---------- phase 1: discover ----------
    console.log("Phase 1/3  discovering guides");
    const discovery = await discover(page, pages);
    for (const row of discovery.pages) {
      console.log(
        `  ${row.category.padEnd(24)} ${String(row.found).padStart(3)} guides` +
          (row.error ? `   ERROR: ${row.error}` : ""),
      );
    }
    console.log(`  ${discovery.guides.length} unique guides\n`);

    if (discovery.authRequired) {
      reportAuthRequired();
      await writeProgress({ state: "auth-required", done: 0, total: 0 });
      return;
    }

    let targets = discovery.guides;
    if (args.only) {
      const needle = args.only.toLowerCase();
      targets = targets.filter((guide) =>
        guide.slug.toLowerCase().includes(needle),
      );
      console.log(`  filtered to ${targets.length} guide(s) matching "${args.only}"\n`);
    }
    if (args.limit) targets = targets.slice(0, args.limit);

    if (args.dryRun) {
      console.log("Dry run - nothing written.");
      for (const guide of targets) {
        console.log(`  ${(guide.hub ?? "").padEnd(24)} ${guide.slug}`);
      }
      await writeProgress({ state: "dry-run", done: 0, total: targets.length });
      return;
    }

    // ---------- phase 2: harvest ----------
    console.log(`Phase 2/3  harvesting ${targets.length} guides`);
    const startedAt = Date.now();
    const harvested = [];
    const failures = [];

    for (let index = 0; index < targets.length; index += 1) {
      const guide = targets[index];
      const cached = previousById.get(guide.id);
      const label = `${String(index + 1).padStart(3)}/${targets.length}`;

      // --force skips the hash check so category and tag edits take effect.
      const knownHash = args.force ? null : state[guide.id];
      const result = await harvest(page, guide, knownHash);

      let status;
      if (result.status === "unchanged") {
        harvested.push(cached);
        status = "unchanged";
      } else if (result.status === "ok") {
        const entry = buildEntry(
          guide,
          result,
          overrideById.get(guide.id),
          taxonomy,
        );
        harvested.push(entry);
        state[guide.id] = result.hash;
        status = `${result.steps.length} steps`;
      } else {
        if (cached) harvested.push(cached);
        failures.push({ ...guide, reason: result.status.toUpperCase() });
        status = `FAILED ${result.status}`;
      }

      const done = index + 1;
      const elapsed = (Date.now() - startedAt) / 1000;
      const perGuide = elapsed / done;
      const remaining = Math.max(0, Math.round(perGuide * (targets.length - done)));

      console.log(
        `  [${label}] ${bar(done, targets.length)} ${status.padEnd(16)} ${guide.slug.slice(0, 42)}`,
      );
      await writeProgress({
        state: "harvesting",
        done,
        total: targets.length,
        current: guide.slug,
        lastStatus: status,
        etaSeconds: remaining,
      });
    }

    // ---------- phase 3: merge ----------
    console.log("\nPhase 3/3  writing index");
    // --limit and --only must not delete guides they never looked at.
    const preserveMissing = Boolean(args.limit || args.only);
    const merged = mergeIndex(harvested, previousById, preserveMissing);

    // Keep the old timestamp when nothing changed, so an idle run produces a
    // byte-identical file and the workflow has nothing to commit.
    const unchanged =
      JSON.stringify(merged) === JSON.stringify(previous.guides ?? []);
    const generated = unchanged
      ? (previous.generated ?? new Date().toISOString())
      : new Date().toISOString();

    await writeAtomic(PATHS.index, {
      generated,
      count: merged.length,
      guides: merged,
    });
    await writeAtomic(PATHS.state, state);
    await writeAtomic(PATHS.report, {
      generated: new Date().toISOString(),
      pages: discovery.pages,
      harvested: harvested.length,
      failures,
    });

    console.log(`  ${merged.length} guides in search-index.json`);
    if (failures.length) {
      console.log(`\n  ${failures.length} problem(s):`);
      for (const failure of failures) {
        console.log(`    ${failure.reason.padEnd(20)} ${failure.slug}`);
      }
      console.log("\n  See tools/scrape-report.json for detail.");
      process.exitCode = 1;
    } else {
      console.log("\n  No failures.");
    }

    await writeProgress({
      state: failures.length ? "finished-with-errors" : "done",
      done: targets.length,
      total: targets.length,
      guides: merged.length,
      failures: failures.length,
    });
  } finally {
    await context.close().catch(() => {});
  }
}

/* ---------------- browser ---------------- */

// BrowserContext on the saved profile, so a login survives between runs.
async function launch(headful) {
  const errors = [];
  for (const channel of CHANNELS) {
    try {
      return await chromium.launchPersistentContext(PATHS.profile, {
        ...(channel ? { channel } : {}),
        headless: !headful,
        viewport: { width: 1440, height: 1000 },
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (error) {
      errors.push(`${channel ?? "bundled chromium"}: ${error.message.split("\n")[0]}`);
    }
  }
  throw new Error(
    `could not launch a browser (Edge then Chrome)\n  ${errors.join("\n  ")}`,
  );
}

async function login() {
  console.log("Opening Edge for Scribe sign-in");
  const context = await launch(true);
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto("https://scribehow.com/signin", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    console.log("  Sign in, then leave the window open.");
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      await page.goto("https://scribehow.com/workspace", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => {});
      if (!isAuthUrl(page.url())) {
        console.log("Signed in. Session saved.");
        return;
      }
    }
    console.log("Timed out waiting for sign-in.");
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

function reportAuthRequired() {
  console.log("AUTH_REQUIRED");
  console.log("");
  console.log("  Scribe redirected to a sign-in page, so nothing was scraped.");
  console.log("  Sign in once, then re-run:");
  console.log("");
  console.log("    node scrape.js --login");
  console.log("    node scrape.js");
}

/* ---------------- phase 1 ---------------- */

async function discover(page, pages) {
  const rows = [];
  const guides = new Map();
  let authRequired = false;

  for (const source of pages) {
    let payload;
    try {
      await page.goto(source.url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForTimeout(900);
      payload = await page.evaluate(() => {
        const script = document.getElementById("__NEXT_DATA__");
        if (!script) {
          return { ok: false, reason: "no __NEXT_DATA__ payload", finalUrl: location.href };
        }
        let data;
        try {
          data = JSON.parse(script.textContent);
        } catch {
          return { ok: false, reason: "bad JSON in payload", finalUrl: location.href };
        }
        const urls = new Set();
        const seen = new Set();
        const walk = (node, depth) => {
          if (!node || depth > 40 || seen.has(node)) return;
          if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
            return;
          }
          if (typeof node === "object") {
            seen.add(node);
            if (typeof node.scribeUrl === "string") urls.add(node.scribeUrl);
            for (const key of Object.keys(node)) walk(node[key], depth + 1);
          }
        };
        walk(data, 0);
        return { ok: true, urls: [...urls], finalUrl: location.href };
      });
    } catch (error) {
      rows.push({ ...source, found: 0, error: `navigation: ${error.message.split("\n")[0]}` });
      continue;
    }

    if (isAuthUrl(payload.finalUrl)) {
      authRequired = true;
      rows.push({ ...source, found: 0, error: "redirected to sign-in" });
      continue;
    }
    if (!payload.ok) {
      rows.push({ ...source, found: 0, error: payload.reason });
      continue;
    }

    for (const url of payload.urls) {
      const parsed = parseGuideUrl(url);
      if (!parsed) continue;
      const existing = guides.get(parsed.id);
      if (existing) {
        if (!existing.categories.includes(source.category)) {
          existing.categories.push(source.category);
        }
      } else {
        guides.set(parsed.id, {
          id: parsed.id,
          slug: parsed.slug,
          url,
          categories: [source.category],
        });
      }
    }
    rows.push({
      ...source,
      found: payload.urls.length,
      error: null,
      guideIds: payload.urls.map((u) => parseGuideUrl(u)?.id).filter(Boolean),
    });
  }

  // A guide can appear on several hub pages. Take the page listing the fewest,
  // which is the most specific. That is the scope; the category comes later.
  const pageSizes = new Map(rows.map((row) => [row.category, row.found]));
  for (const guide of guides.values()) {
    guide.hub = [...guide.categories].sort((a, b) => {
      const sizeA = pageSizes.get(a) ?? Number.MAX_SAFE_INTEGER;
      const sizeB = pageSizes.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (sizeA !== sizeB) return sizeA - sizeB;
      return a.localeCompare(b);
    })[0];
    delete guide.categories;
  }


  return { pages: rows, guides: [...guides.values()], authRequired };
}

function parseGuideUrl(url) {
  const match = url.match(/\/viewer\/([^/?#]+)/);
  if (!match) return null;
  const tail = match[1];
  const id = tail.split("__").pop();
  if (!id) return null;
  const slug = tail.replace(new RegExp(`__${escapeRegex(id)}$`), "");
  return { id, slug: slug || id };
}

/* ---------------- phase 2 ---------------- */

// Read one guide. Scribe puts every step in the server response as an
// action-instruction block, so one fetch gets the lot. No scrolling needed.
async function harvest(page, guide, knownHash) {
  let payload;
  try {
    payload = await page.evaluate(async (url) => {
      let response;
      try {
        response = await fetch(url, { credentials: "include", redirect: "follow" });
      } catch (error) {
        return { status: "error", reason: `fetch failed` };
      }
      if (!response.ok) {
        return { status: "error", reason: `HTTP ${response.status}` };
      }
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      const title = (doc.querySelector("h1")?.textContent ?? "").trim();
      const bodyText = doc.body?.textContent ?? "";
      if (/Sign in to Scribe/i.test(bodyText.slice(0, 2000))) {
        return { status: "auth" };
      }

      const byNumber = new Map();
      for (const node of doc.querySelectorAll('[data-testid="action-instruction"]')) {
        let number = NaN;
        for (const span of node.querySelectorAll("span")) {
          const text = (span.textContent ?? "").trim();
          if (/^\d{1,3}$/.test(text)) {
            number = Number(text);
            break;
          }
        }
        const candidates = [...node.querySelectorAll("div")]
          .map((div) => (div.textContent ?? "").trim().replace(/\s+/g, " "))
          .filter((text) => text.length > 2 && !/^\d{1,3}$/.test(text))
          .sort((a, b) => a.length - b.length);
        if (!Number.isFinite(number) || !candidates.length) continue;
        const text = candidates[0];
        const previous = byNumber.get(number);
        if (!previous || text.length > previous.length) byNumber.set(number, text);
      }

      const steps = [...byNumber.keys()]
        .sort((a, b) => a - b)
        .map((number) => ({ number, text: byNumber.get(number) }));

      return {
        status: "ok",
        title,
        steps,
        pending: /Optimizing structure|Improving descriptions|Analyzing steps|Reading screenshots/i.test(
          (doc.body?.innerText ?? "").slice(0, 400),
        ),
        finalUrl: response.url,
      };
    }, guide.url);
  } catch (error) {
    return { status: "error", reason: error.message.split("\n")[0] };
  }

  if (payload.status === "auth" || isAuthUrl(payload.finalUrl ?? "")) {
    return { status: "auth" };
  }
  if (payload.status === "error") return payload;

  const steps = payload.steps ?? [];
  if (!steps.length) {
    if (payload.pending) return { status: "pending" };
    return { status: "error", reason: "no steps found" };
  }

  const title = redact(cleanTitle(payload.title) || titleFromSlug(guide.slug));
  // Flatten markdown links so the text reads normally, and scrub PII.
  const cleanSteps = steps.map((step) => ({
    number: step.number,
    text: redact(step.text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")),
  }));
  const text = cleanSteps.map((step) => step.text).join(" ");
  const hash = hashEntry(title, text);

  if (knownHash === hash) return { status: "unchanged", hash };

  return { status: "ok", title, text, steps: cleanSteps, hash, url: guide.url };
}

/* ---------------- phase 3 ---------------- */

function buildEntry(guide, result, override, taxonomy = {}) {
  const tags = Array.isArray(override?.tags) ? override.tags : [];

  // Category comes from guides.json. A guide nobody has classified yet falls
  // back to a hub default, so new ones still land somewhere sensible.
  const hub = guide.hub;
  const category =
    override?.category ??
    taxonomy.fallbackByHub?.[hub] ??
    "orgs";

  // Badge text. The scope, not the LMS name.
  const scope =
    taxonomy.scopeLabels?.[hub] ??
    String(hub ?? "").replace(/^STEVEs+/i, "");

  return {
    id: guide.id,
    url: guide.url,
    category,
    scope,
    hub,
    tags,
    title: override?.title ?? result.title,
    text: result.text,
    // Kept so the site can say step 7 instead of only quoting flat text.
    steps: result.steps.map((step) => ({ n: step.number, t: step.text })),
  };
}

function mergeIndex(harvested, previousById, preserveMissing) {
  const byId = new Map();
  for (const entry of harvested) {
    if (!entry || !entry.id) continue;
    byId.set(entry.id, entry);
  }
  if (preserveMissing) {
    for (const [id, entry] of previousById) {
      if (byId.has(id)) continue;
      byId.set(id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/* ---------------- helpers ---------------- */

function bar(done, total, width = 20) {
  const filled = Math.round((done / total) * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

function parseArgs(argv) {
  const parsed = {
    force: false,
    headful: false,
    dryRun: false,
    login: false,
    only: null,
    limit: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") parsed.force = true;
    else if (arg === "--login") parsed.login = true;
    else if (arg === "--headful") parsed.headful = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--only") parsed.only = argv[++index] ?? null;
    else if (arg === "--limit") parsed.limit = Number(argv[++index]) || null;
    else if (arg === "--help" || arg === "-h") {
      console.log("node scrape.js [--login | --force] [--headful] [--only text] [--limit n] [--dry-run]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return parsed;
}

function isAuthUrl(url) {
  return (
    /scribehow\.com\/(login|signin|sign-in|auth|signup)/i.test(url) ||
    /[?&](redirect|next)=/i.test(url)
  );
}

// Run every redaction rule over a string.
function redact(value) {
  let output = String(value ?? "");
  for (const [pattern, replacement] of REDACTIONS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function cleanTitle(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*\|\s*Scribe\s*$/i, "")
    .trim();
}

function titleFromSlug(slug) {
  return slug.replace(/_/g, " ").trim();
}

function hashEntry(title, text) {
  return createHash("sha256")
    .update(`${title}\n${text}`)
    .digest("hex")
    .slice(0, 16);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeProgress(data) {
  // Cosmetic. On Windows the rename can fail while something else has the file
  // open, and that should never kill a run.
  try {
    await writeAtomic(PATHS.progress, {
      ...data,
      updated: new Date().toISOString(),
    });
  } catch {
    // ignore
  }
}

async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
