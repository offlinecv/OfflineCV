// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip regression for #672 — an experience role carrying ONLY an end date
 * came back from Download-PDF with that value in `start_date` and the `end_date`
 * key gone. "Left Contoso in 2022" silently became "joined Contoso in 2022", and
 * the corruption RAISED the score: `computeAnonymousAtsScore`'s date-completeness
 * check filters on `start_date`, so the role read incomplete before the round trip
 * and complete after it.
 *
 * Runs the FULL production leg, edit seam included:
 *
 *   parsed + overrides → applyOverrides → buildAtsResumeModel
 *                      → renderAtsResumePdf → runCascade
 *
 * The seam is the point. `applyOverrides` is where the fix lives (the export can
 * only draw one date anchor, and the parser reads a lone token as a start date —
 * see `edit/experience-dates.ts` for why the exporter is the wrong place to fix
 * it), so a test that built the end-only shape directly as a `CascadeResult` would
 * be asserting against a state the app can no longer produce. These build it the
 * way a user does: by clearing a start date, by typing an end date onto an ongoing
 * role, and by adding a role with only an end date filled in.
 *
 * The whole variant matrix runs on ONE render — six roles in `baseParsed`, one per
 * date shape: bare year, month + year, ongoing/`is_current`, a re-anchor beside a
 * location, and the two controls. The controls are the guarantees of
 * `render-roundtrip-year-only.repro.test.ts` (#358, the lone-START case)
 * re-asserted through this path — a fix that "solved" the end-only case by moving
 * the lone-start or the two-sided case would pass the first test here and fail
 * those.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import { applyOverrides } from "../edit/apply-overrides.ts";
import type { ExperienceFieldOverrides } from "../../hooks/useEditableParse.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

const STUB_SCORE = { bullets: [] } as unknown as AnonymousAtsScore;

function makeSections(): SectionedResume {
  return {
    byName: new Map() as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

/** Six roles, one per date shape, so one render covers the whole matrix. */
function baseParsed(): HeuristicParsedResume {
  return {
    full_name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    skills: ["TypeScript", "SQL"],
    experience: [
      // 0 — the repro: a dated role whose START the user clears.
      { title: "Alpha Analyst", company: "Contoso", start_date: "2019", end_date: "2022", description: "Ran the alpha ledger." },
      // 1 — same, month + year, to pin that the token shape is irrelevant.
      { title: "Echo Editor", company: "Adventure Works", start_date: "Jan 2019", end_date: "May 2022", description: "Edited the house style guide." },
      // 2 — control: lone START (#358).
      { title: "Charlie Composer", company: "Northwind", start_date: "2022", description: "Scored the winter program." },
      // 3 — control: two-sided range.
      { title: "Delta Director", company: "Litware", start_date: "2019", end_date: "2022", description: "Directed the delta program." },
      // 4 — the ONGOING shape #672 calls "a distinct and worse failure": a current
      // role the user gives an end date to. `experienceDateRange` and the
      // `AtsEntryFields` builder both let `is_current` win, so a surviving flag
      // draws "2019 – Present" and the typed end date never reaches the file.
      { title: "Golf Guide", company: "Fabrikam", start_date: "2019", is_current: true, description: "Guided the golf programme." },
      // 5 — the re-anchor with a LOCATION beside it: the header carries
      // "Company, City, ST" AND the collapsed date, so the two must not collide.
      { title: "Hotel Host", company: "Wingtip Toys", location: "Austin, TX", start_date: "2019", end_date: "2021", description: "Hosted the hotel programme." },
      // 6 — the issue's ongoing/no-start row: a current role whose START the user clears.
      { title: "India Intern", company: "Proseware", start_date: "2019", is_current: true, description: "Interned on the india programme." },
    ],
    education: [],
  };
}

/** What one role's dates look like on each side of the round trip. */
interface DatePair {
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
}

function datesOf(entry: DatePair | undefined): DatePair {
  return {
    ...(entry?.start_date !== undefined ? { start_date: entry.start_date } : {}),
    ...(entry?.end_date !== undefined ? { end_date: entry.end_date } : {}),
    ...(entry?.is_current !== undefined ? { is_current: entry.is_current } : {}),
  };
}

async function roundTrip(
  overrides: Record<number, ExperienceFieldOverrides>,
): Promise<{ applied: HeuristicParsedResume; reparsed: CascadeResult }> {
  const applied = applyOverrides(
    baseParsed(),
    "raw",
    makeSections(),
    {},
    overrides,
    {},
    [],
  );
  const display = {
    canonical: {
      fields: applied.fields,
      sections: makeSections(),
      fieldConfidence: applied.fieldConfidence,
    },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
  const bytes = await renderAtsResumePdf(buildAtsResumeModel(display, STUB_SCORE));
  return { applied: applied.fields, reparsed: await runCascade(bytes) };
}

function roleNamed(result: CascadeResult, name: string) {
  const roles = result.canonical.fields.experience ?? [];
  return roles.find((e) => e.title === name || e.company === name);
}

function appliedRole(applied: HeuristicParsedResume, name: string) {
  return applied.experience.find((e) => e.title === name);
}

describe("#672 — a role whose start date was cleared round-trips as one date, in one slot", () => {
  let applied: HeuristicParsedResume;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    // Clear the start date on roles 0, 1, 5, and 6 — the plainest user intent there
    // is, a correction — give the ongoing role 4 an end date instead, and leave
    // the two controls untouched.
    ({ applied, reparsed } = await roundTrip({
      0: { start_date: "" },
      1: { start_date: "" },
      4: { end_date: "2022" },
      5: { start_date: "" },
      6: { start_date: "" },
    }));
  });

  /**
   * The load-bearing assertion, and the reason every case below compares the two
   * SIDES rather than just naming the expected values: what comes out of the file
   * is not by itself evidence of anything. Before #672, the end-only role
   * re-parsed with `start_date: "2022"` too — the export drew a bare "2022" and
   * `parseDateRange` read it as a start. Asserting the output alone would have
   * PASSED on the broken build. What was broken is that the app HELD
   * `{start: "", end: "2022"}` while the file said `{start: "2022"}`, so the
   * defect is the disagreement, and the disagreement is what this checks.
   */
  function expectNoSlotDrift(name: string, expected: DatePair) {
    const before = datesOf(appliedRole(applied, name));
    const after = datesOf(roleNamed(reparsed, name));
    expect(before).toEqual(expected);
    expect(after).toEqual(expected);
  }

  it("keeps the surviving date, in the slot the export can actually represent", () => {
    expectNoSlotDrift("Alpha Analyst", { start_date: "2022" });
  });

  it("does the same for a month + year token", () => {
    expectNoSlotDrift("Echo Editor", { start_date: "May 2022" });
  });

  it("leaves the lone-start control (#358) untouched", () => {
    expectNoSlotDrift("Charlie Composer", { start_date: "2022" });
  });

  it("leaves the two-sided-range control untouched", () => {
    expectNoSlotDrift("Delta Director", { start_date: "2019", end_date: "2022" });
  });

  it("gives up 'ongoing' when the user supplies an end date", () => {
    // `is_current` is a claim that no end date exists. Keeping it here is the same
    // silent rewrite as #672 pointing the other way — the file would say
    // "2019 – Present" while the user typed 2022.
    expectNoSlotDrift("Golf Guide", { start_date: "2019", end_date: "2022" });
  });

  it("re-anchors beside a location without disturbing it", () => {
    expectNoSlotDrift("Hotel Host", { start_date: "2021" });
  });

  it("drops an unanchored 'ongoing' claim rather than drawing a bare Present", () => {
    expectNoSlotDrift("India Intern", {});
  });

  it("keeps the location on the re-anchored role", () => {
    // The collapse rewrites the header's date slot; the header also carries
    // "Company, City, ST". A fix that re-anchored by rebuilding the header line
    // would drop or absorb the location, and the date assertion alone cannot see
    // it.
    expect(appliedRole(applied, "Hotel Host")?.location).toBe("Austin, TX");
    expect(roleNamed(reparsed, "Hotel Host")?.location).toBe("Austin, TX");
  });
});

describe("#672 — a role ADDED with only an end date round-trips the same way", () => {
  it("routes the added role through the same rule as an edited one", async () => {
    const applied = applyOverrides(
      baseParsed(),
      "raw",
      makeSections(),
      {},
      {},
      {},
      [],
      {},
      { removed: [], added: [] },
      [
        {
          id: "added:1",
          section: "experience",
          title: "Foxtrot Fellow",
          subtitle: "Tailspin Toys",
          end_date: "2021",
        },
      ],
      { "added:1": ["Ran the fellowship programme."] },
    );
    const added = applied.fields.experience.find((e) => e.title === "Foxtrot Fellow");
    expect(added).toBeDefined();
    // Normalised at the seam, not at export: "+ Add role" with only an end date
    // filled in is the second way a user reaches the unrepresentable shape.
    expect(added!.start_date).toBe("2021");
    expect("end_date" in added!).toBe(false);

    const display = {
      canonical: {
        fields: applied.fields,
        sections: makeSections(),
        fieldConfidence: applied.fieldConfidence,
      },
      confidence: 1,
      triggers: [],
      linkAnnotations: [],
      rawText: "",
    } as unknown as CascadeResult;
    const bytes = await renderAtsResumePdf(buildAtsResumeModel(display, STUB_SCORE));
    const reparsed = await runCascade(bytes);
    const foxtrot = roleNamed(reparsed, "Foxtrot Fellow");
    expect(foxtrot).toBeDefined();
    expect(foxtrot!.start_date).toBe("2021");
    expect(foxtrot!.end_date).toBeUndefined();
  });
});
