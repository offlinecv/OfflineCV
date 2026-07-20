// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `matchCorpus()` unit tests — hand-built artifacts only, NO PDF I/O.
 *
 * The load-bearing one is `"distinguishes two fixtures with deep-equal
 * ReproArtifacts by a DerivedSignals boolean alone"` (issue #469's stated
 * acceptance criterion): it proves the engine cannot be shortcut into
 * "same artifact ⇒ same defect", which is the exact failure that would make a
 * value-level (round-trip) defect look covered by a fixture that parses fine.
 */

import { describe, expect, it } from "vitest";

import {
  DEFECT_CLASSES,
  EMPTY_DERIVED_SIGNALS,
  type DefectClass,
  type DerivedSignals,
} from "./defect-classes.ts";
import { CASCADE_VERSION } from "./types.ts";
import { REPRO_ARTIFACT_VERSION, type ReproArtifact } from "./repro-artifact.ts";
import {
  NEAR_MISS_LIMIT,
  divergedAxes,
  matchCorpus,
  type CorpusEntry,
} from "./fixture-match.ts";

// ── Builders ─────────────────────────────────────────────────────────────────

function artifact(over: Partial<ReproArtifact> = {}): ReproArtifact {
  return {
    artifactVersion: REPRO_ARTIFACT_VERSION,
    cascadeVersion: CASCADE_VERSION,
    triggers: [],
    sectionSource: "regex",
    pageCount: 1,
    rawCharCount: 2000,
    extractedCharCount: 1800,
    sections: [],
    parsedCounts: {
      hasFullName: true,
      hasEmail: true,
      hasPhone: true,
      hasLocation: true,
      hasSummary: true,
      experienceCount: 3,
      educationCount: 1,
      skillsCount: 8,
    },
    linkAnnotationCount: 0,
    disagreements: [],
    ...over,
  };
}

function derived(over: Partial<DerivedSignals> = {}): DerivedSignals {
  return { ...EMPTY_DERIVED_SIGNALS, ...over };
}

function entry(
  path: string,
  a: ReproArtifact,
  d: DerivedSignals = derived(),
): CorpusEntry {
  return { path, artifact: a, derived: d };
}

// A parse that exhibits NO defect class at all — the "healthy" baseline. Every
// section is routed and every count is non-zero, so no `exhibits()` fires.
const HEALTHY = artifact({
  sections: [
    { name: "skills", lineCount: 4 },
    { name: "experience", lineCount: 20 },
    { name: "education", lineCount: 5 },
    { name: "achievements", lineCount: 3 },
  ],
});

// ── The acceptance test ──────────────────────────────────────────────────────

describe("matchCorpus — value-level defects (the DerivedSignals escape hatch)", () => {
  it("distinguishes two fixtures with deep-equal ReproArtifacts by a DerivedSignals boolean alone", () => {
    // Both fixtures parse to the SAME structure. A round-trip corruption is
    // invisible to ReproArtifact by construction: hasEmail is `true` on both
    // sides of a hop that mangled the address.
    const shared = artifact({ sections: [{ name: "skills", lineCount: 4 }] });
    const corrupting = entry(
      "tests/fixtures/pdfs/word/a.pdf",
      shared,
      derived({ emailChangedAcrossRoundtrip: true }),
    );
    const clean = entry("tests/fixtures/pdfs/word/b.pdf", shared, derived());

    // Pin the premise: the two artifacts really are indistinguishable.
    expect(corrupting.artifact).toEqual(clean.artifact);

    const [cov] = matchCorpus(
      shared,
      derived({ emailChangedAcrossRoundtrip: true }),
      ["roundtrip-contact-value-changed"],
      [corrupting, clean],
    );

    expect(cov.class).toBe("roundtrip-contact-value-changed");
    expect(cov.coveredBy).toEqual(["tests/fixtures/pdfs/word/a.pdf"]);
    expect(cov.nearMisses).toEqual([]);
    expect(cov.nearMissCandidateCount).toBe(0);
  });

  it("separates the structurally-identical skills header pair by the derived bit", () => {
    // skills-header-unrecognized and skills-no-section are BYTE-IDENTICAL in the
    // artifact (0 skills, no routed region). Only the derived bit tells them apart.
    const a = artifact({ parsedCounts: { ...HEALTHY.parsedCounts, skillsCount: 0 } });
    const rejected = entry("f/rejected.pdf", a, derived({ skillsHeaderCandidateRejected: true }));
    const genuinelyNone = entry("f/none.pdf", a, derived());

    const corpus = [rejected, genuinelyNone];
    const real = derived({ skillsHeaderCandidateRejected: true });

    const [header, none] = matchCorpus(
      a,
      real,
      ["skills-no-section", "skills-header-unrecognized"],
      corpus,
    );

    // Output order follows DEFECT_CLASSES, not the caller's argument order.
    expect(header.class).toBe("skills-header-unrecognized");
    expect(header.coveredBy).toEqual(["f/rejected.pdf"]);
    expect(none.class).toBe("skills-no-section");
    expect(none.coveredBy).toEqual(["f/none.pdf"]);
  });
});

// ── Coverage semantics ───────────────────────────────────────────────────────

describe("matchCorpus — coverage", () => {
  it("does NOT let a non-load-bearing axis diverge a fixture out of a cover", () => {
    // The fixture exhibits skills-extraction-miss (0 skills parsed from a routed
    // region) but differs from the résumé on every axis that is NOT load-bearing
    // for that class: pages, char counts, triggers, splitter, links, other
    // sections, every other parsed count. It is still a valid reproducer.
    const real = artifact({
      sections: [{ name: "skills", lineCount: 4 }],
      parsedCounts: { ...HEALTHY.parsedCounts, skillsCount: 0 },
    });
    const wildlyDifferent = artifact({
      triggers: ["two_column"],
      sectionSource: "markdown",
      pageCount: 3,
      rawCharCount: 99_999,
      extractedCharCount: 12,
      linkAnnotationCount: 7,
      disagreements: [{ kind: "missing_field", field: "email" }],
      sections: [
        { name: "skills", lineCount: 40 }, // load-bearing, but only as ">0"
        { name: "experience", lineCount: 1 },
      ],
      parsedCounts: {
        hasFullName: false,
        hasEmail: false,
        hasPhone: false,
        hasLocation: false,
        hasSummary: false,
        experienceCount: 0,
        educationCount: 0,
        skillsCount: 0, // load-bearing
      },
    });

    const [cov] = matchCorpus(
      real,
      derived(),
      ["skills-extraction-miss"],
      [entry("f/wild.pdf", wildlyDifferent)],
    );

    expect(cov.coveredBy).toEqual(["f/wild.pdf"]);
    expect(cov.nearMisses).toEqual([]);
  });

  it("reports every covering fixture, in corpus order, de-duplicated", () => {
    const miss = artifact({
      sections: [{ name: "skills", lineCount: 4 }],
      parsedCounts: { ...HEALTHY.parsedCounts, skillsCount: 0 },
    });

    const [cov] = matchCorpus(
      miss,
      derived(),
      ["skills-extraction-miss"],
      [
        entry("f/z.pdf", miss),
        entry("f/healthy.pdf", HEALTHY),
        entry("f/a.pdf", miss),
        entry("f/z.pdf", miss), // duplicate path
      ],
    );

    expect(cov.coveredBy).toEqual(["f/z.pdf", "f/a.pdf"]);
  });

  it("returns one entry per DISTINCT class, in DEFECT_CLASSES order", () => {
    const all = [...DEFECT_CLASSES];
    const asked: DefectClass[] = [...all].reverse().concat(all);

    const out = matchCorpus(HEALTHY, derived(), asked, []);

    expect(out.map((c) => c.class)).toEqual(all);
  });
});

// ── Near misses ──────────────────────────────────────────────────────────────

describe("matchCorpus — near misses", () => {
  // Résumé: skills header rejected by the strict router.
  const real = artifact({ parsedCounts: { ...HEALTHY.parsedCounts, skillsCount: 0 } });
  const realDerived = derived({ skillsHeaderCandidateRejected: true });
  const CLS: DefectClass = "skills-header-unrecognized";
  // loadBearingAxes: parsedCounts.skillsCount, sections.skills,
  //                  derived.skillsHeaderCandidateRejected

  it("populates near misses, ranked closest-first, when nothing covers", () => {
    // 1 axis diverges: same 0-count + no region, but its header was recognized.
    const oneAxis = entry("f/one.pdf", real, derived());
    // 3 axes diverge: parses skills fine, from a routed region, header accepted.
    const threeAxes = entry("f/three.pdf", HEALTHY, derived());

    const [cov] = matchCorpus(real, realDerived, [CLS], [threeAxes, oneAxis]);

    expect(cov.coveredBy).toEqual([]);
    expect(cov.nearMisses).toEqual([
      { fixture: "f/one.pdf", divergedAxes: ["derived.skillsHeaderCandidateRejected"] },
      {
        fixture: "f/three.pdf",
        divergedAxes: [
          "parsedCounts.skillsCount",
          "sections.skills",
          "derived.skillsHeaderCandidateRejected",
        ],
      },
    ]);
    expect(cov.nearMissCandidateCount).toBe(2);
  });

  it("caps the list but never truncates silently — nearMissCandidateCount stays whole", () => {
    const corpus = ["e", "d", "c", "b", "a"].map((n) => entry(`f/${n}.pdf`, HEALTHY));

    const [cov] = matchCorpus(real, realDerived, [CLS], corpus);

    expect(cov.nearMisses).toHaveLength(NEAR_MISS_LIMIT);
    expect(cov.nearMissCandidateCount).toBe(5);
    // All five diverge equally (3 axes), so the tie-break is path-ascending —
    // NOT corpus arrival order, which is the reverse.
    expect(cov.nearMisses.map((m) => m.fixture)).toEqual([
      "f/a.pdf",
      "f/b.pdf",
      "f/c.pdf",
    ]);
  });

  it("emits an empty divergedAxes when a fixture matches every load-bearing axis yet does not exhibit the class", () => {
    // Only reachable when the RÉSUMÉ does not exhibit the class either (the
    // caller asked about a class it never found) — a real, reportable signal.
    const [cov] = matchCorpus(HEALTHY, derived(), [CLS], [entry("f/twin.pdf", HEALTHY)]);

    expect(cov.coveredBy).toEqual([]);
    expect(cov.nearMisses).toEqual([{ fixture: "f/twin.pdf", divergedAxes: [] }]);
  });

  it("is empty when the corpus is empty", () => {
    const [cov] = matchCorpus(real, realDerived, [CLS], []);

    expect(cov).toEqual({
      class: CLS,
      coveredBy: [],
      nearMisses: [],
      nearMissCandidateCount: 0,
    });
  });
});

// ── Degenerate inputs ────────────────────────────────────────────────────────

describe("matchCorpus — degenerate inputs", () => {
  it("returns [] for an empty defect list, however large the corpus", () => {
    expect(matchCorpus(HEALTHY, derived(), [], [entry("f/a.pdf", HEALTHY)])).toEqual([]);
  });

  it("returns [] for an empty defect list AND an empty corpus", () => {
    expect(matchCorpus(HEALTHY, derived(), [], [])).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const a = artifact({ triggers: ["two_column", "scanned"] });
    const snapshot = structuredClone(a);
    const corpus = [entry("f/a.pdf", a)];

    matchCorpus(a, derived(), [...DEFECT_CLASSES], corpus);

    expect(a).toEqual(snapshot);
    expect(corpus.map((c) => c.path)).toEqual(["f/a.pdf"]);
  });
});

// ── Axis comparison ──────────────────────────────────────────────────────────

describe("divergedAxes", () => {
  const d = derived();

  it("compares array axes as order-insensitive multisets", () => {
    const x = artifact({ triggers: ["two_column", "scanned"] });
    const y = artifact({ triggers: ["scanned", "two_column"] });

    expect(divergedAxes(x, d, y, d, ["triggers"])).toEqual([]);
  });

  it("still sees a genuine array-axis difference (cardinality is preserved)", () => {
    const one = artifact({ triggers: ["scanned"] });
    const twice = artifact({ triggers: ["scanned", "scanned"] });
    const other = artifact({ triggers: ["two_column"] });

    expect(divergedAxes(one, d, twice, d, ["triggers"])).toEqual(["triggers"]);
    expect(divergedAxes(one, d, other, d, ["triggers"])).toEqual(["triggers"]);
  });

  it("compares disagreements order-insensitively, on kind/field/cause", () => {
    const x = artifact({
      disagreements: [
        { kind: "missing_field", field: "email" },
        { kind: "merged_roles", field: "experience", likelyCause: "two_column" },
      ],
    });
    const reordered = artifact({ disagreements: [...x.disagreements].reverse() });
    const causeDiffers = artifact({
      disagreements: [
        { kind: "missing_field", field: "email" },
        { kind: "merged_roles", field: "experience", likelyCause: "scanned" },
      ],
    });

    expect(divergedAxes(x, d, reordered, d, ["disagreements"])).toEqual([]);
    expect(divergedAxes(x, d, causeDiffers, d, ["disagreements"])).toEqual([
      "disagreements",
    ]);
  });

  it("treats an unrouted section and a zero-line section as the same value", () => {
    const absent = artifact({ sections: [] });
    const empty = artifact({ sections: [{ name: "skills", lineCount: 0 }] });
    const routed = artifact({ sections: [{ name: "skills", lineCount: 1 }] });

    expect(divergedAxes(absent, d, empty, d, ["sections.skills"])).toEqual([]);
    expect(divergedAxes(absent, d, routed, d, ["sections.skills"])).toEqual([
      "sections.skills",
    ]);
  });

  it("reads scalar, parsedCounts, and derived axes", () => {
    const x = artifact({ pageCount: 1, sectionSource: "regex" });
    const y = artifact({ pageCount: 2, sectionSource: "markdown" });

    expect(
      divergedAxes(x, derived({ renderThrewOnRoundtrip: true }), y, d, [
        "pageCount",
        "sectionSource",
        "rawCharCount",
        "parsedCounts.hasEmail",
        "parsedCounts.experienceCount",
        "derived.renderThrewOnRoundtrip",
        "derived.emailChangedAcrossRoundtrip",
      ]),
    ).toEqual(["pageCount", "sectionSource", "derived.renderThrewOnRoundtrip"]);
  });

  it("returns the diverged axes in the order they were declared", () => {
    const x = artifact({ pageCount: 1, linkAnnotationCount: 0 });
    const y = artifact({ pageCount: 2, linkAnnotationCount: 5 });

    expect(divergedAxes(x, d, y, d, ["linkAnnotationCount", "pageCount"])).toEqual([
      "linkAnnotationCount",
      "pageCount",
    ]);
  });
});
