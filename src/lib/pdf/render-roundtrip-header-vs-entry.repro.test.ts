// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * §7 header-vs-entry acceptance test (#444, Stage C;
 * `docs/canonical-resume-model.md` §7).
 *
 * The problem class #438 names is real: "is this line a category header or a
 * dated entry?" is decided today from **adjacent raw-line signals** — the #425
 * flush-right-date exemption in `columnGapCuts` pops a trailing lone-date segment
 * when `isLoneDateRange` matches (`sections.ts:264`) — not from a structured
 * field. Stage C's move is that the render+export projection reads the answer
 * that is **already structured** on the canonical entry: an
 * experience/education entry carrying `start_date` / `end_date` **is** a dated
 * entry by construction, exposed as the derived {@link isDatedEntry} predicate
 * (derived, not stored — locked via `/clarify`, 2026-07-11).
 *
 * Acceptance: a one-line `Title  Dates` role under a section header — with the
 * degenerate shape where the flush-right date is the *only* signal the line is
 * an entry and not a sub-section boundary (no company glued onto it) — must
 * round-trip back to a **dated experience entry**, not fold into prose and not
 * open a stray sub-section. Carries green through Stage E.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { buildAtsResumeModel, isDatedEntry } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

// A title-only role: the header line is "Title   <range>" with the date drawn
// flush-right. With no company on the line, the flush-right date is the sole cue
// that this is a dated ENTRY rather than a sub-section header — exactly the §7
// case. Two such roles so "not a sub-section boundary" has teeth (a boundary
// misread would collapse them).
const ROLES = [
  {
    title: "Staff Engineer",
    company: "",
    start_date: "Jan 2020",
    end_date: "Mar 2023",
    description:
      "Rebuilt the billing pipeline to cut latency by 40%\nMentored six engineers across two teams",
  },
  {
    title: "Senior Engineer",
    company: "",
    start_date: "Jun 2016",
    end_date: "Dec 2019",
    description:
      "Shipped the search-ranking service to 10M users\nCut infrastructure spend 25% year over year",
  },
];

function makeResult(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Alex Candidate",
        email: "alex@example.com",
        phone: "(312) 555-0123",
        location: "Chicago, IL",
        summary: "Backend engineer with a decade building high-scale services.",
        skills: ["Go", "Distributed Systems", "PostgreSQL"],
        experience: ROLES,
        education: [],
        projects: [],
        heuristic_achievements: [],
      },
      sections: { byName: new Map(), accomplishmentSections: ["experience", "projects", "achievements"], source: "regex" },
      fieldConfidence: {},
    },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

const fakeScore = { bullets: [] } as unknown as AnonymousAtsScore;

describe("§7 header-vs-entry — a one-line `Title  Dates` role routes as a dated entry (#444)", () => {
  it("derives isDatedEntry from the entry's structured dates, not a raw-line re-scan", () => {
    // The structured answer is already on the entry — no isLoneDateRange over a
    // formatted string, no neighboring-line scan.
    expect(isDatedEntry(ROLES[0])).toBe(true);
    expect(isDatedEntry(ROLES[1])).toBe(true);
    // Derivation only, never a stored field: a dateless entry derives false.
    expect(isDatedEntry({ title: "Volunteer Lead" } as never)).toBe(false);
  });

  let model: ReturnType<typeof buildAtsResumeModel>;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    model = buildAtsResumeModel(makeResult(), fakeScore);
    reparsed = await runCascade(await renderAtsResumePdf(model));
  });

  it("renders the title-only role with its range drawn flush-right on the header (the entry cue)", () => {
    const exp = model.sections.find((s) => s.heading === "Experience");
    const entries = exp?.entries ?? [];
    // A dated entry with no org anchor puts the title on the header and routes
    // the range to the flush-right `headerLineDate` slot — the exemption keeps it
    // merged on re-parse so the line reads as an entry, not a boundary.
    expect(entries[0]?.headerLine).toBe("Staff Engineer");
    expect(entries[0]?.headerLineDate).toBe("Jan 2020 – Mar 2023");
    expect(entries[1]?.headerLine).toBe("Senior Engineer");
    expect(entries[1]?.headerLineDate).toBe("Jun 2016 – Dec 2019");
  });

  it("re-parses both one-line roles back as dated experience entries, not a folded boundary", () => {
    const reExp = reparsed.canonical.fields.experience ?? [];
    // Both roles survive as distinct dated entries — neither collapsed into the
    // other nor dropped into prose.
    expect(reExp.length).toBe(ROLES.length);
    ROLES.forEach((orig, i) => {
      expect(reExp[i]?.title).toBe(orig.title);
      expect(reExp[i]?.start_date).toBe(orig.start_date);
      expect(reExp[i]?.end_date).toBe(orig.end_date);
      // The structured predicate holds on the re-parsed entry too.
      expect(isDatedEntry(reExp[i] ?? {})).toBe(true);
    });
  });
});
