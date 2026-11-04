import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createEngine } from "../assets/search.js";
import { buildAnswer, buildConcepts } from "../assets/answers.js";

const here = dirname(fileURLToPath(import.meta.url));

async function loadJson(relative) {
  return JSON.parse(await readFile(join(here, relative), "utf8"));
}

const index = await loadJson("../data/search-index.json");
const synonyms = await loadJson("../data/synonyms.json");
const engine = createEngine(index.guides, synonyms.groups);

const answerFor = (query) =>
  buildAnswer(query, engine.search(query), synonyms.groups);

describe("answers: quotes real steps", () => {
  const cases = [
    { q: "how do i assign a seat to a learner", guide: "Assign Seats in SafetyAtlas" },
    { q: "reschedule a student", guide: "How to Reschedule a Student's Course" },
    { q: "certificate template", guide: "Certificate Configurator (CH)" },
    { q: "add a location", guide: "Manage Organization Locations in SafetyAtlas" },
  ];

  for (const { q, guide } of cases) {
    it(`"${q}" answers from ${guide}`, () => {
      const answer = answerFor(q);
      assert.ok(answer, `expected an answer for "${q}"`);
      assert.equal(answer.guide.title, guide);
      assert.ok(answer.steps.length >= 2, "expected at least two steps");
    });
  }
});

describe("answers: every step is genuine", () => {
  it("quoted text exists verbatim in the source guide", () => {
    const answer = answerFor("how do i assign a seat to a learner");
    assert.ok(answer);
    const source = answer.guide.steps.map((step) => step.t);
    for (const step of answer.steps) {
      assert.ok(
        source.includes(step.t),
        `step not found in guide: ${step.t.slice(0, 50)}`,
      );
      assert.equal(typeof step.n, "number");
    }
  });

  it("steps come back in order", () => {
    const answer = answerFor("certificate template");
    assert.ok(answer);
    const numbers = answer.steps.map((step) => step.n);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  });
});

describe("answers: stays silent when unsure", () => {
  for (const q of ["xyzzy nonsense", "zzzz qqqq", "seat", "help"]) {
    it(`"${q}" produces no answer`, () => {
      assert.equal(answerFor(q), null);
    });
  }
});

describe("answers: concept building", () => {
  it("counts a phrase synonym as one concept", () => {
    const concepts = buildConcepts("cant log in", synonyms.groups);
    const labels = concepts.map((concept) => concept.label);
    // log in is one idea, not also "log" and "in".
    assert.equal(labels.filter((label) => label.includes("log")).length, 1);
  });

  it("does not treat stopwords as concepts", () => {
    const concepts = buildConcepts("how do i do that", synonyms.groups);
    assert.equal(concepts.length, 0);
  });
});
