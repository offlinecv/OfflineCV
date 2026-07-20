// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for the defect-class table (issue #469).
 *
 * Three load-bearing jobs, in order of importance:
 *
 *  1. **The PII contract.** `DerivedSignals` must admit no `string`, ever — it
 *     is the escape hatch for value-level defects, so it sits closest to a real
 *     résumé's real values, and (per #469 step 5) it gets BAKED into the
 *     committed `*.expected.json` corpus snapshots. This mirrors the assertion
 *     `repro-artifact.test.ts` makes for `ReproArtifact`: plant a sentinel where
 *     a leak would land, serialize exactly as the persisting path does, and
 *     assert not one survives. `ReproArtifact`'s leak surface is its BUILDER, so
 *     that test salts the builder's inputs; `DerivedSignals`' leak surface is
 *     its TYPE (a boolean-only mapped type — its builder lands in #469 step 6),
 *     so the sentinel is planted through a deliberate cast and the shape guard
 *     has to catch it. Both tests fail the moment someone widens the shape with
 *     a free-form `string` — that is the whole point.
 *
 *  2. **No silent gap.** Every `DefectClass` has exactly one table entry.
 *
 *  3. **Every `exhibits()` predicate**, unit-tested against hand-built artifacts
 *     — including the branch-order cases where two sibling classes would
 *     otherwise both fire on one defect. No PDF I/O: the whole point of the
 *     artifact seam is that it is testable without one.
 */

import { describe, it, expect } from "vitest";

import {
  DEFECT_CLASSES,
  DEFECT_SPECS,
  DERIVED_SIGNAL_KEYS,
  EMPTY_DERIVED_SIGNALS,
  ORACLES,
  ORACLE_UNAVAILABLE_KEY,
  PROBE_IDS,
  defectClassesForProbe,
  defectSpec,
  exhibitedDefects,
  isAdvisory,
  isWithheld,
  sectionLineCount,
  unavailableOracles,
  withheldClasses,
  withheldOracles,
  type DefectClass,
  type DerivedSignalKey,
  type DerivedSignals,
  type ProbeId,
} from "./defect-classes.ts";
import { CONTACT_DEFECT_CLASSES, localizeContact } from "./localize/contact.ts";
import { SKILLS_DEFECT_CLASSES, localizeSkills } from "./localize/skills.ts";
import {
  EXPERIENCE_DEFECT_CLASSES,
  localizeExperience,
} from "./localize/experience.ts";
import {
  EDUCATION_DEFECT_CLASSES,
  localizeEducation,
} from "./localize/education.ts";
import {
  ACHIEVEMENTS_DEFECT_CLASSES,
  localizeAchievements,
} from "./localize/achievements.ts";
import {
  ROUNDTRIP_CATEGORY_CLASS,
  localizeRoundtripHop,
} from "./localize/roundtrip.ts";
import { mkCascade } from "./localize/__test-utils__.ts";
import {
  REPRO_ARTIFACT_VERSION,
  type ReproArtifact,
  type ReproParsedCounts,
} from "./repro-artifact.ts";
import type { SectionName } from "./sections.config.ts";
import { CASCADE_VERSION } from "./types.ts";

// ── Hand-built fixtures (no PDF I/O) ─────────────────────────────────────────

/** A CLEAN parse: every section routed, every field parsed. Tests override only
 *  the axes their defect lives on, so a predicate that fires on an untouched
 *  axis shows up immediately as an unexpected extra class. */
const CLEAN_SECTIONS: Partial<Record<SectionName | "profile", number>> = {
  profile: 4,
  summary: 3,
  experience: 20,
  education: 4,
  skills: 3,
  achievements: 3,
};

const CLEAN_COUNTS: ReproParsedCounts = {
  hasFullName: true,
  hasEmail: true,
  hasPhone: true,
  hasLocation: true,
  hasSummary: true,
  experienceCount: 3,
  educationCount: 1,
  skillsCount: 12,
};

/** A clean `ReproArtifact`, with the named section line-counts and parsed counts
 *  overridden. A section overridden to `0` is treated as never routed — which is
 *  how the probes read an empty region, and what `sectionLineCount` reports. */
function artifact(over?: {
  sections?: Partial<Record<SectionName | "profile", number>>;
  counts?: Partial<ReproParsedCounts>;
}): ReproArtifact {
  const merged = { ...CLEAN_SECTIONS, ...over?.sections };
  return {
    artifactVersion: REPRO_ARTIFACT_VERSION,
    cascadeVersion: CASCADE_VERSION,
    triggers: [],
    sectionSource: "markdown",
    pageCount: 1,
    rawCharCount: 2000,
    extractedCharCount: 2000,
    sections: (Object.entries(merged) as [SectionName | "profile", number][])
      .filter(([, lineCount]) => lineCount > 0)
      .map(([name, lineCount]) => ({ name, lineCount })),
    parsedCounts: { ...CLEAN_COUNTS, ...over?.counts },
    linkAnnotationCount: 0,
    disagreements: [],
  };
}

/** `DerivedSignals` with the named bits flipped on, everything else false. */
function derived(...on: readonly DerivedSignalKey[]): DerivedSignals {
  const d = { ...EMPTY_DERIVED_SIGNALS };
  for (const k of on) d[k] = true;
  return d;
}

/** No derived signal observed — i.e. a clean parse on every value-level axis. */
const NONE = EMPTY_DERIVED_SIGNALS;

/** Does this parse exhibit exactly `expected`, and nothing else? Stronger than
 *  asserting one predicate: it also pins that sibling classes stay mutually
 *  exclusive (a 0-entry experience region must NOT report as both a parser-miss
 *  and under-segmented) and that no unrelated class leaks in. */
function expectExactly(
  a: ReproArtifact,
  d: DerivedSignals,
  expected: DefectClass[],
): void {
  expect(exhibitedDefects(a, d)).toEqual(expected);
}

// ── 1. The PII contract ──────────────────────────────────────────────────────

describe("DerivedSignals — boolean-only by construction", () => {
  // Compile-time half; `npm run typecheck` is the gate. Widen `DerivedSignals`
  // to admit a `string` (or anything else) and `NonBoolean` stops being `never`,
  // so this assignment stops compiling.
  type NonBoolean = Exclude<DerivedSignals[DerivedSignalKey], boolean>;
  const noNonBooleanMember: [NonBoolean] extends [never] ? true : false = true;

  /** The runtime shape guard: a serialized `DerivedSignals` may hold nothing but
   *  bare `true`/`false` literals — no string can occupy a value slot. */
  const serializesToBooleansOnly = (v: unknown): boolean =>
    /^\{"[A-Za-z]+":(?:true|false)(?:,"[A-Za-z]+":(?:true|false))*\}$/.test(
      JSON.stringify(v),
    );

  it("compiles only while every member is a boolean", () => {
    expect(noNonBooleanMember).toBe(true);
  });

  it("carries no literal field value, anywhere, when serialized", () => {
    // Every signal on — the maximal payload the corpus bake will ever persist.
    const all = derived(...DERIVED_SIGNAL_KEYS);
    expect(Object.values(all).every((v) => typeof v === "boolean")).toBe(true);
    expect(serializesToBooleansOnly(all)).toBe(true);
    expect(serializesToBooleansOnly(EMPTY_DERIVED_SIGNALS)).toBe(true);
  });

  it("the guard has teeth — a smuggled string value fails it", () => {
    // The leak this design exists to prevent: someone adds a "just the failing
    // value, for context" slot. Only reachable through a cast today — which is
    // exactly why the TYPE is the primary defence and this is the backstop.
    const smuggled = {
      ...EMPTY_DERIVED_SIGNALS,
      emailChangedAcrossRoundtrip: "SENTINEL_EMAIL_aria@leak.invalid",
    } as unknown as DerivedSignals;
    expect(JSON.stringify(smuggled)).toContain("SENTINEL_EMAIL_aria@leak.invalid");
    expect(serializesToBooleansOnly(smuggled)).toBe(false);
  });

  it("has no duplicate keys, and EMPTY_DERIVED_SIGNALS covers every one", () => {
    expect(new Set(DERIVED_SIGNAL_KEYS).size).toBe(DERIVED_SIGNAL_KEYS.length);
    expect(Object.keys(EMPTY_DERIVED_SIGNALS).sort()).toEqual(
      [...DERIVED_SIGNAL_KEYS].sort(),
    );
    expect(Object.values(EMPTY_DERIVED_SIGNALS).every((v) => v === false)).toBe(true);
  });
});

// ── 2. No silent gap ─────────────────────────────────────────────────────────

describe("DEFECT_SPECS — one entry per class, no gaps", () => {
  it("has no duplicate classes", () => {
    expect(new Set(DEFECT_CLASSES).size).toBe(DEFECT_CLASSES.length);
  });

  it("has exactly one table entry per DefectClass", () => {
    expect(Object.keys(DEFECT_SPECS).sort()).toEqual([...DEFECT_CLASSES].sort());
    for (const c of DEFECT_CLASSES) {
      expect(DEFECT_SPECS[c]).toBeDefined();
      // The key and the spec's self-declared class must agree — a copy-paste slip
      // here would silently mis-attribute a defect to another class.
      expect(DEFECT_SPECS[c].class).toBe(c);
      expect(defectSpec(c)).toBe(DEFECT_SPECS[c]);
    }
  });

  it("names a known probe and at least one load-bearing axis for every class", () => {
    for (const c of DEFECT_CLASSES) {
      const spec = DEFECT_SPECS[c];
      expect(PROBE_IDS).toContain(spec.probe);
      expect(spec.loadBearingAxes.length).toBeGreaterThan(0);
      expect(new Set(spec.loadBearingAxes).size).toBe(spec.loadBearingAxes.length);
    }
  });

  it("covers all six probes", () => {
    const covered = new Set(DEFECT_CLASSES.map((c) => DEFECT_SPECS[c].probe));
    expect([...covered].sort()).toEqual([...PROBE_IDS].sort());
  });

  it("reports nothing on a clean parse", () => {
    expectExactly(artifact(), NONE, []);
  });

  // ── The verdict↔class pin (#469's "a probe verdict with no table entry is a
  // test failure, not a silent gap"). The `Record<DefectClass, DefectSpec>` above
  // pins CLASS ↔ TABLE. This pins TABLE ↔ LOCALIZER: each localizer declares the
  // exact tuple of classes its verdict chain can emit, and its `defect` variable
  // is TYPED to that tuple — so a verdict branch cannot exist without naming a
  // class (or an explicit `null`). If a class is added to the table for a probe
  // and no localizer branch emits it, this fails. If a localizer names a class
  // the table's `probe` column disagrees about, this fails too.
  it("every table class is claimed by its localizer's declared class tuple", () => {
    const declared: Record<ProbeId, readonly DefectClass[]> = {
      "probe-contact": CONTACT_DEFECT_CLASSES,
      "probe-skills": SKILLS_DEFECT_CLASSES,
      "probe-experience": EXPERIENCE_DEFECT_CLASSES,
      "probe-education": EDUCATION_DEFECT_CLASSES,
      "probe-achievements": ACHIEVEMENTS_DEFECT_CLASSES,
      // probe-roundtrip has no verdict string: a CATEGORY with a non-empty diff
      // IS its verdict, so its pin is the total category→class map.
      "probe-roundtrip": Object.values(ROUNDTRIP_CATEGORY_CLASS),
    };
    for (const probe of PROBE_IDS) {
      expect([...declared[probe]].sort()).toEqual(
        defectClassesForProbe(probe).sort(),
      );
    }
  });

  it("marks exactly the three *-no-section classes advisory", () => {
    expect(DEFECT_CLASSES.filter(isAdvisory)).toEqual([
      "skills-no-section",
      "education-no-section",
      "achievements-no-section",
    ]);
  });
});

// ── sectionLineCount ─────────────────────────────────────────────────────────

describe("sectionLineCount", () => {
  it("returns the routed line count, and 0 when no region was cut", () => {
    const a = artifact({ sections: { skills: 4, education: 0 } });
    expect(sectionLineCount(a, "skills")).toBe(4);
    expect(sectionLineCount(a, "education")).toBe(0);
  });

  it("treats a routed-but-empty region as absent (as every probe does)", () => {
    const a: ReproArtifact = {
      ...artifact(),
      sections: [{ name: "skills", lineCount: 0 }],
    };
    expect(sectionLineCount(a, "skills")).toBe(0);
  });
});

// ── 3. The exhibits() predicates ─────────────────────────────────────────────

describe("exhibits — probe-contact", () => {
  it("flags a parser-miss only when the field is empty AND rawText has it", () => {
    expectExactly(
      artifact({ counts: { hasEmail: false } }),
      derived("emailInRawTextButNotParsed"),
      ["contact-email-parser-miss"],
    );
    expectExactly(
      artifact({ counts: { hasPhone: false } }),
      derived("phoneInRawTextButNotParsed"),
      ["contact-phone-parser-miss"],
    );
    expectExactly(
      artifact({ counts: { hasLocation: false } }),
      derived("locationInRawTextButNotParsed"),
      ["contact-location-parser-miss"],
    );
  });

  it("does NOT flag a field that is simply absent from the PDF", () => {
    // Field empty AND no rawText candidate → the probe says "absent-in-pdf",
    // which is not a defect.
    expectExactly(artifact({ counts: { hasEmail: false } }), NONE, []);
  });

  it("does NOT flag a field that parsed fine", () => {
    expectExactly(artifact(), derived("emailInRawTextButNotParsed"), []);
  });

  it("keeps the three contact fields independent (no cross-field false cover)", () => {
    // A fixture that drops the PHONE must never be reported as covering a résumé
    // that drops the EMAIL.
    expect(
      DEFECT_SPECS["contact-email-parser-miss"].exhibits(
        artifact({ counts: { hasEmail: false } }),
        derived("phoneInRawTextButNotParsed"),
      ),
    ).toBe(false);
  });
});

describe("exhibits — probe-skills", () => {
  it("EXTRACTION-MISS: region routed, 0 skills parsed", () => {
    expectExactly(artifact({ counts: { skillsCount: 0 } }), NONE, [
      "skills-extraction-miss",
    ]);
  });

  it("HEADER-UNRECOGNIZED: no region, 0 skills, a rejected skills-like header", () => {
    expectExactly(
      artifact({ sections: { skills: 0 }, counts: { skillsCount: 0 } }),
      derived("skillsHeaderCandidateRejected"),
      ["skills-header-unrecognized"],
    );
  });

  it("NO-SKILLS-SECTION: no region, 0 skills, no rejected header", () => {
    expectExactly(artifact({ sections: { skills: 0 }, counts: { skillsCount: 0 } }), NONE, [
      "skills-no-section",
    ]);
  });

  it("separates the two structurally-identical no-region classes", () => {
    // Same artifact; ONLY the derived bit differs. This is exactly the
    // discrimination the DerivedSignals escape hatch exists for — the artifact
    // cannot tell a rejected header from a résumé that has no skills section.
    const a = artifact({ sections: { skills: 0 }, counts: { skillsCount: 0 } });
    const unrecognized = DEFECT_SPECS["skills-header-unrecognized"];
    const noSection = DEFECT_SPECS["skills-no-section"];
    const d = derived("skillsHeaderCandidateRejected");
    expect(unrecognized.exhibits(a, d)).toBe(true);
    expect(noSection.exhibits(a, d)).toBe(false);
    expect(unrecognized.exhibits(a, NONE)).toBe(false);
    expect(noSection.exhibits(a, NONE)).toBe(true);
  });

  it("flags nothing once skills parsed, even with a rejected header candidate", () => {
    expectExactly(artifact(), derived("skillsHeaderCandidateRejected"), []);
  });

  // The FALSE-COVER hazard this guard exists to kill: on a scanned/sparse parse
  // there is no markdown, so `skillsHeaderCandidateRejected` is false because the
  // oracle could not RUN — not because no header was rejected. Firing
  // `skills-no-section` there would let 9 fixtures "cover" a header-rejection
  // defect none of them reproduces.
  it("withholds BOTH no-region classes when the header oracle could not run", () => {
    const a = artifact({ sections: { skills: 0 }, counts: { skillsCount: 0 } });
    expectExactly(a, derived("headerOracleUnavailable"), []);
    expect(
      DEFECT_SPECS["skills-no-section"].exhibits(
        a,
        derived("headerOracleUnavailable"),
      ),
    ).toBe(false);
    expect(
      DEFECT_SPECS["skills-header-unrecognized"].exhibits(
        a,
        derived("headerOracleUnavailable"),
      ),
    ).toBe(false);
  });
});

describe("exhibits — probe-experience", () => {
  it("PARSER-MISS: 0 entries and the region holds date-range lines", () => {
    expectExactly(
      artifact({ counts: { experienceCount: 0 } }),
      derived("experienceRegionHasDateRangeLines"),
      ["experience-parser-miss"],
    );
  });

  it("does NOT flag a 0-entry region with no date-range lines (the probe says ok)", () => {
    expectExactly(artifact({ counts: { experienceCount: 0 } }), NONE, []);
  });

  it("UNDER-SEGMENTED: entries parsed, but fewer than the date-range lines", () => {
    expectExactly(artifact(), derived("experienceEntriesFewerThanDateRangeLines"), [
      "experience-under-segmented",
    ]);
  });

  it("branch order holds: 0 entries + date-ranges is a MISS, never under-segmented", () => {
    // With 0 entries and N > 0 date-range lines the probe's oracle also reads
    // `entries < dateRangeLines`; its `else if` gives PARSER-MISS. Ours must too,
    // or one defect would report as two.
    expectExactly(
      artifact({ counts: { experienceCount: 0 } }),
      derived(
        "experienceRegionHasDateRangeLines",
        "experienceEntriesFewerThanDateRangeLines",
      ),
      ["experience-parser-miss"],
    );
  });
});

describe("exhibits — probe-education", () => {
  it("EXTRACTION-MISS: region routed, 0 entries", () => {
    expectExactly(artifact({ counts: { educationCount: 0 } }), NONE, [
      "education-extraction-miss",
    ]);
  });

  it("HEADER-UNRECOGNIZED: no region, 0 entries, a rejected education-like header", () => {
    expectExactly(
      artifact({ sections: { education: 0 }, counts: { educationCount: 0 } }),
      derived("educationHeaderCandidateRejected"),
      ["education-header-unrecognized"],
    );
  });

  it("NO-EDUCATION-SECTION: no region, 0 entries, no rejected header", () => {
    expectExactly(
      artifact({ sections: { education: 0 }, counts: { educationCount: 0 } }),
      NONE,
      ["education-no-section"],
    );
  });

  it("UNDER-CHUNKED: entries parsed, but fewer than the DEGREE_RE tokens", () => {
    expectExactly(artifact(), derived("educationEntriesFewerThanDegreeTokens"), [
      "education-under-chunked",
    ]);
  });

  it("withholds BOTH no-region classes when the header oracle could not run", () => {
    const a = artifact({
      sections: { education: 0 },
      counts: { educationCount: 0 },
    });
    expectExactly(a, derived("headerOracleUnavailable"), []);
  });

  it("branch order holds: 0 entries never reports as under-chunked", () => {
    expectExactly(
      artifact({ counts: { educationCount: 0 } }),
      derived("educationEntriesFewerThanDegreeTokens"),
      ["education-extraction-miss"],
    );
  });
});

describe("exhibits — probe-achievements", () => {
  it("PARSER-MISS: region non-empty, 0 entries parsed", () => {
    expectExactly(artifact(), derived("achievementsParsedEmpty"), [
      "achievements-parser-miss",
    ]);
  });

  it("no-section: 0 entries and no region segmented", () => {
    expectExactly(
      artifact({ sections: { achievements: 0 } }),
      derived("achievementsParsedEmpty"),
      ["achievements-no-section"],
    );
  });

  it("UNDER-SEGMENTED: entries parsed, but fewer than the header-shaped lines", () => {
    expectExactly(artifact(), derived("achievementsEntriesFewerThanHeaderLines"), [
      "achievements-under-segmented",
    ]);
  });

  it("parser-miss and no-section are mutually exclusive on the region axis", () => {
    const withRegion = artifact();
    const withoutRegion = artifact({ sections: { achievements: 0 } });
    const d = derived("achievementsParsedEmpty");
    expect(DEFECT_SPECS["achievements-parser-miss"].exhibits(withRegion, d)).toBe(true);
    expect(DEFECT_SPECS["achievements-no-section"].exhibits(withRegion, d)).toBe(false);
    expect(DEFECT_SPECS["achievements-parser-miss"].exhibits(withoutRegion, d)).toBe(
      false,
    );
    expect(DEFECT_SPECS["achievements-no-section"].exhibits(withoutRegion, d)).toBe(true);
  });
});

describe("exhibits — probe-roundtrip (value-level)", () => {
  // The acceptance criterion #469 calls out by name: two parses with IDENTICAL
  // ReproArtifacts must still be distinguished, because the corruption lives in
  // the VALUES, which the artifact cannot see. Same clean `a` throughout — only
  // the derived bag differs.
  const a = artifact();

  it("distinguishes a corrupted round-trip from a clean one on identical artifacts", () => {
    expectExactly(a, NONE, []);
    expectExactly(a, derived("emailChangedAcrossRoundtrip"), [
      "roundtrip-contact-value-changed",
    ]);
  });

  it("any of the five contact keys trips the contact class", () => {
    const contact = DEFECT_SPECS["roundtrip-contact-value-changed"];
    for (const k of [
      "fullNameChangedAcrossRoundtrip",
      "emailChangedAcrossRoundtrip",
      "phoneChangedAcrossRoundtrip",
      "locationChangedAcrossRoundtrip",
      "linkedinUrlChangedAcrossRoundtrip",
    ] as const) {
      expect(contact.exhibits(a, derived(k))).toBe(true);
    }
    expect(contact.exhibits(a, NONE)).toBe(false);
    // A non-contact round-trip change must NOT trip it.
    expect(contact.exhibits(a, derived("skillsChangedAcrossRoundtrip"))).toBe(false);
  });

  it("maps each remaining harness category to its own class", () => {
    expectExactly(a, derived("experienceChangedAcrossRoundtrip"), [
      "roundtrip-experience-value-changed",
    ]);
    expectExactly(a, derived("educationChangedAcrossRoundtrip"), [
      "roundtrip-education-value-changed",
    ]);
    expectExactly(a, derived("skillsChangedAcrossRoundtrip"), [
      "roundtrip-skills-value-changed",
    ]);
    expectExactly(a, derived("summaryChangedAcrossRoundtrip"), [
      "roundtrip-summary-value-changed",
    ]);
    expectExactly(a, derived("renderThrewOnRoundtrip"), ["roundtrip-render-crash"]);
  });

  it("reports every class a parse exhibits, in DEFECT_CLASSES order", () => {
    expectExactly(
      a,
      derived(
        "emailChangedAcrossRoundtrip",
        "skillsChangedAcrossRoundtrip",
        "renderThrewOnRoundtrip",
      ),
      [
        "roundtrip-contact-value-changed",
        "roundtrip-skills-value-changed",
        "roundtrip-render-crash",
      ],
    );
  });
});

// ── 4. The oracle gate ───────────────────────────────────────────────────────

describe("the oracle gate — a blind oracle WITHHOLDS, it does not report clean", () => {
  const clean = artifact();

  it("declares each class's required oracles as load-bearing axes", () => {
    for (const c of DEFECT_CLASSES) {
      const s = DEFECT_SPECS[c];
      for (const o of s.requires) {
        expect(ORACLES).toContain(o);
        // `spec()` appends it — so `exhibits()` can never read an axis the
        // near-miss report is blind to.
        expect(s.loadBearingAxes).toContain(`derived.${ORACLE_UNAVAILABLE_KEY[o]}`);
      }
    }
  });

  it("withholds EVERY text-derived class on a parse that produced no text", () => {
    // The scanned/empty-rawText repro: all 20 non-oracle bits read false because
    // there was nothing to read. Nothing may be reported as exhibited — and the
    // withheld list must say so out loud.
    const d = derived("textOracleUnavailable");
    expect(exhibitedDefects(clean, d)).toEqual([]);
    const withheld = withheldClasses(d);
    expect(withheld).toEqual(
      DEFECT_CLASSES.filter((c) => c !== "roundtrip-render-crash"),
    );
    // `roundtrip-render-crash` is an OBSERVED fact about the hop, not a reading
    // of the document — it stays decidable, and stays reachable.
    expect(isWithheld("roundtrip-render-crash", d)).toBe(false);
    expect(exhibitedDefects(clean, derived("textOracleUnavailable", "renderThrewOnRoundtrip"))).toEqual([
      "roundtrip-render-crash",
    ]);
  });

  it("withholds the five roundtrip VALUE classes when the hop produced no `after`", () => {
    // The render-crash repro: `renderThrewOnRoundtrip` is the only thing the hop
    // observed. The nine `*ChangedAcrossRoundtrip` bits are false because the
    // comparison never happened, so "no value changed" is not a finding.
    const d = derived("renderThrewOnRoundtrip", "roundtripOracleUnavailable");
    expect(exhibitedDefects(clean, d)).toEqual(["roundtrip-render-crash"]);
    expect(withheldClasses(d)).toEqual([
      "roundtrip-contact-value-changed",
      "roundtrip-experience-value-changed",
      "roundtrip-education-value-changed",
      "roundtrip-skills-value-changed",
      "roundtrip-summary-value-changed",
    ]);
    // And the gate has teeth: even with a value-change bit somehow set, the
    // class stays withheld rather than claimed off an absent `after`.
    expect(
      DEFECT_SPECS["roundtrip-contact-value-changed"].exhibits(
        clean,
        derived("roundtripOracleUnavailable", "emailChangedAcrossRoundtrip"),
      ),
    ).toBe(false);
  });

  it("withholds nothing, and names no blind oracle, on a parse with all three oracles", () => {
    expect(withheldClasses(NONE)).toEqual([]);
    expect(unavailableOracles(NONE)).toEqual([]);
    expect(unavailableOracles(derived("textOracleUnavailable", "roundtripOracleUnavailable"))).toEqual([
      "text",
      "roundtrip",
    ]);
    expect(withheldOracles("skills-no-section", derived("headerOracleUnavailable"))).toEqual([
      "header",
    ]);
  });
});

// ── 5. Reachability: every table class is EMITTABLE by its localizer ─────────

/**
 * The verdict↔class pin, closed.
 *
 * `defectClassesForProbe` vs the localizers' declared tuples pins TABLE ↔ TUPLE.
 * That alone has only partial teeth: a class in both the table AND the tuple but
 * with NO verdict branch that emits it still passes — a class nobody can emit,
 * silently pinned by nobody. So this drives hand-built `CascadeResult`s through
 * the localizers themselves and asserts the union of what they ACTUALLY emit
 * equals the table's class set for that probe. A class no branch can reach fails
 * here; so does a branch that emits a class the table does not carry.
 */
describe("reachability — every table class is emittable by its localizer", () => {
  const emitted = (probe: ProbeId, parses: DefectClass[][]): void => {
    const union = [...new Set(parses.flat())].sort();
    expect(union).toEqual(defectClassesForProbe(probe).sort());
  };

  it("probe-contact", () => {
    emitted("probe-contact", [
      localizeContact(
        mkCascade({
          fields: {},
          rawText: "jordan@example.com · (312) 555-0100 · Austin, TX",
          sections: { profile: [] },
        }),
      ).defects,
    ]);
  });

  it("probe-skills", () => {
    emitted("probe-skills", [
      localizeSkills(
        mkCascade({ fields: { skills: [] }, sections: { skills: ["Python, Go"] } }),
      ).defects,
      localizeSkills(
        mkCascade({
          fields: { skills: [] },
          sections: {},
          markdown: "# Skills Summary\nPython, Go\n# Experience\n",
        }),
      ).defects,
      localizeSkills(
        mkCascade({
          fields: { skills: [] },
          sections: {},
          markdown: "# Experience\nSome role\n",
        }),
      ).defects,
    ]);
  });

  it("probe-experience", () => {
    emitted("probe-experience", [
      localizeExperience(
        mkCascade({
          fields: { experience: [] },
          sections: { experience: ["Engineer, Acme", "Jan 2020 – Jan 2022"] },
        }),
      ).defects,
      localizeExperience(
        mkCascade({
          fields: {
            experience: [{ title: "Engineer", company: "Acme" }],
          },
          sections: {
            experience: ["Jan 2020 – Jan 2021", "Feb 2021 – Feb 2022"],
          },
        }),
      ).defects,
    ]);
  });

  it("probe-education", () => {
    emitted("probe-education", [
      localizeEducation(
        mkCascade({
          fields: { education: [] },
          sections: { education: ["Bachelor of Science, State University"] },
        }),
      ).defects,
      localizeEducation(
        mkCascade({
          fields: { education: [] },
          sections: {},
          markdown: "# education overview\nBachelor of Science\n# Skills\n",
        }),
      ).defects,
      localizeEducation(
        mkCascade({
          fields: { education: [] },
          sections: {},
          markdown: "# Experience\nSome role\n",
        }),
      ).defects,
      localizeEducation(
        mkCascade({
          fields: { education: [{ institution: "State University", degree: "BS" }] },
          sections: {
            education: [
              "Bachelor of Science, State University",
              "Master of Science, Other University",
            ],
          },
        }),
      ).defects,
    ]);
  });

  it("probe-achievements", () => {
    emitted("probe-achievements", [
      localizeAchievements(
        mkCascade({
          fields: { heuristic_achievements: [] },
          sections: { achievements: ["Award · Best Paper, 2022"] },
        }),
      ).defects,
      localizeAchievements(
        mkCascade({
          fields: {
            heuristic_achievements: [{ type: "Award", title: "Best Paper" }],
          },
          sections: {
            achievements: ["Award · Best Paper", "- bullet", "Award · Second Prize"],
          },
        }),
      ).defects,
      localizeAchievements(
        mkCascade({ fields: { heuristic_achievements: [] }, sections: {} }),
      ).defects,
    ]);
  });

  it("probe-roundtrip", () => {
    const before = mkCascade({
      fields: {
        email: "a@example.com",
        summary: "A".repeat(100),
        skills: ["Go"],
        experience: [{ title: "Engineer", company: "Acme" }],
        education: [{ institution: "State University", degree: "BS" }],
      },
    });
    const changed = mkCascade({
      fields: {
        email: "b@example.com",
        summary: "A".repeat(50),
        skills: ["Rust"],
        experience: [{ title: "Senior Engineer", company: "Acme" }],
        education: [{ institution: "Other University", degree: "BS" }],
      },
    });
    emitted("probe-roundtrip", [
      localizeRoundtripHop(before, changed).defects,
      localizeRoundtripHop(before, undefined, "boom").defects,
    ]);
  });
});
