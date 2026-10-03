// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Full-leg round-trip regression for #686 — `is_current` is now reachable
 * from the edit lane (the "Current role" checkbox), and the export has to
 * agree with the card for every shape the checkbox can produce.
 *
 * Runs the same production leg as `render-roundtrip-lone-end-date.repro.test.ts`:
 *
 *   parsed + overrides → applyOverrides → buildAtsResumeModel
 *                      → renderAtsResumePdf → runCascade
 *
 * The override-map shapes fed to `applyOverrides` here are exactly what
 * `useEditableParse.setExperienceField` PRODUCES for each UI gesture — pinned
 * separately, against the real hook, in
 * `useEditableParse.is-current-toggle.repro.test.tsx`. This file's job is the
 * other half: that once the map holds that shape, the exported PDF re-parses
 * to agree with it.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import { applyOverrides } from "../edit/apply-overrides.ts";
import type {
  AddedEntry,
  ExperienceFieldOverrides,
} from "../../hooks/useEditableParse.ts";
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

function baseParsed(): HeuristicParsedResume {
  return {
    full_name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    skills: ["TypeScript", "SQL"],
    experience: [
      // 0 — not current, dated. The checkbox ticks it on.
      {
        title: "Alpha Analyst",
        company: "Contoso",
        start_date: "2019",
        end_date: "2022",
        description: "Ran the alpha ledger.",
      },
      // 1 — parsed ongoing. The checkbox unticks it, no end date supplied.
      {
        title: "Bravo Builder",
        company: "Fabrikam",
        start_date: "2020",
        is_current: true,
        description: "Built the bravo pipeline.",
      },
      // 2 — the #686 restore repro: parsed ongoing, End committed then
      // withdrawn. `{end_date: ""}` with NO `is_current` key is exactly what
      // `setExperienceField`'s two-step sequence leaves in the map — see this
      // file's docblock.
      {
        title: "Charlie Curator",
        company: "Northwind",
        start_date: "2018",
        is_current: true,
        description: "Curated the charlie archive.",
      },
    ],
    education: [],
  };
}

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

async function renderAndReparse(
  applied: ReturnType<typeof applyOverrides>,
): Promise<CascadeResult> {
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
  const { bytes } = await renderAtsResumePdf(buildAtsResumeModel(display, STUB_SCORE));
  return runCascade(bytes);
}

async function roundTrip(
  overrides: Record<number, ExperienceFieldOverrides>,
  addedEntries: AddedEntry[] = [],
): Promise<{ applied: HeuristicParsedResume; reparsed: CascadeResult }> {
  const applied = applyOverrides(
    {
      parsed: baseParsed(),
      rawText: "raw",
      sections: makeSections(),
      observations: [],
    },
    {
      experienceOverrides: overrides,
      addedEntries,
    },
  );
  return { applied: applied.fields, reparsed: await renderAndReparse(applied) };
}

function roleNamed(result: CascadeResult, name: string) {
  const roles = result.canonical.fields.experience ?? [];
  return roles.find((e) => e.title === name || e.company === name);
}

function appliedRole(applied: HeuristicParsedResume, name: string) {
  return applied.experience.find((e) => e.title === name);
}

describe("#686 — the 'Current role' checkbox round-trips through Download PDF", () => {
  let applied: HeuristicParsedResume;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    ({ applied, reparsed } = await roundTrip(
      {
        // Ticking: End cleared (#686 — the user's last action wins).
        0: { is_current: true, end_date: "" },
        // Unticking: explicit false, no end date required.
        1: { is_current: false },
        // The restore repro: End committed then withdrawn leaves the map
        // holding ONLY the cleared end date — no `is_current` key at all —
        // so the PARSED `is_current: true` on role 2 shows through untouched.
        2: { end_date: "" },
      },
      [
        {
          id: "added:0",
          section: "experience",
          title: "Delta Driver",
          subtitle: "Litware",
          start_date: "2023",
          end_date: "",
          is_current: true,
        },
      ],
    ));
  }, 60_000);

  function expectAgreement(name: string, expected: DatePair) {
    const before = datesOf(appliedRole(applied, name));
    const after = datesOf(roleNamed(reparsed, name));
    expect(before).toEqual(expected);
    expect(after).toEqual(expected);
  }

  it("draws Present for a role newly marked current", () => {
    expectAgreement("Alpha Analyst", { start_date: "2019", is_current: true });
  });

  it("draws the bare start date for a role newly marked not-current", () => {
    expectAgreement("Bravo Builder", { start_date: "2020" });
  });

  it("restores Present once the end date that dropped it is withdrawn", () => {
    expectAgreement("Charlie Curator", { start_date: "2018", is_current: true });
  });

  it("round-trips an added role created as current", () => {
    expectAgreement("Delta Driver", { start_date: "2023", is_current: true });
  });
});
