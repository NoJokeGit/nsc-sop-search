import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createEngine } from "../assets/search.js";

const here = dirname(fileURLToPath(import.meta.url));

async function loadJson(relative) {
  return JSON.parse(await readFile(join(here, relative), "utf8"));
}

// Phrase someone might actually say, and the guide that should come back first.
// Titles are real, so this fails if a scrape drops or renames a guide. Where two
// SOPs cover the same request, either is accepted.
const CASES = [
  // --- sign-in and passwords ------------------------------------------
  { q: "cant log in", want: ["How to Log In to the NSC SafetyAtlas Portal"] },
  { q: "can't log in", want: ["How to Log In to the NSC SafetyAtlas Portal"] },
  // Ambiguous on purpose: two different login SOPs exist.
  { q: "login", want: ["How to Log In to the NSC SafetyAtlas Portal", "Instuctor Login and Profile"] },
  { q: "sign in problem", want: ["How to Log In to the NSC SafetyAtlas Portal"] },
  { q: "log in to portal", want: ["How to Log In to the NSC SafetyAtlas Portal"] },
  { q: "locked out", want: ["How to Log In to the NSC SafetyAtlas Portal"] },

  // --- seats ------------------------------------------------------------
  { q: "assign a seat", want: ["Assign Seats in SafetyAtlas"] },
  { q: "seat assignment", want: ["Assign Seats in SafetyAtlas"] },
  { q: "reschedule seats", want: ["How to Reschedule Seats in SafetyAtlas"] },
  { q: "move seat to organization", want: ["Move Course Seat From A Retail Account To An Organization Account"] },
  { q: "seat inventory", want: ["Seat (Course Inventory) Management"] },
  { q: "unassign a course", want: ["How To Unassign A Learner From A Safety Course"] },

  // --- students and classes --------------------------------------------
  { q: "student lookup", want: ["Student Management", "Student Management (TC)"] },
  { q: "find a student", want: ["Student Management", "Student Management (TC)"] },
  { q: "reschedule class", want: ["How to Reschedule a Student's Course"] },
  { q: "register a student", want: ["Registering Students for Courses", "Registering Students for Courses (TC)"] },
  { q: "class roster", want: ["Class Management", "Class Management and Student Communications"] },

  // --- organization -----------------------------------------------------
  { q: "register an organization", want: ["Registering An Organization in SafetyAtlas"] },
  { q: "organization profile", want: ["Organization Profile Details", "Organization Management"] },
  { q: "add a location", want: ["Manage Organization Locations in SafetyAtlas", "Location Management"] },
  { q: "bulk invite", want: ["Bulk Invite Employees in SafetyAtlas"] },
  { q: "invite my team", want: ["Bulk Invite Employees in SafetyAtlas"] },

  // --- permissions and admin -------------------------------------------
  { q: "admin permissions", want: ["Managing Organization Admin Permissions", "Admin Users Management (TC)"] },
  { q: "add an administrator", want: ["Admin Users Management (TC)", "Managing Organization Admin Permissions"] },

  // --- reports, certs, refunds -----------------------------------------
  { q: "export a report", want: ["How To Generate And Export Organization Reports"] },
  { q: "certificate", want: ["Certificate Configurator (CH)"] },
  { q: "refund", want: ["View Refund Policies in SafetyAtlas", "View Refund Policies in SafetyAtlas (TC)"] },
  { q: "refund policy", want: ["View Refund Policies in SafetyAtlas", "View Refund Policies in SafetyAtlas (TC)"] },

  // --- typos -----------------------------------------------------------
  { q: "certifcate", want: ["Certificate Configurator (CH)"] },
  { q: "reschedual", want: ["How to Reschedule a Student's Course", "How to Reschedule Seats in SafetyAtlas"] },
  { q: "organizaton management", want: ["Organization Management"] },
  { q: "instuctor", want: ["Instructor Management (TC)", "Instuctor Login and Profile"] },

  // --- word order -------------------------------------------------------
  { q: "seat organization move", want: ["Move Course Seat From A Retail Account To An Organization Account"] },
  { q: "report export organization", want: ["How To Generate And Export Organization Reports"] },
];

const NEGATIVE = ["xyzzy nonsense", "zzzz qqqq", "flibbertigibbet"];

const index = await loadJson("../data/search-index.json");
const synonyms = await loadJson("../data/synonyms.json");
const engine = createEngine(index.guides, synonyms.groups);

const top = (query) => engine.search(query)[0]?.item?.title ?? null;

describe("search quality", () => {
  for (const { q, want } of CASES) {
    it(`"${q}" -> ${want[0]}`, () => {
      const result = top(q);
      assert.ok(result !== null, `no result for "${q}" (wanted: ${want.join(" or ")})`);
      assert.ok(
        want.includes(result),
        `"${q}" returned "${result}" (wanted: ${want.join(" or ")})`,
      );
    });
  }
});

describe("no false positives", () => {
  for (const q of NEGATIVE) {
    it(`"${q}" returns nothing`, () => {
      assert.equal(top(q), null, `"${q}" should not match any guide`);
    });
  }
});

describe("category filter", () => {
  it("filters results to one category", () => {
    const results = engine.search("organization", { category: "orgs" });
    assert.ok(results.length > 0, "expected results inside Organizations & locations");
    for (const result of results) {
      assert.equal(result.item.category, "orgs");
    }
  });

  it("every guide belongs to a declared category", () => {
    const taxonomy = JSON.parse(
      readFileSync(join(here, "../data/categories.json"), "utf8"),
    );
    const declared = new Set(taxonomy.categories.map((entry) => entry.id));
    for (const guide of index.guides) {
      assert.ok(
        declared.has(guide.category),
        `unknown category "${guide.category}" on ${guide.id}`,
      );
    }
  });

  it("badges carry a scope with no LMS name in it", () => {
    for (const guide of index.guides) {
      assert.ok(guide.scope, `missing scope on ${guide.id}`);
      assert.doesNotMatch(guide.scope, /steve/i);
    }
  });
});

describe("result shape", () => {
  it("every result carries the fields the UI needs", () => {
    for (const result of engine.search("seat")) {
      assert.equal(typeof result.item.title, "string");
      assert.match(result.item.url, /^https:\/\/scribehow\.com\//);
      assert.equal(typeof result.item.category, "string");
      assert.equal(typeof result.item.text, "string");
      assert.ok(result.score >= 0 && result.score <= 1);
    }
  });

  it("ranks an exact title match first", () => {
    assert.equal(top("Certificate Configurator"), "Certificate Configurator (CH)");
  });
});

describe("index integrity", () => {
  it("has the expected guide count", () => {
    assert.ok(index.guides.length >= 45, `only ${index.guides.length} guides`);
  });

  it("every guide has a viewer URL, a title and body text", () => {
    for (const guide of index.guides) {
      assert.match(guide.url, /\/viewer\//, `bad url: ${guide.url}`);
      assert.ok(guide.title.length > 3, `short title: ${guide.id}`);
      assert.ok(guide.text.length > 40, `short text: ${guide.id}`);
    }
  });

  it("guide ids are unique", () => {
    const ids = new Set(index.guides.map((guide) => guide.id));
    assert.equal(ids.size, index.guides.length);
  });
});

describe("did you mean", () => {
  it("suggests a term for a misspelling", () => {
    const suggestions = engine.suggest("certifcate");
    assert.ok(suggestions.length > 0, "expected at least one suggestion");
    assert.ok(
      suggestions.some((s) => s.startsWith("certificate")),
      `expected a certificate suggestion, got: ${suggestions.join(", ")}`,
    );
  });
});
