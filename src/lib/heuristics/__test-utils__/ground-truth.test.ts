// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the ground-truth scorer (#654).
 *
 * Two things carry the weight, and they pull in opposite directions.
 *
 * The scorer must be BLIND to restatements of the same fact — a reformatted
 * phone, a "Current" the parser carries as `is_current`, a degree the parser
 * splits into `degree` + `field` — because a scoreboard whose loudest findings
 * are its own modelling choices is worse than no scoreboard.
 *
 * And it must NOT be blind to anything else. Every corpus gate in this repo
 * already tolerates a stably wrong parse; this one exists to stop doing that, so
 * a dropped token, a glued-on location and a fabricated value each have a test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isExact,
  precision,
  readTruth,
  recall,
  scoreAgainstTruth,
  type FixtureTruth,
  type ParsedForTruth,
} from "./ground-truth.ts";

const EMPTY_PARSE: ParsedForTruth = { experience: [], education: [], skills: [] };

function truth(partial: Partial<FixtureTruth>): FixtureTruth {
  return {
    schemaVersion: 1,
    provenance: "test",
    contact: {},
    experience: [],
    education: [],
    skills: [],
    ...partial,
  };
}

describe("restatements of the same fact do not count against the parser", () => {
  it("compares phones by digits, so presentation differences pass", () => {
    const scores = scoreAgainstTruth(
      truth({ contact: { phone: "973-555-0123" } }),
      { ...EMPTY_PARSE, phone: "(973) 555-0123" },
    );
    expect(isExact(scores.phone!)).toBe(true);
  });

  it("treats 'Current' and 'Present' as one fact in a date range", () => {
    const scores = scoreAgainstTruth(
      truth({ experience: [{ dates: "January 20XX - Current" }] }),
      { ...EMPTY_PARSE, experience: [{ start_date: "January 20XX", is_current: true }] },
    );
    expect(isExact(scores["experience.dates"]!)).toBe(true);
  });

  it("folds the degree connective, which the parser cannot know about", () => {
    // The page writes "B.S. in Computer Science"; the parser stores
    // degree "B.S." + field "Computer Science" and has no record of the "in".
    const scores = scoreAgainstTruth(
      truth({ education: [{ degree: "B.S. in Computer Science" }] }),
      { ...EMPTY_PARSE, education: [{ degree: "B.S.", field: "Computer Science" }] },
    );
    expect(isExact(scores["education.degree"]!)).toBe(true);
  });

  it("folds dash variants and trailing punctuation", () => {
    const scores = scoreAgainstTruth(
      truth({ experience: [{ company: "Globex Systems LLC." }] }),
      { ...EMPTY_PARSE, experience: [{ company: "Globex Systems LLC" }] },
    );
    expect(isExact(scores["experience.company"]!)).toBe(true);
  });
});

describe("real wrongness counts", () => {
  it("catches a dropped token in a list field", () => {
    const scores = scoreAgainstTruth(
      truth({ skills: ["C", "C++", "Java"] }),
      { ...EMPTY_PARSE, skills: ["C++", "Java"] },
    );
    expect(scores.skills).toEqual({ expected: 3, predicted: 2, matched: 2 });
    expect(isExact(scores.skills!)).toBe(false);
  });

  it("catches a value the parser glued extra text onto", () => {
    const scores = scoreAgainstTruth(
      truth({ education: [{ institution: "Ohio Valley State University" }] }),
      {
        ...EMPTY_PARSE,
        education: [{ institution: "Ohio Valley State University — Columbus, Ohio" }],
      },
    );
    expect(scores["education.institution"]).toEqual({
      expected: 1,
      predicted: 1,
      matched: 0,
    });
  });

  it("catches a whole section dropped — expected > 0, predicted 0", () => {
    const scores = scoreAgainstTruth(
      truth({ experience: [{ title: "Staff Engineer" }, { title: "Senior Engineer" }] }),
      EMPTY_PARSE,
    );
    expect(recall(scores["experience.title"]!)).toBe(0);
    expect(precision(scores["experience.title"]!)).toBeUndefined();
  });

  it("catches a fabricated value — the page has none, the parser returns one", () => {
    const scores = scoreAgainstTruth(truth({ skills: [] }), {
      ...EMPTY_PARSE,
      skills: ["Kubernetes"],
    });
    expect(precision(scores.skills!)).toBe(0);
    expect(isExact(scores.skills!)).toBe(false);
  });

  it("does not double-count a duplicated value", () => {
    // Three identical true titles, two returned: matched must be 2, not 3.
    const scores = scoreAgainstTruth(
      truth({
        experience: [
          { title: "Office manager" },
          { title: "Office manager" },
          { title: "Office manager" },
        ],
      }),
      {
        ...EMPTY_PARSE,
        experience: [{ title: "Office manager" }, { title: "Office manager" }],
      },
    );
    expect(scores["experience.title"]).toEqual({
      expected: 3,
      predicted: 2,
      matched: 2,
    });
  });
});

describe("un-annotated fields", () => {
  it("are skipped rather than scored as 'the page has none'", () => {
    // The distinction the `unannotated` list exists for: scoring an unread field
    // as empty would report a fabrication the annotator never checked.
    const scores = scoreAgainstTruth(
      truth({ skills: [], unannotated: ["skills"] }),
      { ...EMPTY_PARSE, skills: ["Kubernetes", "Terraform"] },
    );
    expect(scores.skills).toBeNull();
  });
});

describe("ratios", () => {
  it("report an empty side as unmeasured, never as a perfect 1.0", () => {
    const s = { expected: 0, predicted: 0, matched: 0 };
    expect(precision(s)).toBeUndefined();
    expect(recall(s)).toBeUndefined();
    // …while a field neither side carries is still EXACT, so it never fails.
    expect(isExact(s)).toBe(true);
  });
});

/**
 * `readTruth` validates a HAND-AUTHORED file, so the failure it must produce is
 * a `[truth] <path>: …` message naming the problem — not a crash three frames
 * later inside the scorer, which is what a missing required member used to give.
 */
describe("readTruth validates required members", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "offlinecv-truth-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a truth sidecar next to a (never-created) fixture and read it back. */
  function readWith(body: Record<string, unknown>): FixtureTruth | null {
    const pdf = join(dir, "fixture.pdf");
    writeFileSync(join(dir, "fixture.truth.json"), JSON.stringify(body));
    return readTruth(pdf);
  }

  const VALID = {
    schemaVersion: 1,
    provenance: "read off the page by hand",
    contact: {},
    experience: [],
    education: [],
    skills: [],
  };

  it("accepts a well-formed file", () => {
    expect(readWith(VALID)).not.toBeNull();
  });

  it("returns null — not an error — when the fixture carries no sidecar", () => {
    // An un-annotated fixture is a known gap the scoreboard reports, not a fault.
    expect(readTruth(join(dir, "absent.pdf"))).toBeNull();
  });

  for (const member of ["experience", "education", "skills"] as const) {
    it(`rejects a file omitting \`${member}\` with a [truth] message`, () => {
      const body: Record<string, unknown> = { ...VALID };
      delete body[member];
      // Before this guard: passed validation, then died in `scoreAgainstTruth`
      // with "Cannot read properties of undefined (reading 'filter')".
      expect(() => readWith(body)).toThrow(/^\[truth\]/);
      expect(() => readWith(body)).toThrow(new RegExp(`\`${member}\``));
    });

    it(`rejects \`${member}\` present but not an array`, () => {
      // An object where an array belongs fails the scorer identically.
      expect(() => readWith({ ...VALID, [member]: {} })).toThrow(/^\[truth\]/);
    });
  }

  it("rejects a file omitting `contact`", () => {
    const body: Record<string, unknown> = { ...VALID };
    delete body.contact;
    expect(() => readWith(body)).toThrow(/^\[truth\].*`contact`/);
  });

  it("still enforces the checks it already had", () => {
    // The decomposition must not have dropped a guard on the way out.
    expect(() => readWith({ ...VALID, provenance: "  " })).toThrow(/provenance/);
    expect(() => readWith({ ...VALID, schemaVersion: 99 })).toThrow(/schemaVersion/);
    expect(() => readWith({ ...VALID, unannotated: ["nope"] })).toThrow(/unknown field/);
    expect(() =>
      readWith({
        ...VALID,
        unannotated: ["skills"],
        knownWrong: { skills: { issue: 1, status: "open", note: "n" } },
      }),
    ).toThrow(/both unannotated and knownWrong/);
    expect(() =>
      readWith({ ...VALID, knownWrong: { skills: { issue: 1, status: "open", note: "" } } }),
    ).toThrow(/`note` is required/);
    expect(() =>
      readWith({ ...VALID, knownWrong: { skills: { issue: 7, status: "unfiled", note: "n" } } }),
    ).toThrow(/must carry `issue: null`/);
  });
});
