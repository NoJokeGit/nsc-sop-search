// Pulls the matching steps out of whichever guide ranked first. Quotes the
// steps verbatim and gives up quietly when nothing lines up well enough.

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

// Raise these and answers get rarer but safer.
export const ANSWER_CONFIG = {
  // A single word is too vague to quote steps at.
  minQueryWords: 2,
  // How confident the search has to be before we quote anything.
  minGuideConfidence: 0.3,
  // Show at most this many steps.
  windowSize: 3,
  // Fewer than this and it isn't really an answer.
  minMatchingSteps: 2,
  // How much of the query one step has to cover.
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

// Splits the query into concepts. A synonym group counts once, so log in and
// sign in don't get treated as two separate things.
function buildConcepts(query, synonymGroups = []) {
  const raw = words(query).filter((word) => word.length > 1);
  const groups = synonymGroups.map((group) => group.map(normalize));

  const concepts = [];
  const usedGroups = new Set();
  const consumedWords = new Set();
  const haystackQuery = normalize(query);

  // Longest phrase first, so cant log in doesn't also get counted as log in.
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
    // Already covered by a longer match.
    const words_ = phrase.split(" ");
    if (words_.every((word) => consumedWords.has(word))) continue;
    usedGroups.add(group[0]);
    concepts.push({ variants: group, label: phrase });
    for (const word of words_) consumedWords.add(word);
  }

  for (const word of raw) {
    // Words used by a matched phrase don't get a second turn.
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

// Same prefix rule as search.js.
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

// Returns null most of the time. Someone on a call is better off with no answer
// than a wrong one.
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
  // One concept is fine when both words are the same group (export report),
  // but then the step has to actually contain it.
  const strictSingle = concepts.length === 1;

  const steps = top.item.steps;
  const scored = steps.map((step) => ({
    n: step.n,
    t: step.t,
    ...scoreStep(step.t, concepts),
  }));

  // Look for a run of consecutive steps. Jumps around the guide don't read well.
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
  // If the strongest step is weak this is just noise sitting next to a match.
  const floor = strictSingle ? 0.99 : ANSWER_CONFIG.minStepScore;
  if (Math.max(...window.map((step) => step.score)) < floor) return null;

  return { guide: top.item, steps: window };
}

// Used by the tests.
export { buildConcepts, scoreStep };
