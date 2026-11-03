/**
 * Step-level answers.
 *
 * Given a query and the guide the search engine ranked first, find the steps
 * inside that guide which actually address the question. This is deliberately
 * not a language model: it only ever quotes real steps, so it cannot invent a
 * procedure. When it is unsure it returns nothing and the caller stays quiet.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "is", "it",
  "its", "how", "do", "does", "did", "i", "my", "me", "we", "you", "your",
  "with", "at", "be", "can", "cant", "cannot", "from", "that", "this", "was",
  "were", "what", "when", "where", "which", "who", "why", "if", "so", "as",
  "by", "not", "no", "yes", "up", "out", "get", "got", "there", "then",
  "than", "need", "needs", "want", "wants", "please", "help", "someone",
  "anyone", "problem", "issue", "error", "again", "back", "into", "onto",
  "about", "would", "should", "could", "some", "any", "all", "just", "also",
]);

/** Tunables. Raising these makes answers rarer but more trustworthy. */
export const ANSWER_CONFIG = {
  /** Minimum words in the raw query before an answer is attempted at all. */
  minQueryWords: 2,
  /** The top-ranked guide must be at least this strong (0..1, higher = better). */
  minGuideConfidence: 0.3,
  /** Steps in the chosen window. */
  windowSize: 3,
  /** At least this many steps in the window must match something. */
  minMatchingSteps: 2,
  /** Minimum share of query concepts a step must hit to count as a match. */
  minStepScore: 0.34,
};

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value) {
  return normalize(value).split(" ").filter(Boolean);
}

/**
 * Turn a query into concept groups. Each group is a set of interchangeable
 * words, so "log in" and "sign in" count as one concept rather than two.
 */
function buildConcepts(query, synonymGroups = []) {
  const raw = words(query).filter((word) => word.length > 1);
  const groups = synonymGroups.map((group) => group.map(normalize));

  const concepts = [];
  const usedGroups = new Set();
  const consumedWords = new Set();
  const haystackQuery = normalize(query);

  // Multi-word phrases first, longest first, so "cant log in" is one concept
  // and its shorter sibling "log in" does not get counted again.
  const phraseCandidates = [];
  for (const group of groups) {
    for (const phrase of group) {
      if (!phrase.includes(" ")) continue;
      if (!haystackQuery.includes(phrase)) continue;
      phraseCandidates.push({ group, phrase });
    }
  }
  phraseCandidates.sort((a, b) => b.phrase.length - a.phrase.length);

  for (const { group, phrase } of phraseCandidates) {
    if (usedGroups.has(group[0])) continue;
    // Skip a phrase whose words are already fully covered by a longer match.
    const words_ = phrase.split(" ");
    if (words_.every((word) => consumedWords.has(word))) continue;
    usedGroups.add(group[0]);
    concepts.push({ variants: group, label: phrase });
    for (const word of words_) consumedWords.add(word);
  }

  for (const word of raw) {
    // A word that was already part of a matched phrase must not become its own
    // concept, or it silently multiplies the denominator.
    if (consumedWords.has(word)) continue;
    if (STOPWORDS.has(word)) continue;

    const group = groups.find((candidate) => candidate.includes(word));
    if (group) {
      if (usedGroups.has(group[0])) continue;
      usedGroups.add(group[0]);
      concepts.push({ variants: group, label: word });
    } else if (!usedGroups.has(word)) {
      usedGroups.add(word);
      concepts.push({ variants: [word], label: word });
    }
  }

  return concepts;
}

/** Prefix rule shared with the search: short words must match whole. */
function contains(haystack, term) {
  const padded = ` ${haystack} `;
  if (term.includes(" ")) return padded.includes(` ${term}`);
  if (term.length >= 4) return padded.includes(` ${term}`);
  return padded.includes(` ${term} `);
}

function scoreStep(stepText, concepts) {
  const haystack = normalize(stepText);
  const matched = [];
  for (const concept of concepts) {
    if (concept.variants.some((variant) => contains(haystack, variant))) {
      matched.push(concept.label);
    }
  }
  return {
    matched,
    score: concepts.length ? matched.length / concepts.length : 0,
  };
}

/**
 * Build an answer for a query given ranked search results.
 *
 * Returns null far more often than not, by design: a wrong procedure is worse
 * than no answer on a live call.
 */
export function buildAnswer(query, results, synonymGroups = []) {
  if (words(query).filter((word) => word.length > 1).length < ANSWER_CONFIG.minQueryWords) {
    return null;
  }

  const top = results?.[0];
  if (!top || !Array.isArray(top.item?.steps) || top.item.steps.length < 2) {
    return null;
  }
  // Search scores run 0 (perfect) to 1 (weak).
  if (1 - top.score < ANSWER_CONFIG.minGuideConfidence) return null;

  const concepts = buildConcepts(query, synonymGroups);
  if (!concepts.length) return null;
  // One concept is allowed (for example "export report", where both words are
  // the same synonym group), but then every shown step must actually contain
  // it, so a bare one-word hit cannot drag in unrelated steps.
  const strictSingle = concepts.length === 1;

  const steps = top.item.steps;
  const scored = steps.map((step) => ({
    n: step.n,
    t: step.t,
    ...scoreStep(step.t, concepts),
  }));

  // Find the window of consecutive steps with the highest total score. Reading
  // a contiguous run gives an answer that makes sense in order.
  let bestScore = -1;
  let bestIndex = -1;
  for (let i = 0; i <= scored.length - 2; i++) {
    const window = scored.slice(i, i + ANSWER_CONFIG.windowSize);
    const total = window.reduce((sum, step) => sum + step.score, 0);
    const matching = window.filter((step) => step.score > 0).length;
    if (matching < ANSWER_CONFIG.minMatchingSteps) continue;
    if (total > bestScore) {
      bestScore = total;
      bestIndex = i;
    }
  }

  if (bestIndex < 0) return null;

  const window = scored
    .slice(bestIndex, bestIndex + ANSWER_CONFIG.windowSize)
    .filter((step) => step.score > 0);

  if (window.length < ANSWER_CONFIG.minMatchingSteps) return null;
  // The best step must clear the bar, or this is just noise that happens to sit
  // next to a match.
  const floor = strictSingle ? 0.99 : ANSWER_CONFIG.minStepScore;
  if (Math.max(...window.map((step) => step.score)) < floor) return null;

  return { guide: top.item, steps: window };
}

/** Exposed for the test suite. */
export { buildConcepts, scoreStep };
