import { createEngine } from "./search.js";
import { buildSnippetAll } from "./snippet.js";
import { buildAnswer } from "./answers.js";

const els = {
  input: document.getElementById("search-input"),
  clear: document.getElementById("clear-button"),
  categories: document.getElementById("category-nav"),
  resultsList: document.getElementById("results-list"),
  results: document.getElementById("results"),
  status: document.getElementById("status"),
  empty: document.getElementById("empty"),
  answer: document.getElementById("answer"),
  answerLink: document.getElementById("answer-link"),
  answerSteps: document.getElementById("answer-steps"),
  suggestions: document.getElementById("suggestions"),
  suggestionChips: document.getElementById("suggestion-chips"),
  countAll: document.getElementById("count-all"),
};

const state = {
  index: [],
  engine: null,
  synonyms: [],
  category: "",
  query: "",
  results: [],
  selected: -1,
  counts: new Map(),
};

init();

async function init() {
  els.input.addEventListener("input", onInput);
  els.input.addEventListener("keydown", onKeyDown);
  els.clear.addEventListener("click", clearSearch);
  els.categories.addEventListener("click", onCategoryClick);

  // Keep typed text when the browser restores focus, but never steal focus
  // from a user who has already clicked elsewhere.
  window.addEventListener("pageshow", () => {
    if (!document.activeElement || document.activeElement === document.body) {
      els.input.focus({ preventScroll: true });
    }
  });

  try {
    const [index, synonyms] = await Promise.all([
      loadJson("data/search-index.json"),
      loadJson("data/synonyms.json").catch(() => ({ groups: [] })),
    ]);

    state.index = index.guides ?? index;
    state.synonyms = synonyms.groups ?? [];
    state.engine = createEngine(state.index, state.synonyms);

    countCategories();
    renderCategoryTiles();
    render();
  } catch (error) {
    els.status.textContent =
      "Could not load the guide index. Refresh the page, or tell support the search is down.";
    console.error(error);
    return;
  }

  els.input.focus({ preventScroll: true });
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

/* ---------------- categories ---------------- */

function countCategories() {
  const counts = new Map();
  for (const entry of state.index) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  state.counts = counts;
  els.countAll.textContent = String(state.index.length);
}

function renderCategoryTiles() {
  const categories = [...state.counts.keys()].sort((a, b) =>
    a.localeCompare(b),
  );

  for (const category of categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tile";
    button.dataset.category = category;
    button.setAttribute("aria-pressed", "false");

    const label = document.createElement("span");
    label.className = "tile-label";
    label.textContent = category;

    const count = document.createElement("span");
    count.className = "tile-count";
    count.textContent = String(state.counts.get(category));

    button.append(label, count);
    els.categories.append(button);
  }
}

function onCategoryClick(event) {
  const button = event.target.closest(".tile");
  if (!button) return;

  const category = button.dataset.category ?? "";
  state.category = state.category === category ? "" : category;
  syncCategoryButtons();
  render();
  els.input.focus({ preventScroll: true });
}

function syncCategoryButtons() {
  for (const button of els.categories.querySelectorAll(".tile")) {
    const isActive = (button.dataset.category ?? "") === state.category;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

/* ---------------- input ---------------- */

function onInput() {
  state.query = els.input.value;
  els.clear.hidden = state.query.length === 0;
  render();
}

function clearSearch() {
  els.input.value = "";
  state.query = "";
  els.clear.hidden = true;
  render();
  els.input.focus({ preventScroll: true });
}

function onKeyDown(event) {
  if (event.key === "Escape") {
    if (els.input.value) {
      event.preventDefault();
      clearSearch();
    }
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!state.results.length) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = state.selected + delta;

    if (next < 0) {
      setSelected(-1);
      return;
    }
    setSelected(Math.min(next, state.results.length - 1));
    return;
  }

  if (event.key === "Enter") {
    if (state.selected >= 0) {
      event.preventDefault();
      openResult(state.results[state.selected].item);
    } else if (state.results.length === 1) {
      event.preventDefault();
      openResult(state.results[0].item);
    }
  }
}

function openResult(item) {
  window.open(item.url, "_blank", "noopener,noreferrer");
}

/* ---------------- rendering ---------------- */

function render() {
  const query = state.query.trim();
  let results = [];

  if (query) {
    results = state.engine.search(query, { category: state.category });
  } else {
    results = state.index
      .filter((item) => !state.category || item.category === state.category)
      .map((item) => ({ item, score: 0, matches: [] }))
      .sort((a, b) => a.item.title.localeCompare(b.item.title));
  }

  state.results = results;
  setSelected(-1);
  renderAnswer(query, results);
  renderResults(query, results);
  renderStatus(query, results);
  renderSuggestions(query, results);
}

function renderStatus(query, results) {
  const total = state.index.length;
  const scope = state.category ? ` in ${state.category}` : "";

  if (!query) {
    els.status.textContent = state.category
      ? `${results.length} guide${plural(results.length)} in ${state.category}.`
      : `${total} guide${plural(total)}. Type to search, or pick a category.`;
    return;
  }

  if (results.length === 0) {
    els.status.textContent = `No results for \u201c${query}\u201d${scope}.`;
    return;
  }

  els.status.textContent = `${results.length} result${plural(results.length)} for \u201c${query}\u201d${scope}.`;
}

function renderAnswer(query, results) {
  const answer =
    query && !state.category
      ? buildAnswer(query, results, state.synonyms)
      : null;

  if (!answer) {
    els.answer.hidden = true;
    els.answerSteps.replaceChildren();
    return;
  }

  els.answerLink.textContent = answer.guide.title;
  els.answerLink.href = answer.guide.url;

  els.answerSteps.replaceChildren();
  for (const step of answer.steps) {
    const li = document.createElement("li");

    const badge = document.createElement("span");
    badge.className = "answer-step-n";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = String(step.n);

    const text = document.createElement("span");
    text.className = "answer-step-t";
    text.textContent = step.t;

    // Screen readers get the step number as words, not a bare digit.
    const label = document.createElement("span");
    label.className = "visually-hidden";
    label.textContent = `Step ${step.n}: `;

    li.append(badge, label, text);
    li.setAttribute("aria-label", `Step ${step.n}: ${step.t}`);
    els.answerSteps.append(li);
  }

  els.answer.hidden = false;
}

function renderResults(query, results) {
  els.resultsList.replaceChildren();
  els.empty.hidden = results.length > 0;
  els.input.setAttribute("aria-expanded", results.length > 0 ? "true" : "false");

  const fragment = document.createDocumentFragment();

  results.forEach((result, index) => {
    const item = result.item;

    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.id = `result-${index}`;
    li.setAttribute("aria-selected", "false");

    const anchor = document.createElement("a");
    anchor.className = "result";
    anchor.href = item.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.tabIndex = -1;
    anchor.dataset.index = String(index);

    const head = document.createElement("div");
    head.className = "result-head";

    const title = document.createElement("h3");
    title.className = "result-title";
    title.textContent = item.title;

    const openLabel = document.createElement("span");
    openLabel.className = "result-open";
    openLabel.setAttribute("aria-hidden", "true");
    openLabel.textContent = "Open \u2197";

    head.append(title, openLabel);

    const snippet = document.createElement("p");
    snippet.className = "result-snippet";
    for (const segment of buildSnippetAll(item.text, result.matches)) {
      if (segment.match) {
        const mark = document.createElement("mark");
        mark.textContent = segment.text;
        snippet.append(mark);
      } else {
        snippet.append(document.createTextNode(segment.text));
      }
    }

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = item.category;

    anchor.append(head, snippet, badge);
    li.append(anchor);
    fragment.append(li);
  });

  els.resultsList.append(fragment);
}

function renderSuggestions(query, results) {
  const weak = results.length === 0 || results[0].score > 0.55;
  if (!query || !weak || !state.engine) {
    els.suggestions.hidden = true;
    els.suggestionChips.replaceChildren();
    return;
  }

  const suggestions = state.engine.suggest(query);
  if (!suggestions.length) {
    els.suggestions.hidden = true;
    return;
  }

  els.suggestionChips.replaceChildren();
  for (const suggestion of suggestions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = suggestion;
    chip.addEventListener("click", () => {
      els.input.value = suggestion;
      state.query = suggestion;
      els.clear.hidden = false;
      render();
      els.input.focus({ preventScroll: true });
    });
    els.suggestionChips.append(chip);
  }
  els.suggestions.hidden = false;
}

function setSelected(index) {
  state.selected = index;

  for (const li of els.resultsList.children) {
    const anchor = li.firstElementChild;
    const isSelected = Number(anchor?.dataset.index) === index;
    li.setAttribute("aria-selected", isSelected ? "true" : "false");
    anchor?.classList.toggle("is-selected", isSelected);
    if (isSelected) anchor?.scrollIntoView({ block: "nearest" });
  }

  if (index >= 0) {
    els.input.setAttribute("aria-activedescendant", `result-${index}`);
  } else {
    els.input.removeAttribute("aria-activedescendant");
  }
}

function plural(count) {
  return count === 1 ? "" : "s";
}
