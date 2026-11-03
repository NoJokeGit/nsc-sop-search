/**
 * Maintenance console.
 *
 * This is a speed bump, not a security boundary: the passphrase lives in this
 * file, so anyone who reads the source can bypass it. That is accepted -- the
 * button can only re-read public Scribe pages, and the real credential is the
 * GitHub token held by the Worker, never here.
 */

const CONFIG = {
  // Filled in once the Cloudflare Worker is deployed. Leave empty to hide the
  // run button and fall back to the direct GitHub links.
  endpoint: "",
  passphrase: "123",
  storageKey: "sop-admin-unlocked",
  pollMs: 5000,
};

const els = {
  gate: document.getElementById("gate"),
  gateForm: document.getElementById("gate-form"),
  gatePass: document.getElementById("gate-pass"),
  gateError: document.getElementById("gate-error"),
  console: document.getElementById("console"),
  conn: document.getElementById("conn"),
  lock: document.getElementById("lock"),
  pull: document.getElementById("pull"),
  dry: document.getElementById("dry"),
  force: document.getElementById("force"),
  configNote: document.getElementById("config-note"),
  log: document.getElementById("log"),
  clearLog: document.getElementById("clear-log"),
  statGuides: document.getElementById("stat-guides"),
  statSteps: document.getElementById("stat-steps"),
  statBuilt: document.getElementById("stat-built"),
  statSize: document.getElementById("stat-size"),
  cats: document.getElementById("cats"),
};

let pollTimer = null;
let running = false;

init();

function init() {
  startRain("rain", 0.55);
  els.gateForm.addEventListener("submit", onSubmit);
  els.lock.addEventListener("click", lock);
  els.pull.addEventListener("click", onPull);
  els.clearLog.addEventListener("click", () => {
    els.log.replaceChildren();
  });

  if (!CONFIG.endpoint) {
    els.configNote.hidden = false;
    els.pull.disabled = true;
    els.pull.title = "Set BOB_ENDPOINT in assets/admin.js after deploying the Worker";
  }

  if (sessionStorage.getItem(CONFIG.storageKey) === "1") {
    unlock();
  } else {
    els.gatePass.focus();
  }
}

/* ---------------- gate ---------------- */

function onSubmit(event) {
  event.preventDefault();
  if (els.gatePass.value.trim() === CONFIG.passphrase) {
    sessionStorage.setItem(CONFIG.storageKey, "1");
    unlock();
    return;
  }

  els.gateError.hidden = false;
  els.gatePass.value = "";
  els.gatePass.focus();
  els.gateForm.classList.remove("is-shaking");
  void els.gateForm.offsetWidth;
  els.gateForm.classList.add("is-shaking");
}

function unlock() {
  els.gate.hidden = true;
  els.console.hidden = false;
  startRain("rain2", 0.5);
  log("console unlocked", "ok");
  loadIndex();
  checkLink();
}

function lock() {
  sessionStorage.removeItem(CONFIG.storageKey);
  if (pollTimer) clearInterval(pollTimer);
  els.console.hidden = true;
  els.gate.hidden = false;
  els.gatePass.value = "";
  els.gatePass.focus();
}

/* ---------------- index summary ---------------- */

async function loadIndex() {
  try {
    const response = await fetch(`data/search-index.json?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const data = JSON.parse(text);
    const guides = data.guides ?? [];

    const steps = guides.reduce(
      (total, guide) => total + (guide.steps?.length ?? 0),
      0,
    );

    els.statGuides.textContent = String(guides.length);
    els.statSteps.textContent = steps.toLocaleString();
    els.statBuilt.textContent = new Date(
      data.generated ?? Date.now(),
    ).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    els.statSize.textContent = `${Math.round(text.length / 1024)} KB`;

    const counts = new Map();
    for (const guide of guides) {
      counts.set(guide.category, (counts.get(guide.category) ?? 0) + 1);
    }
    els.cats.replaceChildren();
    for (const [name, count] of [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = name;
      const value = document.createElement("b");
      value.textContent = String(count);
      li.append(label, value);
      els.cats.append(li);
    }

    log(`index loaded: ${guides.length} guides, ${steps} steps`, "ok");
  } catch (error) {
    log(`index read failed: ${error.message}`, "err");
  }
}

/* ---------------- run service ---------------- */

async function checkLink() {
  if (!CONFIG.endpoint) {
    setConn("idle", "NO ENDPOINT");
    return;
  }
  try {
    const response = await fetch(`${CONFIG.endpoint}/status`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    setConn("live", "LINKED");
    reportRun(data);
  } catch (error) {
    setConn("off", "OFFLINE");
    log(`status check failed: ${error.message}`, "warn");
  }
}

async function onPull() {
  if (running || !CONFIG.endpoint) return;

  running = true;
  els.pull.disabled = true;
  els.pull.classList.add("is-busy");
  els.pull.querySelector(".pull-label").textContent = "RUNNING";

  log(
    `dispatch requested (${els.force.checked ? "force" : "incremental"}${
      els.dry.checked ? ", dry run" : ""
    })`,
    "ok",
  );

  try {
    const response = await fetch(`${CONFIG.endpoint}/pull`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bob-pass": CONFIG.passphrase,
      },
      body: JSON.stringify({
        force: els.force.checked,
        dryRun: els.dry.checked,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `HTTP ${response.status}`);
    }

    log(`workflow queued: ${data.runUrl ?? "(no url)"}`, "ok");
    setConn("live", "RUNNING");
    startPolling();
  } catch (error) {
    log(`dispatch failed: ${error.message}`, "err");
    finishRun();
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  let seenStatus = null;

  pollTimer = setInterval(async () => {
    try {
      const response = await fetch(`${CONFIG.endpoint}/status`, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const data = await response.json();

      if (data.status && data.status !== seenStatus) {
        log(`run status: ${data.status}`, data.status === "completed" ? "ok" : undefined);
        seenStatus = data.status;
      }

      if (data.status === "completed" || data.status === "failure" || data.status === "cancelled") {
        reportRun(data);
        clearInterval(pollTimer);
        pollTimer = null;
        finishRun();
        if (data.conclusion === "success") {
          log("pull finished, reloading index", "ok");
          setTimeout(loadIndex, 4000);
        } else {
          log(`pull ended: ${data.conclusion ?? data.status}`, "err");
        }
      }
    } catch {
      // transient; keep polling
    }
  }, CONFIG.pollMs);
}

function reportRun(data) {
  if (!data) return;
  if (data.status === "in_progress" || data.status === "queued") {
    setConn("live", "RUNNING");
    if (data.htmlUrl) log(`watch: ${data.htmlUrl}`);
  }
}

function finishRun() {
  running = false;
  els.pull.disabled = !CONFIG.endpoint;
  els.pull.classList.remove("is-busy");
  els.pull.querySelector(".pull-label").textContent = "RUN PULL";
}

function setConn(state, label) {
  els.conn.textContent = label;
  els.conn.className =
    "pill " +
    (state === "live" ? "pill-live" : state === "off" ? "pill-off" : "pill-idle");
}

/* ---------------- log ---------------- */

function log(message, level) {
  const line = document.createElement("span");
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  line.className = level ?? "";
  line.textContent = `[${stamp}] ${message}\n`;
  els.log.append(line);
  els.log.scrollTop = els.log.scrollHeight;
}

/* ---------------- matrix rain ---------------- */

function startRain(id, opacity) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const ctx = canvas.getContext("2d");
  const glyphs = "01ABCDEF<>{}[]/\\|=+*#$%&";
  const font = 15;
  let columns = 0;
  let drops = [];
  let raf = 0;

  function size() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    columns = Math.floor(canvas.width / font);
    drops = Array.from({ length: columns }, () =>
      Math.floor(Math.random() * (canvas.height / font)),
    );
  }

  function frame() {
    ctx.fillStyle = `rgba(10, 15, 12, ${0.14 + (1 - opacity) * 0.1})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${font}px ui-monospace, monospace`;
    for (let i = 0; i < columns; i++) {
      const char = glyphs[Math.floor(Math.random() * glyphs.length)];
      const x = i * font;
      const y = drops[i] * font;
      ctx.fillStyle = Math.random() > 0.985 ? "#9df0b8" : "#4ade80";
      ctx.fillText(char, x, y);
      if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
    raf = requestAnimationFrame(frame);
  }

  size();
  frame();
  window.addEventListener("resize", size);

  // Stop when the page is hidden so an idle tab is not burning CPU.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else {
      raf = requestAnimationFrame(frame);
    }
  });
}
