// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the pure chain-of-sections input builders (#67) that
 * ReconstructedResume hands the orchestrator. The container itself is
 * render-only (node-env suite, no RTL), but `buildResumeSections` and
 * `roleLabel` are pure data transforms — covered here directly.
 */

import { describe, expect, it } from "vitest";
import { buildResumeSections, roleLabel } from "./ReconstructedResume.tsx";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import type { BulletObservation } from "../../lib/score/score.ts";

function bullet(index: number, text: string): BulletObservation {
  return {
    text,
    index,
    hasMetric: false,
    startsWithActionVerb: false,
    wellFormedLength: false,
    wordCount: text.split(/\s+/).length,
  };
}

function group(
  experienceIndex: number | null,
  experience: BulletGroup["experience"],
  bullets: BulletObservation[],
): BulletGroup {
  return { experienceIndex, experience, bullets };
}

describe("roleLabel", () => {
  it("returns the Other-bullets label for the null group", () => {
    expect(roleLabel(null)).toBe("Other bullets");
  });

  it("joins title and company with an em dash when both present", () => {
    expect(roleLabel({ title: "Engineer", company: "Acme" })).toBe(
      "Engineer — Acme",
    );
  });

  it("falls back to title alone, then company alone", () => {
    expect(roleLabel({ title: "Engineer" })).toBe("Engineer");
    expect(roleLabel({ company: "Acme" })).toBe("Acme");
  });

  it("returns Untitled role when neither title nor company is present", () => {
    expect(roleLabel({})).toBe("Untitled role");
  });
});

describe("buildResumeSections", () => {
  it("prepends a summary section (id 'summary') when the summary is non-empty", () => {
    const sections = buildResumeSections("  Engineer with 10 years.  ", [], {});
    expect(sections).toEqual([
      {
        kind: "summary",
        id: "summary",
        label: "Summary",
        text: "Engineer with 10 years.",
      },
    ]);
  });

  it("omits the summary section when undefined or whitespace-only", () => {
    expect(buildResumeSections(undefined, [], {})).toEqual([]);
    expect(buildResumeSections("   ", [], {})).toEqual([]);
  });

  it("appends each experience role in display order with a stable id", () => {
    const groups = [
      group(0, { title: "Engineer", company: "Acme" }, [bullet(0, "Built X")]),
      group(1, { title: "Lead", company: "Beta" }, [bullet(1, "Led Y")]),
    ];
    const sections = buildResumeSections(undefined, groups, {});
    expect(sections).toEqual([
      {
        kind: "experience",
        id: "experience:0",
        label: "Engineer — Acme",
        bullets: ["Built X"],
      },
      {
        kind: "experience",
        id: "experience:1",
        label: "Lead — Beta",
        bullets: ["Led Y"],
      },
    ]);
  });

  it("excludes the Other group (experienceIndex null) and zero-bullet groups", () => {
    const groups = [
      group(null, null, [bullet(0, "Orphan bullet")]),
      group(2, { title: "Engineer" }, []),
    ];
    expect(buildResumeSections(undefined, groups, {})).toEqual([]);
  });

  it("applies bullet overrides (#82) so the model sees the user's latest edits", () => {
    const groups = [
      group(0, { title: "Engineer" }, [
        bullet(5, "Stale text"),
        bullet(6, "Kept text"),
      ]),
    ];
    const sections = buildResumeSections(undefined, groups, {
      5: "Edited text",
    });
    expect(sections).toEqual([
      {
        kind: "experience",
        id: "experience:0",
        label: "Engineer",
        bullets: ["Edited text", "Kept text"],
      },
    ]);
  });
});
