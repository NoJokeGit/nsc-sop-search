/**
 * Cloudflare Worker: button bridge for the maintenance console.
 *
 * The static site cannot trigger GitHub Actions by itself, so this tiny proxy
 * holds a fine-grained token and dispatches the workflow. No AI, no data
 * processing, no storage — three routes and nothing else.
 *
 * Deploy: see worker/README.md. Required secrets:
 *   GITHUB_TOKEN  fine-grained PAT, Actions: read and write, this repo only
 *   BOB_PASS      the passphrase the console sends
 * Optional vars:
 *   ALLOWED_ORIGIN  defaults to https://nojokegit.github.io
 */

const OWNER = "NoJokeGit";
const REPO = "nsc-sop-search";
const WORKFLOW = "refresh-index.yml";

export default {
  async fetch(request, env) {
    // ALLOWED_ORIGIN accepts a comma-separated list so local development can
    // call the deployed Worker without weakening production.
    const allowed = (env.ALLOWED_ORIGIN ?? "https://nojokegit.github.io")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const requestOrigin = request.headers.get("origin") ?? "";
    const origin = allowed.includes(requestOrigin)
      ? requestOrigin
      : allowed[0];

    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-bob-pass",
      "access-control-max-age": "86400",
      vary: "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/status" && request.method === "GET") {
        const data = await latestRun(env);
        return json(data, cors);
      }

      if (url.pathname === "/pull" && request.method === "POST") {
        const pass = request.headers.get("x-bob-pass") ?? "";
        if (!env.BOB_PASS || pass !== env.BOB_PASS) {
          return json({ error: "unauthorised" }, cors, 401);
        }

        const body = await request.json().catch(() => ({}));
        const inputs = {
          force: body.force === false ? "false" : "true",
          dry_run: body.dryRun === true ? "true" : "false",
        };

        const dispatched = await dispatch(env, inputs);
        return json(dispatched, cors);
      }

      return json({ error: "not found" }, cors, 404);
    } catch (error) {
      return json({ error: String(error.message ?? error) }, cors, 502);
    }
  },
};

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "user-agent": "sop-maintenance-worker",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

async function latestRun(env) {
  const response = await gh(
    env,
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
  );
  if (!response.ok) {
    throw new Error(`github ${response.status}`);
  }
  const data = await response.json();
  const run = data.workflow_runs?.[0];
  if (!run) return { status: "none", conclusion: null };
  return {
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.run_started_at,
    htmlUrl: run.html_url,
  };
}

async function dispatch(env, inputs) {
  const response = await gh(
    env,
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs }),
    },
  );

  if (response.status !== 204) {
    const detail = await response.text();
    throw new Error(`dispatch failed (${response.status}): ${detail.slice(0, 160)}`);
  }

  // The dispatch endpoint returns nothing, so read the newest run back.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const latest = await latestRun(env).catch(() => null);
  return {
    queued: true,
    runUrl: latest?.htmlUrl ?? `https://github.com/${OWNER}/${REPO}/actions`,
  };
}
