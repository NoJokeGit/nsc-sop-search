import Fuse from "../vendor/fuse.min.mjs";

// Search over the SOP index. An exact phrase in the title beats the same phrase
// in body text, and synonyms score slightly lower so real matches win. Fuzzy
// per-word is the fallback for typos.

export const CONFIG = {
  fieldWeight: { title: 1, tags: 0.72, category: 0.5, text: 0.42 },
  synonymDiscount: 0.78,
  phraseSubDiscount: 0.78,
  phraseBonus: 1.15,
  termScale: 0.8,
  fuzzyThreshold: 0.34,
  fuzzyBase: 0.55,
  fuzzySpan: 0.45,
  fuzzyMinQuality: 0.25,
  fuzzyMinLength: 5,
  // mean = how much of the query matched, best = did any one word land cleanly
  meanShare: 0.6,
  bestShare: 0.4,
  coveragePenalty: 0.7,
  minScore: 0.3,
  maxVariants: 10,
};

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "is", "it",
  "its", "how", "do", "does", "i", "my", "me", "we", "you", "your", "with",
  "at", "be", "can", "cant", "cannot", "from", "that", "this", "was", "were",
  "what", "when", "where", "which", "who", "why", "if", "so", "as", "by",
  "not", "no", "yes", "up", "out", "get", "got", "there", "then", "than",
  "problem", "problems", "issue", "issues", "help", "need", "needs", "want",
  "please", "stuck", "error", "errors", "question", "anyone", "someone",
]);

export function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value) {
  return normalize(value).split(" ").filter(Boolean);
}

function meaningful(value) {
  return words(value).filter(
    (word) => word.length > 1 && !STOPWORDS.has(word),
  );
}

// Normalize once up front so scoring doesn't redo it per comparison.
function prepare(entry) {
  return {
    ...entry,
    title: String(entry.title ?? "").trim(),
    haystack: {
      title: normalize(entry.title),
      tags: normalize((entry.tags ?? []).join(" ")),
      category: normalize(entry.category),
      text: normalize(entry.text),
    },
  };
}

// Prefix match. Words of 4+ chars can match the start of a longer one so typing
// feels live (pass -> password). Shorter words need a whole word, otherwise add
// starts matching address and in starts matching instructor.
function contains(haystack, phrase) {
  if (!phrase) return 0;
  const padded = " " + haystack;
  if (phrase.includes(" ")) return padded.includes(" " + phrase) ? 1 : 0;
  for (const candidate of wordForms(phrase)) {
    if (candidate.length >= 4) {
      if (padded.includes(" " + candidate)) return 1;
    } else if (padded.includes(" " + candidate + " ")) {
      return 1;
    }
  }
  return 0;
}

// Cheap suffix stripping for verb tense: moved -> move, resetting -> reset.
export function wordForms(word) {
  const forms = new Set([word]);
  const add = (value) => {
    if (value && value.length >= 3) forms.add(value);
  };
  if (word.endsWith("ing")) {
    add(word.slice(0, -3));
    add(word.slice(0, -3) + "e");
  }
  if (word.endsWith("ed")) {
    add(word.slice(0, -1));
    add(word.slice(0, -2));
    add(word.slice(0, -2) + "e");
  }
  if (word.endsWith("ies")) add(word.slice(0, -3) + "y");
  if (word.endsWith("es")) add(word.slice(0, -2));
  if (word.endsWith("s")) add(word.slice(0, -1));
  return [...forms];
}

// Highest weight any field gives this phrase. 0 means it isn't there.
function phraseScore(entry, phrase) {
  const weights = CONFIG.fieldWeight;
  let best = 0;
  for (const field of ["title", "tags", "category", "text"]) {
    if (contains(entry.haystack[field], phrase)) {
      best = Math.max(best, weights[field]);
    }
  }
  return best;
}

// Per-word score. Exact containment first, fuzzy as the typo fallback.
function termScore(entry, term) {
  const weights = CONFIG.fieldWeight;
  let best = 0;
  for (const field of ["title", "tags", "category", "text"]) {
    if (contains(entry.haystack[field], term)) {
      best = Math.max(best, weights[field]);
    }
  }
  return best;
}

function buildVariants(rawQuery, synonymGroups) {
  const literal = normalize(rawQuery);
  if (!literal) return [];

  const variants = [{ value: literal, penalty: 1, kind: "literal" }];
  const literalWords = literal.split(" ");

  for (const group of synonymGroups) {
    const phrases = group.map(normalize).filter(Boolean);
    for (const phrase of phrases) {
      if (!phrase.includes(" ")) continue;
      if (!literal.includes(phrase)) continue;
      for (const replacement of phrases) {
        if (replacement === phrase) continue;
        const value = literal.replace(phrase, replacement).trim();
        if (value !== literal) {
          variants.push({
            value,
            penalty: CONFIG.phraseSubDiscount,
            kind: "phrase",
            phrase: replacement,
          });
        }
      }
    }
  }

  for (const term of literalWords) {
    if (STOPWORDS.has(term) || term.length < 2) continue;
    const group = synonymGroups.find((candidate) =>
      candidate.map(normalize).includes(term),
    );
    if (!group) continue;
    for (const synonym of group) {
      const normalizedSynonym = normalize(synonym);
      if (!normalizedSynonym || normalizedSynonym === term) continue;
      const value = literalWords
        .map((word) => (word === term ? normalizedSynonym : word))
        .join(" ");
      if (value !== literal) {
        variants.push({
          value,
          penalty: CONFIG.synonymDiscount,
          kind: "term",
        });
      }
    }
  }

  const seen = new Set();
  return variants
    .filter((variant) => {
      if (seen.has(variant.value)) return false;
      seen.add(variant.value);
      return true;
    })
    .slice(0, CONFIG.maxVariants);
}

export function createEngine(rawIndex, synonymGroups = []) {
  const index = rawIndex.map(prepare);
  const synonymList = Array.isArray(synonymGroups) ? synonymGroups : [];

  const fuzzy = new Fuse(index, {
    includeScore: true,
    includeMatches: true,
    ignoreLocation: true,
    threshold: CONFIG.fuzzyThreshold,
    minMatchCharLength: 2,
    keys: ["title", "tags", "category", "text"],
  });

  const vocabulary = buildVocabulary(index);
  const suggester = new Fuse(vocabulary, {
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.6,
    minMatchCharLength: 3,
  });

  function search(rawQuery, options = {}) {
    const variants = buildVariants(rawQuery, synonymList);
    if (!variants.length) return [];

    const category = options.category ?? "";
    const scored = new Map();

    // Typo lookup, longer words only. Short ones fuzzy into unrelated neighbours.
    const fuzzyByWord = new Map();
    for (const word of meaningful(normalize(rawQuery))) {
      if (word.length < CONFIG.fuzzyMinLength) continue;
      const hits = new Map();
      for (const hit of fuzzy.search(word)) {
        // A near miss in the title is worth more than one buried in body text.
        const field = hit.matches?.[0]?.key ?? "text";
        const weight = CONFIG.fieldWeight[field] ?? CONFIG.fieldWeight.text;
        const quality = 1 - hit.score;
        const previous = hits.get(hit.item.id) ?? 0;
        hits.set(hit.item.id, Math.max(previous, quality * weight));
      }
      fuzzyByWord.set(word, hits);
    }

    for (const variant of variants) {
      const allWords = normalize(variant.value).split(" ").filter(Boolean);
      const variantWords = meaningful(variant.value);
      if (!variantWords.length) continue;
      // Multi-word input counts as a phrase even if some words are stopwords.
      const isPhrase = allWords.length > 1;

      for (const entry of index) {
        if (category && entry.category !== category) continue;

        let best = 0;

        // Phrase pass. Strongest signal we have.
        if (isPhrase) {
          const exact = phraseScore(entry, variant.value);
          if (exact > 0) {
            // Whole phrase outranks a single word.
            best = Math.max(best, Math.min(1, exact * CONFIG.phraseBonus));
          }
        }

        // For a substituted phrase, score the replacement itself.
        if (variant.phrase) {
          const substituted = phraseScore(entry, variant.phrase);
          if (substituted > 0) {
            best = Math.max(
              best,
              Math.min(1, substituted * CONFIG.phraseBonus),
            );
          }
        }

        // Coverage and best-term blend, scaled by how many words matched.
        let sum = 0;
        let top = 0;
        let matched = 0;
        for (const word of variantWords) {
          // Phrase subs match as a phrase, or sign in starts hitting sign up.
          if (variant.kind === "phrase") break;
          const exact = termScore(entry, word);
          // Close typos score nearly full. Distant ones are dropped.
          const quality = fuzzyByWord.get(word)?.get(entry.id) ?? 0;
          const fuzzyWeighted =
            quality >= CONFIG.fuzzyMinQuality
              ? Math.min(1, CONFIG.fuzzyBase + CONFIG.fuzzySpan * quality)
              : 0;
          const value = Math.max(exact, fuzzyWeighted);
          if (value > 0) matched += 1;
          sum += value;
          top = Math.max(top, value);
        }
        const coverage = matched / variantWords.length;
        const blended =
          ((sum / variantWords.length) * CONFIG.meanShare +
            top * CONFIG.bestShare) *
          (1 - CONFIG.coveragePenalty + CONFIG.coveragePenalty * coverage);
        best = Math.max(best, blended * CONFIG.termScale);

        if (best <= 0) continue;

        const value = best * variant.penalty;
        const previous = scored.get(entry.id);
        if (!previous || value > previous.score) {
          scored.set(entry.id, {
            item: entry,
            score: value,
            matchedTerm: variant.value,
            matchedPhrase: variant.phrase ?? null,
            variantKind: variant.kind,
            isSynonymMatch: variant.penalty < 1,
          });
        }
      }
    }

    return [...scored.values()]
      .filter((result) => result.score >= CONFIG.minScore)
      .sort((a, b) => b.score - a.score)
      .map((result) => ({
        item: result.item,
        score: 1 - Math.min(result.score, 1),
        // Highlight any query word that actually appears in the body.
        matches: buildMatches(
          result.item,
          variants.flatMap((variant) => [variant.value, variant.phrase]),
        ),
        matchedTerm: result.matchedTerm,
        variantKind: result.variantKind,
        isSynonymMatch: result.isSynonymMatch,
      }));
  }

  function suggest(rawQuery, limit = 3) {
    const suggestions = new Set();
    for (const word of words(rawQuery)) {
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      for (const hit of suggester.search(word).slice(0, 2)) {
        if (hit.item !== word) suggestions.add(hit.item);
        if (suggestions.size >= limit) return [...suggestions];
      }
    }
    return [...suggestions];
  }

  return { search, suggest };
}

// Highlight ranges, computed against the original text. The normalized copy is
// lowercased and stripped, so its offsets don't line up with what's rendered.
function buildMatches(entry, candidates) {
  const text = String(entry.text ?? "");
  if (!text) return [];
  const lower = text.toLowerCase();

  const needles = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalize(candidate);
    if (normalized.includes(" ")) needles.add(normalized);
    for (const word of normalized.split(" ")) {
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      needles.add(word);
    }
  }

  const ranges = [];
  for (const needle of needles) {
    let from = 0;
    while (from <= lower.length) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      ranges.push([at, at + needle.length - 1]);
      from = at + needle.length;
    }
  }
  if (!ranges.length) return [];

  // Widen to whole words. A prefix hit inside Unassigned otherwise slices the
  // word in half and reads like a typo.
  const isWordChar = (char) => /[A-Za-z0-9']/.test(char);
  const snapped = ranges.map(([start, end]) => {
    let left = start;
    let right = end;
    while (left > 0 && isWordChar(text[left - 1])) left--;
    while (right < text.length - 1 && isWordChar(text[right + 1])) right++;
    return [left, right];
  });

  snapped.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of snapped) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }
  return [{ key: "text", indices: merged }];
}
export function buildVocabulary(index) {
  const found = new Set();
  for (const entry of index) {
    for (const word of meaningful(entry.title)) found.add(word);
    for (const word of meaningful(entry.category)) found.add(word);
    for (const tag of entry.tags ?? []) {
      for (const word of meaningful(tag)) found.add(word);
    }
  }
  return [...found];
}
