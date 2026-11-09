const els = {
  sections: document.getElementById("faq-sections"),
  chips: document.getElementById("faq-chips"),
  search: document.getElementById("faq-search"),
  clear: document.getElementById("faq-clear"),
  meta: document.getElementById("faq-meta"),
  empty: document.getElementById("faq-empty"),
  emptyReset: document.getElementById("empty-reset"),
  emptyHint: document.getElementById("empty-hint"),
  bannerTitle: document.getElementById("banner-title"),
  bannerText: document.getElementById("banner-text"),
  heroEyebrow: document.getElementById("hero-eyebrow"),
  heroTitle: document.getElementById("hero-title"),
  heroSub: document.getElementById("hero-sub"),
  videoTitle: document.getElementById("video-title"),
  videoText: document.getElementById("video-text"),
  video: document.getElementById("video-player"),
  videoBadge: document.getElementById("video-badge"),
  footerDisclaimer: document.getElementById("footer-disclaimer"),
  popularList: document.getElementById("popular-list"),
};

const ICONS = {
  rocket: '<path d="M5 13l4 4L19 7"/><path d="M13 3a8 8 0 0 1 8 8"/><path d="M3 13a8 8 0 0 0 8 8"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  award: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13.5L17 22l-5-3-5 3 1.5-8.5"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1"/>',
  lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M5.6 5.6l3.7 3.7M18.4 5.6l-3.7 3.7M5.6 18.4l3.7-3.7M18.4 18.4l-3.7-3.7"/>',
};

const SCORE = { question: 6, answer: 2, section: 1 };
const AUTO_OPEN = 3;

const state = {
  data: null,
  query: "",
  category: "",
  entries: [],
};

init();

async function init() {
  try {
    const response = await fetch("data/faq.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
  } catch (error) {
    els.meta.textContent = "Could not load the FAQ. Try refreshing the page.";
    console.error(error);
    return;
  }

  applyCopy();
  trackChromeHeights();
  buildChips();
  buildEntries();
  render();

  els.search.addEventListener("input", () => {
    const wasEmpty = state.query.trim() === "";
    state.query = els.search.value;
    els.clear.hidden = state.query.length === 0;
    render();

    if (wasEmpty && state.query.trim()) scheduleResultsScroll();
  });

  els.search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.search.value) {
      event.preventDefault();
      clearSearch();
    }
  });

  els.clear.addEventListener("click", clearSearch);

  els.emptyReset?.addEventListener("click", () => {
    resetFilters();
    els.search.value = "";
    state.query = "";
    els.clear.hidden = true;
    render();
    els.search.focus();
  });

  els.chips.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    const id = chip.dataset.section;
    state.category = state.category === id ? "" : id;
    syncChips();
    render();
    scrollToResults();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    event.preventDefault();
    els.search.focus();
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (id) openQuestion(id);
  });

  const initial = location.hash.slice(1);
  if (initial) openQuestion(initial);
}

function applyCopy() {
  const { banner, hero } = state.data;
  els.bannerTitle.textContent = banner.title;
  els.bannerText.textContent = banner.text;
  els.footerDisclaimer.textContent = banner.text;

  els.heroEyebrow.textContent = hero.eyebrow;
  els.heroTitle.textContent = hero.title;
  els.heroSub.textContent = hero.subtitle;
  els.search.placeholder = hero.searchPlaceholder || "Search help articles";

  els.videoTitle.textContent = hero.video.title;
  els.videoText.textContent = hero.video.text;
  els.video.src = hero.video.src;
  els.video.poster = hero.video.poster;
  els.videoBadge.textContent = hero.video.duration;

  els.popularList.replaceChildren();
  for (const link of hero.popular ?? []) {
    const li = document.createElement("li");
    const anchor = document.createElement("a");
    anchor.href = "#" + link.target;
    anchor.textContent = link.label;
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      resetFilters();
      els.search.value = "";
      state.query = "";
      els.clear.hidden = true;
      render();
      openQuestion(link.target);
    });
    li.append(anchor);
    els.popularList.append(li);
  }
}

function trackChromeHeights() {
  const banner = document.querySelector(".example-banner");
  const nav = document.querySelector(".section-nav");
  const root = document.documentElement;

  const measure = () => {
    root.style.setProperty("--banner-h", banner.offsetHeight + "px");
    root.style.setProperty("--nav-h", nav.offsetHeight + "px");
  };

  measure();
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(measure);
    observer.observe(banner);
    observer.observe(nav);
  } else {
    window.addEventListener("resize", measure);
  }
}

function buildChips() {
  for (const section of state.data.sections) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.section = section.id;
    chip.setAttribute("aria-pressed", "false");
    chip.textContent = section.name;
    els.chips.append(chip);
  }
}

function syncChips() {
  for (const chip of els.chips.querySelectorAll(".chip")) {
    chip.setAttribute(
      "aria-pressed",
      chip.dataset.section === state.category ? "true" : "false",
    );
  }
}

function buildEntries() {
  state.entries = state.data.sections.flatMap((section, sectionIndex) =>
    section.items.map((item, itemIndex) => ({
      item,
      sectionId: section.id,
      sectionName: section.name,
      sectionIndex,
      itemIndex,
      qLower: item.q.toLowerCase(),
      aLower: stripTags(item.a).toLowerCase(),
      sectionLower: section.name.toLowerCase(),
    })),
  );
}

function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, " ");
}

function queryTerms() {
  return state.query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
}

function scoreEntry(entry, terms) {
  if (!terms.length) return 1;

  let score = 0;
  for (const term of terms) {
    const inQuestion = entry.qLower.includes(term);
    const inAnswer = entry.aLower.includes(term);
    const inSection = entry.sectionLower.includes(term);

    if (!inQuestion && !inAnswer && !inSection) return 0;

    if (inQuestion) score += SCORE.question;
    else if (inAnswer) score += SCORE.answer;
    else score += SCORE.section;
  }
  return score;
}

function render() {
  const terms = queryTerms();
  const querying = terms.length > 0;

  let matches = state.entries.filter(
    (entry) => !state.category || entry.sectionId === state.category,
  );

  if (querying) {
    matches = matches
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter((row) => row.score > 0);
  } else {
    matches = matches.map((entry) => ({ entry, score: 1 }));
  }

  if (querying) {
    matches.sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.sectionIndex - b.entry.sectionIndex ||
        a.entry.itemIndex - b.entry.itemIndex,
    );
  }

  renderList(matches, terms, querying);
  renderMeta(matches.length, state.entries.length, querying);

  document.body.classList.toggle("is-search-active", querying || Boolean(state.category));
}

function renderList(matches, terms, querying) {
  els.sections.replaceChildren();
  els.empty.hidden = matches.length > 0;
  if (matches.length && els.emptyHint) els.emptyHint.hidden = true;

  if (!matches.length) return;

  const groups = new Map();
  for (const row of matches) {
    const key = row.entry.sectionId;
    if (!groups.has(key)) {
      groups.set(key, { section: row.entry, rows: [] });
    }
    groups.get(key).rows.push(row);
  }

  const ordered = [...groups.values()];
  if (querying) {
    ordered.sort((a, b) => b.rows[0].score - a.rows[0].score);
  }

  const fragment = document.createDocumentFragment();
  let autoOpened = 0;

  for (const group of ordered) {
    const section = state.data.sections.find((s) => s.id === group.section.sectionId);
    const sectionEl = document.createElement("section");
    sectionEl.className = "faq-section";
    sectionEl.id = section.id;

    const heading = document.createElement("h2");
    const icon = document.createElement("span");
    icon.className = "section-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${
      ICONS[section.icon] ?? ICONS.rocket
    }</svg>`;

    const label = document.createElement("span");
    label.textContent = section.name;
    heading.append(icon, label);

    const list = document.createElement("div");
    list.className = "faq-list";

    for (const row of group.rows) {
      let shouldOpen = false;
      if (querying && autoOpened < AUTO_OPEN) {
        const questionHit = terms.every((term) => row.entry.qLower.includes(term));
        const isTop = autoOpened === 0;
        if (isTop || questionHit) {
          shouldOpen = true;
          autoOpened++;
        }
      }

      list.append(renderItem(row.entry.item, terms, shouldOpen));
    }

    sectionEl.append(heading, list);
    fragment.append(sectionEl);
  }

  els.sections.append(fragment);
}

function renderItem(item, terms, open) {
  const details = document.createElement("details");
  details.className = "faq-item";
  details.id = item.id;
  if (open) details.open = true;

  const summary = document.createElement("summary");
  summary.className = "faq-q";

  const question = document.createElement("span");
  question.className = "faq-q-text";
  question.textContent = item.q;

  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("class", "faq-chevron");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = '<path d="M6 9l6 6 6-6"/>';

  summary.append(question, chevron);

  const answer = document.createElement("div");
  answer.className = "faq-a";
  const para = document.createElement("p");
  para.innerHTML = item.a;
  answer.append(para);

  markTerms(question, terms);
  markTerms(para, terms);

  details.append(summary, answer);

  const foot = document.createElement("div");
  foot.className = "faq-foot";

  if (item.guide) {
    const guideLabel = document.createElement("span");
    guideLabel.className = "faq-foot-label";
    guideLabel.textContent = "Step-by-step:";

    const link = document.createElement("a");
    link.className = "guide-link";
    link.href = item.guide.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.innerHTML = `${escapeHtml(item.guide.title)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>`;

    foot.append(guideLabel, link);

    if (item.guide.steps) {
      const steps = document.createElement("span");
      steps.className = "guide-steps";
      steps.textContent = item.guide.steps;
      foot.append(steps);
    }
  } else if (item.external) {
    const link = document.createElement("a");
    link.className = "guide-link";
    link.href = item.external.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.innerHTML = `${escapeHtml(item.external.title)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>`;
    foot.append(link);
  }

  if (item.note) {
    const note = document.createElement("p");
    note.className = "demo-note";
    note.textContent = `Demo note: ${item.note}`;
    foot.append(note);
  }

  if (foot.childNodes.length) details.append(foot);

  return details;
}

function markTerms(container, terms) {
  if (!terms.length) return;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();

    const ranges = [];
    for (const term of terms) {
      let from = 0;
      while (from <= lower.length) {
        const at = lower.indexOf(term, from);
        if (at === -1) break;
        ranges.push([at, at + term.length]);
        from = at + term.length;
      }
    }
    if (!ranges.length) continue;

    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) {
        fragment.append(document.createTextNode(text.slice(cursor, start)));
      }
      const mark = document.createElement("mark");
      mark.textContent = text.slice(start, end);
      fragment.append(mark);
      cursor = end;
    }
    if (cursor < text.length) {
      fragment.append(document.createTextNode(text.slice(cursor)));
    }

    node.parentNode.replaceChild(fragment, node);
  }
}

function renderMeta(shown, total, querying) {
  const categoryName = state.data.sections.find(
    (section) => section.id === state.category,
  )?.name;

  if (!querying && !state.category) {
    els.meta.textContent = `${total} questions across ${state.data.sections.length} topics.`;
    return;
  }

  if (!shown) {
    els.meta.textContent = "No matching questions.";
    if (els.emptyHint) {
      const parts = [];
      if (querying) parts.push(`"${state.query.trim()}"`);
      if (categoryName) parts.push(`in ${categoryName}`);
      els.emptyHint.hidden = parts.length === 0;
      els.emptyHint.textContent = parts.length
        ? `Showing nothing for ${parts.join(" ")}.`
        : "";
    }
    return;
  }

  const scope = categoryName ? ` in ${categoryName}` : "";
  if (querying) {
    els.meta.textContent = `${shown} matching question${shown === 1 ? "" : "s"}${scope}.`;
  } else {
    els.meta.textContent = `${shown} question${shown === 1 ? "" : "s"}${scope}.`;
  }
}

function clearSearch() {
  clearTimeout(scrollTimer);
  els.search.value = "";
  state.query = "";
  els.clear.hidden = true;
  render();
  els.search.focus();
}

function resetFilters() {
  state.category = "";
  syncChips();
}

function openQuestion(id) {
  let target = document.getElementById(id);

  if (!target) {
    resetFilters();
    els.search.value = "";
    state.query = "";
    els.clear.hidden = true;
    render();
    target = document.getElementById(id);
  }

  if (!(target instanceof HTMLDetailsElement)) return;

  target.open = true;
  history.replaceState(null, "", "#" + id);
  scrollTo(target);
}

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

function stickyOffset() {
  const banner = document.querySelector(".example-banner");
  const nav = document.querySelector(".section-nav");
  return banner.offsetHeight + nav.offsetHeight + 12;
}

function scrollTo(target) {
  const top =
    target.getBoundingClientRect().top + window.scrollY - stickyOffset();
  window.scrollTo({
    top: Math.max(0, top),
    behavior: REDUCED_MOTION.matches ? "auto" : "smooth",
  });
}

let scrollTimer = 0;

function scheduleResultsScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(scrollToResults, 280);
}

function scrollToResults() {
  scrollTo(els.meta);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
