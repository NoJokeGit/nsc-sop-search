import Fuse from "../vendor/fuse.min.mjs";

/**
 * Search engine for the SOP index.
 *
 * Ranking is phrase-first: an exact phrase in the title beats the same phrase in
 * the body, and a synonym phrase is discounted slightly so a literal match
 * always outranks an inferred one. Fuzzy per-word matching is the fallback that
 * catches typos such as "pasword".
 */

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
  /** Blend of mean term coverage (precision) and best term (recall). */
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

/** Collapse an entry into the normalized haystacks used for scoring. */
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

/**
 * Match a phrase against a field.
 *
 * A word of four or more characters may match the start of a longer word
 * ("pass" -> "password") so search feels live while typing. Shorter words must
 * match a whole word, otherwise "add" matches "address" and "in" matches
 * "instructor". Multi-word phrases match as plain substrings at a word start.
 */
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

/**
 * Light suffix stripping so "moved" finds "move" and "resetting" finds "reset".
 * Deliberately small: this is for verb tense, not full stemming.
 */
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

/**
 * Best field score for an exact phrase.
 * Returns 0 when the phrase is absent from every field.
 */
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

/**
 * Per-word score: exact containment first, fuzzy match as the typo fallback.
 */
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

    // Fuzzy per-word lookup for the literal query, so typos still match.
    // Restricted to longer words: short ones fuzzy-match unrelated neighbours
    // ("add" -> "and") and inflate the score.
    const fuzzyByWord = new Map();
    for (const word of meaningful(normalize(rawQuery))) {
      if (word.length < CONFIG.fuzzyMinLength) continue;
      const hits = new Map();
      for (const hit of fuzzy.search(word)) {
        // Where the typo matched matters: a near miss in the title is worth far
        // more than the same near miss buried in the body text.
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
      // A phrase is any multi-word input, even when some words are stopwords
      // ("locked out"), otherwise the phrase pass never runs for it.
      const isPhrase = allWords.length > 1;

      for (const entry of index) {
        if (category && entry.category !== category) continue;

        let best = 0;

        // Phrase pass: strongest signal, only for multi-word variants.
        if (isPhrase) {
          const exact = phraseScore(entry, variant.value);
          if (exact > 0) {
            // An exact phrase hit is worth more than a single matching word.
            best = Math.max(best, Math.min(1, exact * CONFIG.phraseBonus));
          }
        }

        // A substituted phrase ("sign in" -> "login") is scored on the
        // replacement itself, so it competes with literal word matches.
        if (variant.phrase) {
          const substituted = phraseScore(entry, variant.phrase);
          if (substituted > 0) {
            best = Math.max(
              best,
              Math.min(1, substituted * CONFIG.phraseBonus),
            );
          }
        }

        // Term pass: blend of mean coverage and the single best term, scaled by
        // how many of the query words actually matched. A guide that covers
        // every word outranks one that matches a single common word strongly.
        let sum = 0;
        let top = 0;
        let matched = 0;
        for (const word of variantWords) {
          // A phrase substitution must match as a phrase. Letting its words
          // fall back to loose matching makes "sign in" hit "sign up".
          if (variant.kind === "phrase") break;
          const exact = termScore(entry, word);
          // A close typo counts almost as much as an exact hit; a distant one
          // is ignored so it cannot drag unrelated guides into the results.
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
        // Highlight any query (or synonym) word that really appears in the
        // body, not just the variant that happened to win.
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

/**
/**
 * Ranges to highlight in the guide body.
 *
 * Indices must be computed against the ORIGINAL text, not the normalized
 * haystack: normalization lowercases and strips punctuation, so offsets would
 * not line up and highlights would land a few characters off.
 */
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

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
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
