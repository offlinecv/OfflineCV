// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The unit test `edit-pipeline.ts`'s extraction was justified by (#922 review).
 *
 * That module's docblock says the three steps were moved out of
 * `useAnalyzedResume` because the one carrying a real invariant —
 * {@link probeScoringProfileSlots} — "could only be tested by rendering". It
 * stayed only-tested-by-rendering until this file existed, which made the claim
 * a description of the old state rather than of the new one.
 *
 * The invariant under test is NOT "the probe returns these four fields". It is
 * that the probe's answer to *did this contact-link edit move the score* agrees
 * with what a real `applyOverrides` fold actually does to the legacy slots —
 * because the probe is what stands in for `profileOverrides` in the `score`
 * memo's dep list (#428), and a probe that drifts from the fold makes the score
 * silently stale for the channel that drifted. So every case below asserts the
 * probe **against a real fold of the same override**, never against a
 * hand-written expectation of its own.
 */

import { describe, it, expect } from "vitest";
import {
  editBaseFromResult,
  foldEditedIntoResult,
  probeScoringProfileSlots,
} from "./edit-pipeline.ts";
import { applyOverrides } from "./apply-overrides.ts";
import type { EditBase } from "./apply-overrides.ts";
import type { ProfileOverride } from "../../hooks/useEditableParse.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";

function makeSections(): SectionedResume {
  return {
    byName: new Map<string, readonly string[]>() as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

function baseParsed(
  overrides: Partial<HeuristicParsedResume> = {},
): HeuristicParsedResume {
  return {
    full_name: "Jane Doe",
    email: "jane@example.com",
    skills: [],
    experience: [],
    education: [],
    ...overrides,
  } as HeuristicParsedResume;
}

function makeResult(parsed: HeuristicParsedResume): CascadeResult {
  return {
    canonical: {
      fields: parsed,
      sections: makeSections(),
      fieldConfidence: { full_name: 0.9, email: 0.9 },
    },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "raw text",
  } as unknown as CascadeResult;
}

function ov(
  id: string,
  url: string,
  legacyKey?: ProfileOverride["legacyKey"],
): ProfileOverride {
  return {
    id,
    url,
    network: "linkedin",
    kind: "social",
    ...(legacyKey ? { legacyKey } : {}),
  } as ProfileOverride;
}

/** Run the REAL fold and read back the four slots the probe claims to predict. */
function foldedSlots(
  parsed: HeuristicParsedResume,
  profileOverrides: readonly ProfileOverride[],
) {
  const base: EditBase = {
    parsed,
    rawText: "raw text",
    sections: makeSections(),
    observations: [],
    fieldConfidence: { full_name: 0.9, email: 0.9 },
  };
  // Spread: `EditSnapshot.profileOverrides` is a mutable `ProfileOverride[]`
  // (it is JSON-persisted), while the probe takes a `readonly` list.
  const out = applyOverrides(base, {
    profileOverrides: [...profileOverrides],
  });
  return {
    linkedin_url: out.fields.linkedin_url,
    github_url: out.fields.github_url,
    linkedinConfidence: out.fieldConfidence.linkedin_url,
    githubConfidence: out.fieldConfidence.github_url,
  };
}

describe("probeScoringProfileSlots agrees with a real applyOverrides fold", () => {
  it.each([
    [
      "a correction to linkedin_url",
      baseParsed({ linkedin_url: "https://linkedin.com/in/stale" }),
      [ov("p1", "https://linkedin.com/in/jane-doe", "linkedin_url")],
    ],
    [
      "a correction that CLEARS linkedin_url",
      baseParsed({ linkedin_url: "https://linkedin.com/in/jane-doe" }),
      [ov("p1", "", "linkedin_url")],
    ],
    [
      "an extra that back-fills an EMPTY github slot",
      baseParsed(),
      [ov("p2", "https://github.com/janedoe")],
    ],
    [
      "an extra that does NOT back-fill (the slot is already set)",
      baseParsed({ github_url: "https://github.com/janedoe" }),
      [ov("p2", "https://github.com/someone-else")],
    ],
    [
      "an extra on neither scoring slot (a personal site)",
      baseParsed(),
      [ov("p3", "https://janedoe.dev")],
    ],
    ["no overrides at all", baseParsed(), []],
  ])("%s", (_name, parsed, profileOverrides) => {
    // The probe must never mutate the caller's parse — `useAnalyzedResume`
    // hands it `base.canonical.fields` directly, and the base parse is frozen.
    const before = JSON.stringify(parsed);

    const probed = probeScoringProfileSlots(parsed, profileOverrides);

    expect(JSON.stringify(parsed)).toBe(before);
    expect(probed).toEqual(foldedSlots(parsed, profileOverrides));
  });
});

describe("probeScoringProfileSlots returns only the SCORING slots", () => {
  it("does not surface portfolio/website, which never reach the scorer", () => {
    const probed = probeScoringProfileSlots(
      baseParsed({
        portfolio_url: "https://janedoe.dev",
        website_url: "https://blog.janedoe.dev",
      }),
      [],
    );
    // Four keys and no more: the `score` memo depends on these individually
    // (#428), so a fifth would be a dep nobody added and a stale score.
    expect(Object.keys(probed).sort()).toEqual([
      "githubConfidence",
      "github_url",
      "linkedinConfidence",
      "linkedin_url",
    ]);
  });
});

describe("editBaseFromResult", () => {
  it("reads the frozen half off the result, with observations passed in", () => {
    const parsed = baseParsed();
    const result = makeResult(parsed);
    const observations = [] as const;

    const base = editBaseFromResult(result, observations);

    // By reference, not by copy — the fold clones what it mutates, and paying
    // for a second clone here would be invisible waste on every keystroke.
    expect(base.parsed).toBe(result.canonical.fields);
    expect(base.sections).toBe(result.canonical.sections);
    expect(base.fieldConfidence).toBe(result.canonical.fieldConfidence);
    expect(base.rawText).toBe(result.rawText);
    expect(base.observations).toBe(observations);
  });
});

describe("foldEditedIntoResult", () => {
  it("swaps in the edited fields and confidence, keeping sections and rawText", () => {
    const result = makeResult(baseParsed());
    const edited = baseParsed({ full_name: "Jane Q. Doe" });
    const fieldConfidence = { full_name: 1 };

    const out = foldEditedIntoResult(result, edited, fieldConfidence);

    expect(out.canonical.fields).toBe(edited);
    expect(out.canonical.fieldConfidence).toBe(fieldConfidence);
    // `sections` and `rawText` stay the BASE's on purpose (#445) — display
    // never showed the edited section pool, and grading this value instead of
    // the `applyOverrides` result is what manufactured #487.
    expect(out.canonical.sections).toBe(result.canonical.sections);
    expect(out.rawText).toBe(result.rawText);
  });

  it("does not mutate the base result", () => {
    const result = makeResult(baseParsed());
    const before = result.canonical.fields;

    foldEditedIntoResult(result, baseParsed({ full_name: "Someone Else" }), {});

    expect(result.canonical.fields).toBe(before);
    expect(result.canonical.fields.full_name).toBe("Jane Doe");
  });
});
