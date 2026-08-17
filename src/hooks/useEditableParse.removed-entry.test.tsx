// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * #856 — deleting a PARSED entry, driven end-to-end.
 *
 * Proving it at the hook boundary would prove nothing: the whole defect was that
 * the UI had no affordance and the hook had no state for one, so "the set now
 * has a key in it" is not the claim. Each case below therefore folds the REAL
 * `useEditableParse` state through the REAL `applyOverrides` →
 * `computeAnonymousAtsScore` → `buildAtsResumeModel` chain that `/` runs, and
 * asserts against the three surfaces the issue names: the rendered parse, the
 * score, and the exported PDF.
 *
 * The delete gesture is the shipped one (`removeEntryWithBullets`), not a bare
 * `removeEntry` — the bullets are a separate write, and calling only half of it
 * is the failure mode the helper exists to prevent.
 *
 * The achievement fixture is TITLE-ONLY on purpose: it is parsed out of a single
 * `•`-marked line, so that line stays in the graded pool with no description to
 * attribute it to (`suppressTitleOwnedBullets` hides it from the UI). It is the
 * one shape where deleting the entry is not enough on its own.
 *
 * Mounted with raw `createRoot`, matching `useEditableParse.test.tsx` (the
 * project has no @testing-library/react).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useEditableParse,
  parsedEntryKey,
  survivingParsedIndices,
  type EditableParse,
  type EditSnapshot,
} from "./useEditableParse.ts";
import { removeEntryWithBullets } from "../lib/edit/entry-remove.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import {
  computeAnonymousAtsScore,
  type AnonymousAtsScore,
  type BulletObservation,
} from "../lib/score/score.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import { groupBulletsByExperience } from "../lib/score/group-bullets.ts";
import { projectScoreSections } from "../lib/heuristics/projections.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const LATENCY = "Cut p99 checkout latency by 38% via edge caching.";
const ONBOARDING = "Reduced onboarding time from 5 days to 2 days.";
const PATENT_LINE = "Patent · Issued US10275736B1, 2019";

function sections(lines: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>([["experience", lines]]);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

const SOURCE_LINES = [`• ${LATENCY}`, `• ${ONBOARDING}`, `• ${PATENT_LINE}`];

/** Two parsed roles (so a delete has a neighbour to get wrong) plus one
 *  title-only achievement. */
function baseResult(): CascadeResult {
  const blank = buildBlankResult();
  return {
    ...blank,
    rawText: SOURCE_LINES.join("\n"),
    canonical: toCanonicalResume(
      {
        full_name: "Robin Vasquez",
        email: "robin.vasquez@example.com",
        skills: ["typescript"],
        education: [],
        experience: [
          {
            title: "Staff Engineer",
            company: "Northwind Systems",
            start_date: "2020",
            end_date: "2024",
            description: LATENCY,
          },
          {
            title: "Engineer",
            company: "Cascadia Analytics",
            start_date: "2017",
            end_date: "2020",
            description: ONBOARDING,
          },
        ],
        heuristic_achievements: [
          { type: "Patent", title: "Issued US10275736B1", year: "2019" },
        ],
      },
      sections(SOURCE_LINES),
      {},
    ),
  };
}

/** The frozen base-parse observation pool (`doneScoreBullets` on `/`). */
const OBSERVATIONS: readonly BulletObservation[] = (() => {
  const base = baseResult();
  return (
    computeAnonymousAtsScore({
      parsed: base.canonical.fields,
      fieldConfidence: base.canonical.fieldConfidence,
      triggers: [],
      rawText: base.rawText,
      sections: base.canonical.sections,
    }).bullets ?? []
  );
})();

interface Regraded {
  score: AnonymousAtsScore;
  bulletTexts: string[];
  rawText: string;
  roleTitles: string[];
  achievementTitles: string[];
  /** Every header line the Download PDF would draw, across all sections. */
  exportedHeaders: string[];
  /** Every bullet the Download PDF would draw. */
  exportedBullets: string[];
}

/** Run the exact `/` pipeline over the hook's current override state. */
function regrade(api: EditableParse): Regraded {
  const base = baseResult();
  const core = applyOverrides(
    base.canonical.fields,
    base.rawText,
    base.canonical.sections,
    api.contactOverrides,
    api.experienceOverrides,
    api.bulletOverrides,
    OBSERVATIONS,
    api.educationOverrides,
    api.skillsOverride,
    api.addedEntries,
    api.addedBullets,
    api.removedBullets,
    api.profileOverrides,
    base.canonical.fieldConfidence,
    api.achievementOverrides,
    api.descriptionOverrides,
    api.summaryOverride,
    api.removedEntries,
  );
  const score = computeAnonymousAtsScore({
    parsed: core.fields,
    fieldConfidence: core.fieldConfidence,
    triggers: base.triggers,
    rawText: core.rawText,
    sections: projectScoreSections(core),
  });
  const display: CascadeResult = {
    ...base,
    canonical: {
      ...base.canonical,
      fields: core.fields,
      fieldConfidence: core.fieldConfidence,
    },
  };
  const model = buildAtsResumeModel(display, score);
  return {
    score,
    bulletTexts: (score.bullets ?? []).map((b) => b.text),
    rawText: core.rawText,
    roleTitles: core.fields.experience.map((e) => e.title),
    achievementTitles: (core.fields.heuristic_achievements ?? []).map(
      (a) => a.title,
    ),
    exportedHeaders: model.sections.flatMap((s) =>
      s.entries.map((e) => e.headerLine),
    ),
    exportedBullets: model.sections.flatMap((s) =>
      s.entries.flatMap((e) => e.bullets),
    ),
  };
}

/** The rendered bullet group for one parsed role, as `ReconstructedResume`
 *  builds it — the rows whose ids the delete gesture cascades over. */
function roleBullets(api: EditableParse, renderPos: number): BulletObservation[] {
  const r = regrade(api);
  const groups = groupBulletsByExperience(
    [...(r.score.bullets ?? [])],
    // Only the experience slice matters here; achievements are title-only.
    baseResult().canonical.fields.experience.map((e) => ({
      title: e.title,
      description: e.description,
    })),
  );
  return groups.find((g) => g.experienceIndex === renderPos)?.bullets ?? [];
}

let container: HTMLDivElement;
let root: Root;
let api: EditableParse;

function Probe() {
  api = useEditableParse();
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("deleting a parsed ACHIEVEMENT (#856, the reported case)", () => {
  it("drops it from the parse, the score and the exported PDF", () => {
    const before = regrade(api);
    expect(before.achievementTitles).toEqual(["Issued US10275736B1"]);
    expect(before.exportedHeaders.join(" ")).toContain("US10275736B1");
    expect(before.bulletTexts).toHaveLength(3);

    act(() =>
      removeEntryWithBullets(parsedEntryKey("achievements", 0), [], {
        onRemoveEntry: api.removeEntry,
        onRemoveBullet: api.removeBullet,
      }),
    );

    const after = regrade(api);
    expect(after.achievementTitles).toEqual([]);
    expect(after.exportedHeaders.join(" ")).not.toContain("US10275736B1");
    // Its own `•` source line left the graded pool with it — the entry carries
    // no description, so nothing else could have taken it out.
    expect(after.bulletTexts).toEqual([LATENCY, ONBOARDING]);
    expect(after.rawText).not.toContain("US10275736B1");
    expect(after.score.specificity).not.toEqual(before.score.specificity);
  });

  it("stays deleted across a re-render, and marks the résumé edited", () => {
    expect(api.hasEdits).toBe(false);
    act(() => api.removeEntry(parsedEntryKey("achievements", 0)));
    expect(api.hasEdits).toBe(true);
    expect([...api.removedEntries]).toEqual(["achievements:0"]);

    // A second render of the same state must not resurrect it.
    act(() => root.render(<Probe />));
    expect([...api.removedEntries]).toEqual(["achievements:0"]);
    expect(regrade(api).achievementTitles).toEqual([]);
  });

  it("is idempotent", () => {
    act(() => api.removeEntry(parsedEntryKey("achievements", 0)));
    const first = api.removedEntries;
    act(() => api.removeEntry(parsedEntryKey("achievements", 0)));
    expect(api.removedEntries).toBe(first);
  });
});

describe("deleting a parsed ROLE (#856)", () => {
  it("takes its bullets out of the score, rawText and the export", () => {
    const bullets = roleBullets(api, 0);
    expect(bullets.map((b) => b.text)).toEqual([LATENCY]);

    act(() =>
      removeEntryWithBullets(parsedEntryKey("experience", 0), bullets, {
        onRemoveEntry: api.removeEntry,
        onRemoveBullet: api.removeBullet,
      }),
    );

    const after = regrade(api);
    expect(after.roleTitles).toEqual(["Engineer"]);
    expect(after.bulletTexts).not.toContain(LATENCY);
    expect(after.bulletTexts).toContain(ONBOARDING);
    expect(after.rawText).not.toContain(LATENCY);
    expect(after.exportedBullets).not.toContain(LATENCY);
    expect(after.exportedBullets).toContain(ONBOARDING);
  });

  it("also drops bullets the user ADDED to that role", () => {
    const added = "Shipped a design system used by 40 engineers.";
    act(() => api.addBullet(parsedEntryKey("experience", 0), added));
    expect(regrade(api).bulletTexts).toContain(added);

    act(() =>
      removeEntryWithBullets(parsedEntryKey("experience", 0), roleBullets(api, 0), {
        onRemoveEntry: api.removeEntry,
        onRemoveBullet: api.removeBullet,
      }),
    );

    // The bucket is folded in DOWNSTREAM of the tombstone filter, so nothing
    // but `removeEntry` deleting it stops these lines from going on grading.
    expect(api.addedBullets).not.toHaveProperty("experience:0");
    expect(regrade(api).bulletTexts).toEqual([ONBOARDING, PATENT_LINE]);
  });

  it("leaves the SURVIVING role's own header edit on the right role", () => {
    // The UI resolves render position → parsed index through
    // `survivingParsedIndices`; feeding it the render position instead would
    // file this edit under index 0, i.e. against the role just deleted.
    act(() => api.removeEntry(parsedEntryKey("experience", 0)));
    const parsedIdx = survivingParsedIndices("experience", api.removedEntries, 1);
    expect(parsedIdx).toEqual([1]);

    act(() => api.setExperienceField(parsedIdx[0], "title", "Senior Engineer"));
    expect(regrade(api).roleTitles).toEqual(["Senior Engineer"]);
  });
});

describe("snapshot / replay / reset (#856)", () => {
  it("round-trips a deletion through snapshot → replay", () => {
    act(() => api.removeEntry(parsedEntryKey("achievements", 0)));
    act(() => api.removeEntry(parsedEntryKey("experience", 1)));
    const snap: EditSnapshot = api.snapshot;
    expect(snap.removedEntries).toEqual(["achievements:0", "experience:1"]);

    act(() => api.resetAll());
    expect(api.removedEntries.size).toBe(0);
    expect(api.hasEdits).toBe(false);
    expect(regrade(api).roleTitles).toEqual(["Staff Engineer", "Engineer"]);

    act(() => api.replay(snap));
    expect([...api.removedEntries].sort()).toEqual([
      "achievements:0",
      "experience:1",
    ]);
    expect(regrade(api).roleTitles).toEqual(["Staff Engineer"]);
    expect(regrade(api).achievementTitles).toEqual([]);
  });

  it("replays a snapshot written BEFORE this change without throwing", () => {
    // `EditSnapshot` is persisted (the blank draft in localStorage, the résumé
    // library), so a draft saved before #856 carries no `removedEntries` key at
    // all — the same back-compat contract `descriptionOverrides` has.
    const legacy = JSON.parse(
      JSON.stringify({ ...api.snapshot, removedEntries: undefined }),
    ) as EditSnapshot;
    expect(legacy.removedEntries).toBeUndefined();

    act(() => api.replay(legacy));
    expect(api.removedEntries.size).toBe(0);
    expect(regrade(api).roleTitles).toEqual(["Staff Engineer", "Engineer"]);
  });

  it("does not resurrect a deleted entry's added bullets on replay", () => {
    // A live session cannot write this pair (the delete empties the bucket), so
    // this pins the ORDER of the two replay steps against a hand-edited or
    // migrated snapshot rather than against ordinary use.
    const snap: EditSnapshot = {
      ...api.snapshot,
      addedBullets: { "experience:0": ["Ghost bullet nobody should grade."] },
      removedEntries: ["experience:0"],
    };
    act(() => api.replay(snap));
    expect(api.addedBullets).toEqual({});
    expect(regrade(api).bulletTexts).not.toContain(
      "Ghost bullet nobody should grade.",
    );
  });
});

describe("no regression to user-ADDED entry removal (#856)", () => {
  it("still splices the added entry out rather than tombstoning it", () => {
    let id = "";
    act(() => {
      id = api.addEntry("experience");
      api.setEntryField(id, "title", "Principal Engineer");
    });
    act(() => api.addBullet(id, "Ran the platform group."));
    expect(regrade(api).roleTitles).toContain("Principal Engineer");

    act(() => api.removeEntry(id));
    expect(api.addedEntries).toEqual([]);
    expect(api.addedBullets).toEqual({});
    // An added id must never land in the tombstone set — nothing downstream
    // could resolve it, and it would keep `hasEdits` true forever.
    expect(api.removedEntries.size).toBe(0);
    expect(api.hasEdits).toBe(false);
    expect(regrade(api).roleTitles).toEqual(["Staff Engineer", "Engineer"]);
  });
});

describe("survivingParsedIndices (#856)", () => {
  it("is the identity when nothing is deleted", () => {
    expect(survivingParsedIndices("experience", new Set(), 3)).toEqual([0, 1, 2]);
  });

  it("skips the deleted indices, in display order", () => {
    const removed = new Set(["achievements:0", "achievements:2"]);
    expect(survivingParsedIndices("achievements", removed, 2)).toEqual([1, 3]);
  });

  it("is unaffected by a tombstone for an index the parse no longer has", () => {
    // Subtracting the SET's size would over-shift every survivor here.
    const removed = new Set(["education:1", "education:9"]);
    expect(survivingParsedIndices("education", removed, 2)).toEqual([0, 2]);
  });

  it("ignores tombstones for other sections", () => {
    const removed = new Set(["projects:0", "added:4"]);
    expect(survivingParsedIndices("experience", removed, 2)).toEqual([0, 1]);
  });
});
