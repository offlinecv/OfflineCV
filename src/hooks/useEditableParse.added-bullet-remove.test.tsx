// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression test for #637 half 1 — "Remove bullet" was inert on every
 * user-added bullet.
 *
 * The removal has to be proven end-to-end, not at the hook boundary: the whole
 * defect was that the hook DID record something (`removedBullets`) and nothing
 * downstream could resolve it. So each case drives the REAL `useEditableParse`
 * and then folds its state through the REAL `applyOverrides` →
 * `computeAnonymousAtsScore` → `buildAtsResumeModel` chain that `/` runs, and
 * asserts against all three of the issue's surfaces: the rendered bullet pool,
 * the score, and the exported PDF model.
 *
 * `observations` is the FROZEN base-parse pool (`doneScoreBullets` in
 * `useAnalyzedResume`), deliberately built from the parsed role alone — that
 * asymmetry IS the bug: an added bullet never appears there, so an
 * index-keyed removal could never reach it.
 *
 * Mounted with raw `createRoot`, matching `useEditableParse.test.tsx` (the
 * project has no @testing-library/react).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEditableParse, type EditableParse } from "./useEditableParse.ts";
import { applyOverrides } from "../lib/edit/apply-overrides.ts";
import { bulletId } from "../lib/score/bullet-id.ts";
import {
  computeAnonymousAtsScore,
  countWords,
  type AnonymousAtsScore,
  type BulletObservation,
} from "../lib/score/score.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import {
  groupBulletsByExperience,
  type BulletGroup,
} from "../lib/score/group-bullets.ts";
import { projectScoreSections } from "../lib/heuristics/projections.ts";
import { buildBlankResult } from "../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../lib/heuristics/sections.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import { batchUndoTargets } from "../lib/rewrite-review/undo-batch.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PARSED_BULLET = "Cut p99 checkout latency by 38% via edge caching.";
const ADDED_BULLET = "Shipped a design system used by 40 engineers.";

function sections(experience: readonly string[]): SectionedResume {
  const byName = new Map<string, readonly string[]>([["experience", experience]]);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

/** One PARSED role carrying `PARSED_BULLET`. The added role arrives via the
 *  hook's own `addEntry`, exactly as "+ Add experience" produces it. */
function baseResult(): CascadeResult {
  const blank = buildBlankResult();
  return {
    ...blank,
    rawText: `• ${PARSED_BULLET}`,
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
            description: PARSED_BULLET,
          },
        ],
      },
      sections([`• ${PARSED_BULLET}`]),
      {},
    ),
  };
}

/** The frozen base-parse observation pool — the parsed bullet ONLY. */
const OBSERVATIONS: readonly BulletObservation[] = [
  {
    text: PARSED_BULLET,
    id: bulletId(PARSED_BULLET, 0),
    index: 0,
    hasMetric: true,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: countWords(PARSED_BULLET),
  },
];

/** Run the exact `/` pipeline over the hook's current override state. */
function regrade(api: EditableParse): {
  score: AnonymousAtsScore;
  bulletTexts: string[];
  roleDescriptions: (string | undefined)[];
  /** Every bullet the Download PDF would draw, across all entries. */
  exportedBullets: string[];
  /** The rendered attribution: what each role's group holds, and what fell
   *  through to the "Other bullets" group (#660). `buildEntryGroups` reduces to
   *  this call with no projects/achievements in play. */
  groups: BulletGroup[];
} {
  const base = baseResult();
  const core = applyOverrides(
    {
      parsed: base.canonical.fields,
      rawText: base.rawText,
      sections: base.canonical.sections,
      observations: OBSERVATIONS,
      fieldConfidence: base.canonical.fieldConfidence,
    },
    {
      contactOverrides: api.contactOverrides,
      experienceOverrides: api.experienceOverrides,
      bulletOverrides: api.bulletOverrides,
      educationOverrides: api.educationOverrides,
      skillsOverride: api.skillsOverride,
      addedEntries: api.addedEntries,
      addedBullets: api.addedBullets,
      removedBullets: [...api.removedBullets],
      profileOverrides: api.profileOverrides,
      achievementOverrides: api.achievementOverrides,
      descriptionOverrides: api.descriptionOverrides,
      summaryOverride: api.summaryOverride,
    },
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
    roleDescriptions: core.fields.experience.map((e) => e.description),
    exportedBullets: model.sections.flatMap((s) =>
      s.entries.flatMap((e) => e.bullets),
    ),
    groups: groupBulletsByExperience(
      [...(score.bullets ?? [])],
      core.fields.experience,
    ),
  };
}

/** The texts the "Other bullets" group renders, or [] when it is absent. */
function otherBullets(api: EditableParse): string[] {
  const other = regrade(api).groups.find((g) => g.experienceIndex === null);
  return other?.bullets.map((b) => b.text) ?? [];
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

/** Add a role via "+ Add experience" and give it one bullet. Returns its id. */
function addRoleWithBullet(): string {
  let id = "";
  act(() => {
    id = api.addEntry("experience");
    api.setEntryField(id, "title", "Principal Engineer");
    api.setEntryField(id, "subtitle", "Cascadia Analytics");
  });
  act(() => api.addBullet(id, ADDED_BULLET));
  return id;
}

/** The added bullet's index in the RE-GRADED pool (never in OBSERVATIONS). */
function addedObsId(): string {
  const at = regrade(api).bulletTexts.indexOf(ADDED_BULLET);
  expect(at).toBeGreaterThanOrEqual(0);
  return regrade(api).score.bullets![at].id;
}

/** The PARSED bullet's own id — the one a wrongly-filed removal would hit. */
const PARSED_ID = bulletId(PARSED_BULLET, 0);
/** An id that names no line anywhere: the stand-in for the stale observation
 *  index these call sites used before #648. */
const STALE_ID = bulletId("no bullet reads like this", 0);

describe("removeBullet on a user-ADDED role (#637 half 1)", () => {
  it("drops the bullet from the pool, the score and the exported PDF", () => {
    const id = addRoleWithBullet();

    const before = regrade(api);
    expect(before.bulletTexts).toEqual([PARSED_BULLET, ADDED_BULLET]);
    expect(before.exportedBullets).toContain(ADDED_BULLET);

    const obsId = addedObsId();
    act(() => api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET }));

    const after = regrade(api);
    // 1. Gone from the rendered/graded bullet pool.
    expect(after.bulletTexts).toEqual([PARSED_BULLET]);
    // 2. Gone from the added role's own description (what the UI renders).
    expect(after.roleDescriptions[1]).toBeUndefined();
    // 3. Gone from the exported PDF model.
    expect(after.exportedBullets).not.toContain(ADDED_BULLET);
    expect(after.exportedBullets).toContain(PARSED_BULLET);
    // 4. The score actually moved — the whole point of "it stays in the score".
    expect(after.score.specificity).not.toEqual(before.score.specificity);
  });

  it("empties the bucket so the now-blank-bodied role is prunable", () => {
    const id = addRoleWithBullet();
    const obsId = addedObsId();

    act(() => api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET }));

    // The bucket is DELETED, not left as `{id: []}` — `hasEdits` and
    // `isAddedEntryEmpty` both key off its presence/length.
    expect(id in api.addedBullets).toBe(false);
  });

  it("restores the bullet through the captured undo", () => {
    const id = addRoleWithBullet();
    const obsId = addedObsId();

    // Exactly the capture-then-write order `useBulletRemoveStatus` performs.
    let undo = () => {};
    act(() => {
      undo = api.captureBulletUndo(
        batchUndoTargets([{ kind: "remove", obsId }], id),
      );
      api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET });
    });
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET]);

    act(() => undo());

    const restored = regrade(api);
    expect(restored.bulletTexts).toEqual([PARSED_BULLET, ADDED_BULLET]);
    expect(restored.exportedBullets).toContain(ADDED_BULLET);
    expect(api.addedBullets[id]).toEqual([ADDED_BULLET]);
  });

  it("removes each of two added bullets independently, in one tick", () => {
    const id = addRoleWithBullet();
    act(() => api.addBullet(id, "Mentored 6 engineers to promotion."));
    expect(api.addedBullets[id]).toHaveLength(2);

    // Both removes land in ONE act(), so the second reads the ref rather than
    // a committed render — the case a render closure would get wrong.
    act(() => {
      api.removeBullet(STALE_ID, { entryKey: id, text: ADDED_BULLET });
      api.removeBullet(bulletId("Mentored 6 engineers to promotion.", 0), {
        entryKey: id,
        text: "Mentored 6 engineers to promotion.",
      });
    });

    expect(id in api.addedBullets).toBe(false);
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET]);
    // Neither id leaked into the removal-keyed set.
    expect(api.removedBullets.size).toBe(0);
  });

  it("keeps an add made in the SAME tick as a splicing remove", () => {
    // The add-before-remove order `resolveSectionWrites` emits in ordinary pair
    // order, run synchronously by the rewrite-apply loops. A literal
    // `setAddedBullets(next)` in the remove path discards the add's queued
    // update, so `writeAddedBullets` must make the ref — not the committed
    // state — the base every writer composes on.
    const id = addRoleWithBullet();

    act(() => {
      api.addBullet(id, "Cut infra spend 22% by right-sizing clusters.");
      api.removeBullet(STALE_ID, { entryKey: id, text: ADDED_BULLET });
    });

    expect(api.addedBullets[id]).toEqual([
      "Cut infra spend 22% by right-sizing clusters.",
    ]);
    expect(regrade(api).bulletTexts).toEqual([
      PARSED_BULLET,
      "Cut infra spend 22% by right-sizing clusters.",
    ]);
  });

  it("keeps a CROSS-BUCKET add made in the same tick as a splicing remove", () => {
    // The whole-résumé rewrite path applies every section in one synchronous
    // loop, so the add and the remove routinely land on different entries.
    const a = addRoleWithBullet();
    let b = "";
    act(() => {
      b = api.addEntry("experience");
      api.setEntryField(b, "title", "Engineering Manager");
    });

    act(() => {
      api.addBullet(b, "Grew the platform team from 4 to 11.");
      api.removeBullet(STALE_ID, { entryKey: a, text: ADDED_BULLET });
    });

    expect(api.addedBullets[b]).toEqual(["Grew the platform team from 4 to 11."]);
    expect(a in api.addedBullets).toBe(false);
  });

  it("keeps a same-tick add against a PARSED role's bucket", () => {
    // Not confined to added entries: a parsed role's bucket is written by the
    // same pair of setters, so the clobber reached it too.
    act(() => api.addBullet("experience:0", ADDED_BULLET));

    act(() => {
      api.addBullet("experience:0", "Owned the migration to Postgres 16.");
      api.removeBullet(STALE_ID, { entryKey: "experience:0", text: ADDED_BULLET });
    });

    expect(api.addedBullets["experience:0"]).toEqual([
      "Owned the migration to Postgres 16.",
    ]);
    expect(api.removedBullets.size).toBe(0);
  });

  it("never files a removal under another bullet's id for an added entry", () => {
    const id = addRoleWithBullet();
    const obsId = addedObsId();

    act(() => api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET }));
    // A repeat click (the row is already gone) must NOT fall through: filing
    // the PARSED bullet's id there would remove an unrelated bullet.
    act(() => api.removeBullet(PARSED_ID, { entryKey: id, text: ADDED_BULLET }));

    expect(api.removedBullets.size).toBe(0);
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET]);
  });

  it("reports that repeat click as NOT recorded (#659)", () => {
    // The side effect above (nothing filed) is only half the contract. The
    // RESULT is the other half, and it is what `useBulletRemoveStatus` keys its
    // "Removed 1 change · Undo" strip off — and, through that strip's `pending`,
    // what holds the entry back from the section-exit prune. Flipping this
    // branch's `false` to `true` leaves every OTHER assertion in this file
    // green while re-arming both.
    const id = addRoleWithBullet();
    const obsId = addedObsId();

    let first = false;
    let second = false;
    act(() => {
      first = api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET });
    });
    act(() => {
      second = api.removeBullet(obsId, { entryKey: id, text: ADDED_BULLET });
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(api.removedBullets.size).toBe(0);
  });
});

describe("removeBullet still reaches PARSED bullets (#637 scoping)", () => {
  it("falls through to removedBullets for a parsed role's own bullet", () => {
    act(() =>
      api.removeBullet(PARSED_ID, {
        entryKey: "experience:0",
        text: PARSED_BULLET,
      }),
    );

    expect(api.removedBullets.has(PARSED_ID)).toBe(true);
    const after = regrade(api);
    expect(after.bulletTexts).toEqual([]);
    expect(after.exportedBullets).not.toContain(PARSED_BULLET);
  });

  it("removes an ADDED bullet on a PARSED role without touching its parsed one", () => {
    act(() => api.addBullet("experience:0", ADDED_BULLET));
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET, ADDED_BULLET]);

    act(() =>
      api.removeBullet(addedObsId(), {
        entryKey: "experience:0",
        text: ADDED_BULLET,
      }),
    );

    // Spliced from the bucket, NOT filed in `removedBullets` (the added
    // bullet's id names a line that only exists inside that bucket).
    expect(api.removedBullets.size).toBe(0);
    expect(regrade(api).bulletTexts).toEqual([PARSED_BULLET]);
  });

  it("still works with no ref at all (the 'Other bullets' call path)", () => {
    act(() => api.removeBullet(PARSED_ID));
    expect(api.removedBullets.has(PARSED_ID)).toBe(true);
    expect(regrade(api).bulletTexts).toEqual([]);
  });
});

/**
 * #660 half 1 — `addBullet` rejects a line carrying no CONTENT.
 *
 * Driven end-to-end for the same reason #637 was: the defect was not "the hook
 * stored something odd", it was that the stored line could not be ATTRIBUTED.
 * So each case folds the hook's state through the real `applyOverrides` →
 * `computeAnonymousAtsScore` → `groupBulletsByExperience` chain and asserts on
 * the group the row would render under, not on the bucket alone.
 *
 * `"1."` is the reachable reproducer, and the numeral is why: `extractBulletsFromLines`
 * drops a pooled line whose `countWords` is 0, so a lone `"•"` never became a
 * BulletObservation at all (it only polluted the description and the exported
 * PDF). `"1."` carries a `\p{N}`, so it counts as one word, pools, and surfaces
 * as a row under "Other bullets" whose Remove did nothing.
 */
describe("addBullet rejects a contentless line (#660 half 1)", () => {
  const MARKER_ONLY = ["•", "-", "*", "–", "·", "‣", "1.", "2)", "  •  "];
  /** A legitimate bullet that merely STARTS with a marker — AC 3's trap. */
  const MARKED_BULLET = "• Shipped X to 40 engineers.";

  it("stores none of them, on a PARSED role's bucket", () => {
    act(() => {
      for (const text of MARKER_ONLY) api.addBullet("experience:0", text);
    });

    expect(api.addedBullets).toEqual({});
    expect(api.hasEdits).toBe(false);
  });

  it("stores none of them, on an ADDED role's bucket", () => {
    let id = "";
    act(() => {
      id = api.addEntry("experience");
    });
    act(() => {
      for (const text of MARKER_ONLY) api.addBullet(id, text);
    });

    expect(id in api.addedBullets).toBe(false);
  });

  it("keeps the numbered-marker line out of the pool AND out of 'Other bullets'", () => {
    // The observable defect, asserted where the user sees it. Pre-fix this run
    // pooled a second bullet whose id was `"0|"` and put it in the null group.
    act(() => api.addBullet("experience:0", "1."));

    const after = regrade(api);
    expect(after.bulletTexts).toEqual([PARSED_BULLET]);
    expect(otherBullets(api)).toEqual([]);
    expect(after.groups.map((g) => g.experienceIndex)).toEqual([0]);
  });

  it("keeps a glyph-only line out of the description and the exported PDF", () => {
    // The half a pool assertion cannot see: a lone "•" was never pooled (0
    // words), so it rendered no row — but `applyAddedEntriesAndBullets` still
    // wrote it into the role's description, which IS what the PDF draws.
    act(() => api.addBullet("experience:0", "•"));

    const after = regrade(api);
    expect(after.roleDescriptions[0]).toBe(PARSED_BULLET);
    expect(after.exportedBullets).toEqual([PARSED_BULLET]);
  });

  it("still ACCEPTS a marker-prefixed line and matches it to its own role", () => {
    // The trap. `normalizeBulletText` strips one leading marker by design, so a
    // guard phrased as "starts with a marker" — or one that compared the RAW
    // text to a marker set — would reject every legitimately bulleted line a
    // user pastes in. Attribution is asserted too, not just storage: a guard
    // that let the line through but broke its key would strand it in "Other
    // bullets", which is the very state #660 is about.
    act(() => api.addBullet("experience:0", MARKED_BULLET));

    // Stored VERBATIM, glyph and all — `addBullet` normalises only to decide
    // whether to accept, never to rewrite. The pool copy keeps the glyph too:
    // `applyAddedBulletsToExistingEntries` prefixes its own `"• "`, and
    // `extractBulletsFromLines` strips exactly one marker back off.
    expect(api.addedBullets["experience:0"]).toEqual([MARKED_BULLET]);
    const after = regrade(api);
    expect(after.bulletTexts).toContain(MARKED_BULLET);
    expect(otherBullets(api)).toEqual([]);
    const role = after.groups.find((g) => g.experienceIndex === 0);
    expect(role?.bullets.map((b) => b.text)).toEqual([
      PARSED_BULLET,
      MARKED_BULLET,
    ]);
    expect(after.exportedBullets).toContain(MARKED_BULLET);
  });

  it("accepts a line whose only content is a numeral", () => {
    // `"2019"` looks as degenerate as `"1."` but is real text: the guard keys on
    // the normalised form, so a numeral that is not a list marker survives.
    act(() => api.addBullet("experience:0", "2019"));
    expect(api.addedBullets["experience:0"]).toEqual(["2019"]);
  });
});
