// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `sweepParse()` — the merge + oracle gate the `/probe-resume` harness and the
 * corpus bake BOTH run. Its one load-bearing job: a class whose oracle could not
 * run must land in `withheld`, never in `defects`, so no consumer can print an
 * affirmative "no defects" over a parse that was never read.
 */

import { describe, it, expect } from "vitest";

import { sweepParse, isTextOracleUnavailable, isParseUnreadable } from "./sweep.ts";
import { mkCascade } from "./localize/__test-utils__.ts";
import type { CascadeResult } from "./types.ts";

/** A readable parse with a clean, fully-routed résumé. */
const healthy = (): CascadeResult =>
  mkCascade({
    fields: {
      full_name: "Jordan Rivera",
      email: "jordan@example.com",
      phone: "(312) 555-0123",
      location: "Chicago, IL",
      skills: ["Go"],
      experience: [{ title: "Engineer", company: "Acme" }],
      education: [{ institution: "State University", degree: "BS" }],
      heuristic_achievements: [{ type: "Award", title: "Best Paper" }],
    },
    sections: {
      profile: ["Jordan Rivera"],
      skills: ["Go"],
      experience: ["Engineer, Acme"],
      education: ["BS, State University"],
      achievements: ["Award · Best Paper"],
    },
    markdown: "# Skills\nGo\n",
    rawText: "Jordan Rivera jordan@example.com (312) 555-0123 Chicago, IL",
  });

/** The scanned repro: the layout probe short-circuited Tier 1 — zero text. */
const scanned = (): CascadeResult => {
  const c = mkCascade({ fields: {}, sections: {}, rawText: "" });
  return { ...c, triggers: ["scanned"] } as CascadeResult;
};

describe("isTextOracleUnavailable", () => {
  it("is false on a parse that produced text", () => {
    expect(isTextOracleUnavailable(healthy())).toBe(false);
  });

  it("is true on a scanned PDF and on an empty rawText", () => {
    expect(isTextOracleUnavailable(scanned())).toBe(true);
    expect(isTextOracleUnavailable(mkCascade({ rawText: "   " }))).toBe(true);
  });
});

describe("sweepParse", () => {
  it("reports a healthy parse as clean, with nothing withheld", () => {
    const s = sweepParse(healthy(), { after: healthy() });
    expect(s.defects).toEqual([]);
    expect(s.withheld).toEqual([]);
    expect(s.derived.textOracleUnavailable).toBe(false);
    expect(s.derived.headerOracleUnavailable).toBe(false);
    expect(s.derived.roundtripOracleUnavailable).toBe(false);
    expect(s.sectionOverview).toContain("skills(1)");
  });

  it("WITHHOLDS every text-derived class on a scanned parse — it never reports clean", () => {
    // THE regression this exists to prevent: 0 characters extracted, every
    // derived bit false, and the sweep printing "no defect class is exhibited by
    // this parse". `defects: []` here is meaningless UNLESS `withheld` is empty.
    const s = sweepParse(scanned(), { after: scanned() });
    expect(s.derived.textOracleUnavailable).toBe(true);
    expect(s.defects).toEqual([]);
    expect(s.withheld.length).toBeGreaterThan(0);
    // Notably: the localizers DID claim `achievements-no-section` (0 entries, no
    // region) — the gate is what stops that claim from being believed.
    expect(s.achievements.defects).toEqual(["achievements-no-section"]);
    expect(s.withheld).toContain("achievements-no-section");
    expect(s.defects).not.toContain("achievements-no-section");
  });

  it("WITHHOLDS the roundtrip value classes when the hop produced no `after`", () => {
    const s = sweepParse(healthy(), { renderError: "renderAtsResumePdf threw: boom" });
    expect(s.derived.roundtripOracleUnavailable).toBe(true);
    expect(s.derived.renderThrewOnRoundtrip).toBe(true);
    // The crash itself is OBSERVED, so it is reported…
    expect(s.defects).toEqual(["roundtrip-render-crash"]);
    // …but "no value changed across the round-trip" is not a finding about a
    // round-trip that never happened.
    expect(s.withheld).toEqual([
      "roundtrip-contact-value-changed",
      "roundtrip-experience-value-changed",
      "roundtrip-education-value-changed",
      "roundtrip-skills-value-changed",
      "roundtrip-summary-value-changed",
    ]);
  });

  it("keeps a real defect, and the section overview that explains an advisory", () => {
    // The dropped-skills repro: a real skills block under a header the router
    // neither aliases nor anchors, so its 7 lines land in `profile` and the
    // parse carries no `skills` section at all. The advisory is the only trace —
    // and `sectionOverview` is what tells the reader the block did not vanish,
    // it moved.
    const cascade = mkCascade({
      fields: {
        full_name: "Jordan Rivera",
        skills: [],
        experience: [{ title: "Engineer", company: "Acme" }],
      },
      sections: {
        profile: ["Jordan Rivera", "TECHNICAL PROFICIENCIES", "Go, Rust, SQL"],
        experience: ["Engineer, Acme"],
      },
      markdown: "# TECHNICAL PROFICIENCIES\nGo, Rust, SQL\n",
      rawText: "Jordan Rivera TECHNICAL PROFICIENCIES Go, Rust, SQL",
    });
    const s = sweepParse(cascade, { after: cascade });
    expect(s.defects).toContain("skills-no-section");
    expect(s.withheld).toEqual([]);
    expect(s.sectionOverview).toEqual(["profile(3)", "experience(1)"]);
  });
});

describe("isParseUnreadable", () => {
  // The single definition of "⛔ PARSE UNREADABLE" the `/probe-resume` harness
  // gates its defect report and corpus coverage on. It must agree with
  // `sweepParse()`'s own oracle gate (`textOracleUnavailable`) AND catch the
  // second failure mode `sweepParse()` cannot see on its own: a parse that read
  // text but the extractor pulled nothing structured out of it.

  it("is true on a scanned parse, regardless of extractedCharCount", () => {
    const s = sweepParse(scanned(), { after: scanned() });
    expect(isParseUnreadable(s.derived, 0)).toBe(true);
    expect(isParseUnreadable(s.derived, 42)).toBe(true);
  });

  it("is true when extractedCharCount is 0 even though the text oracle read something", () => {
    const s = sweepParse(healthy(), { after: healthy() });
    expect(s.derived.textOracleUnavailable).toBe(false);
    expect(isParseUnreadable(s.derived, 0)).toBe(true);
  });

  it("is false on a healthy parse with nonzero extraction", () => {
    const s = sweepParse(healthy(), { after: healthy() });
    expect(isParseUnreadable(s.derived, 42)).toBe(false);
  });
});
