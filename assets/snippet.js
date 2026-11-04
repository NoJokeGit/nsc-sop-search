const SNIPPET_LENGTH = 150;
const LEAD = 46;

// Snippet around the best hit in a field. Returns [{ text, match }] segments
// so the caller can build nodes directly instead of injecting HTML.
export function buildSnippet(text, matches = []) {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return [];

  const best = pickBestMatch(matches);
  if (best) {
    const start = Math.max(0, best.start - LEAD);
    const end = Math.min(source.length, start + SNIPPET_LENGTH);
    return withHighlights(
      source.slice(start, end),
      start,
      [best],
      start > 0,
      end < source.length,
    );
  }

  // Matched on title or tag, so just show the start of the body.
  const end = Math.min(source.length, SNIPPET_LENGTH);
  const segments = [{ text: source.slice(0, end), match: false }];
  if (end < source.length) segments.push({ text: "\u2026", match: false });
  return segments;
}

function pickBestMatch(matches) {
  const bodyMatches = matches.filter(
    (match) => match.key === "text" && match.indices?.length,
  );
  if (!bodyMatches.length) return null;

  let best = null;
  for (const match of bodyMatches) {
    for (const [start, end] of match.indices) {
      const length = end - start;
      if (!best || length > best.length) {
        best = { start, end, length };
      }
    }
  }
  return best;
}

function withHighlights(window, offset, ranges, hasLead, hasTail) {
  const segments = [];
  if (hasLead) segments.push({ text: "\u2026", match: false });

  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(0, range.start - offset);
    const end = Math.min(window.length - 1, range.end - offset);
    if (end < 0 || start >= window.length) continue;

    if (start > cursor) {
      segments.push({ text: window.slice(cursor, start), match: false });
    }
    segments.push({ text: window.slice(start, end + 1), match: true });
    cursor = end + 1;
  }

  if (cursor < window.length) {
    segments.push({ text: window.slice(cursor), match: false });
  }
  if (hasTail) segments.push({ text: "\u2026", match: false });

  return segments.filter((segment) => segment.text.length > 0);
}

// Same idea, but when several query words hit inside the body text.
export function buildSnippetAll(text, matches = []) {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!source) return [];

  const bodyMatches = matches.filter(
    (match) => match.key === "text" && match.indices?.length,
  );
  if (!bodyMatches.length) return buildSnippet(text, matches);

  const ranges = bodyMatches.flatMap((match) =>
    match.indices.map(([start, end]) => ({ start, end })),
  );

  const anchor = ranges.reduce(
    (best, range) => (!best || range.start < best.start ? range : best),
    null,
  );
  const start = Math.max(0, anchor.start - LEAD);
  const end = Math.min(source.length, start + SNIPPET_LENGTH);

  const clipped = ranges
    .filter((range) => range.end >= start && range.start <= end)
    .map((range) => ({
      start: Math.max(start, range.start),
      end: Math.min(end, range.end),
    }))
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const range of clipped) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return withHighlights(
    source.slice(start, end),
    start,
    merged,
    start > 0,
    end < source.length,
  );
}
