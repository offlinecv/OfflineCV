// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * ExperienceSection — the "Other bullets" bucket's export-fidelity affordance
 * (#1007): every row carries a "Not in Download PDF" mark, and a "Move to…"
 * menu reattaches it to a real entry via the SAME `addBullet` + `removeBullet`
 * seam `useOtherBulletsRemove` already drives for plain removal.
 *
 * Harness shape mirrors `ExperienceSection.other-bullets.test.tsx`: the section
 * renders over the REAL `useEditableParse` → `applyOverrides` →
 * `computeAnonymousAtsScore` → `groupBulletsByExperience` chain, so a moved
 * bullet re-groups for real rather than being asserted by hand.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ExperienceSection } from "./ReconstructedResume.tsx";
import {
  useEditableParse,
  type EditableParse,
} from "../../hooks/useEditableParse.ts";
import { applyOverrides } from "../../lib/edit/apply-overrides.ts";
import { computeAnonymousAtsScore } from "../../lib/score/score.ts";
import {
  groupBulletsByExperience,
  type BulletGroup,
} from "../../lib/score/group-bullets.ts";
import type { MoveTarget } from "../../lib/edit/move-targets.ts";
import { bulletId } from "../../lib/score/bullet-id.ts";
import { projectScoreSections } from "../../lib/heuristics/projections.ts";
import { buildBlankResult } from "../../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../../lib/heuristics/sections.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { UNDO_LABEL } from "./__test-utils__/experience-section-dom.ts";

const PARSED_BULLET = "Cut p99 checkout latency by 38% via edge caching.";
/** Pooled from the section but absent from every description → "Other". */
const ORPHAN_BULLET = "Presented quarterly reviews to the exec staff.";

const ROLE_LABEL = "Staff Engineer — Northwind Systems";
const MOVE_TARGETS: MoveTarget[] = [
  { key: "experience:0", section: "experience", label: ROLE_LABEL },
];

/** One parsed role (PARSED_BULLET) plus one pooled line no description claims
 *  (ORPHAN_BULLET) — the same shape `ExperienceSection.other-bullets.test.tsx`
 *  builds, without the degenerate-line machinery that suite's own defect needs. */
function baseResult(): CascadeResult {
  const blank = buildBlankResult();
  const lines = [`• ${PARSED_BULLET}`, `• ${ORPHAN_BULLET}`];
  const byName = new Map<string, readonly string[]>([["experience", lines]]);
  const sections: SectionedResume = {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
  return {
    ...blank,
    rawText: lines.join("\n"),
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
            description: PARSED_BULLET,
          },
        ],
      },
      sections,
      {},
    ),
  };
}

let api: EditableParse;

/** `moveTargets` is the one thing the two describe blocks below vary — every
 *  other prop is the fixed shape `ExperienceSection.other-bullets.test.tsx`
 *  already established for this same one-role-plus-orphan fixture. */
function Harness({ moveTargets }: { moveTargets?: readonly MoveTarget[] }) {
  const edit = useEditableParse();
  api = edit;

  const groups = useMemo<BulletGroup[]>(() => {
    const base = baseResult();
    const core = applyOverrides(
      {
        parsed: base.canonical.fields,
        rawText: base.rawText,
        sections: base.canonical.sections,
        observations: [],
        fieldConfidence: base.canonical.fieldConfidence,
      },
      edit.snapshot,
    );
    const score = computeAnonymousAtsScore({
      parsed: core.fields,
      fieldConfidence: core.fieldConfidence,
      triggers: base.triggers,
      rawText: core.rawText,
      sections: projectScoreSections(core),
    });
    const experiences = core.fields.experience;
    const grouped = groupBulletsByExperience(
      [...(score.bullets ?? [])],
      experiences,
    );
    const byIndex = new Map(
      grouped
        .filter((g) => g.experienceIndex !== null)
        .map((g) => [g.experienceIndex, g] as const),
    );
    const other = grouped.find((g) => g.experienceIndex === null);
    const roles = experiences.map(
      (exp, i) =>
        byIndex.get(i) ?? { experienceIndex: i, experience: exp, bullets: [] },
    );
    return other ? [...roles, other] : roles;
  }, [edit]);

  return createElement(ExperienceSection, {
    groups,
    resumeSections: [],
    hasBullets: false,
    experienceOverrides: {},
    onExperienceFieldChange: () => {},
    onBulletChange: edit.setBulletField,
    onRemoveBullet: edit.removeBullet,
    addedBullets: edit.addedBullets,
    addedExperience: edit.addedEntries.filter((e) => e.section === "experience"),
    originalCount: 1,
    parsedIndices: [0],
    onAddEntry: () => edit.addEntry("experience"),
    onRemoveEntry: edit.removeEntry,
    onEntryField: edit.setEntryField,
    onAddBullet: edit.addBullet,
    captureBulletUndo: edit.captureBulletUndo,
    summaryApply: {
      obsIds: [],
      onReplace: () => {},
      onRemove: () => {},
      onAdd: () => {},
    },
    onPruneEmpty: (isHeld) => edit.pruneEmptyAddedEntries("experience", isHeld),
    moveTargets,
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(
  moveTargets: readonly MoveTarget[] = MOVE_TARGETS,
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Harness, { moveTargets }));
  });
  await act(async () => {});
  return container;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
}

/** The ONE row rendering `text`. */
function rowFor(el: HTMLDivElement, text: string): HTMLLIElement {
  const rows = Array.from(el.querySelectorAll("li")).filter((li) =>
    li.textContent?.includes(text),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Open the "Move to…" menu on the row rendering `text`, then click the item
 *  labelled `target`. */
async function moveTo(el: HTMLDivElement, text: string, target: string) {
  const trigger = rowFor(el, text).querySelector<HTMLButtonElement>(
    '[aria-label="Move this bullet to an entry"]',
  );
  expect(trigger).not.toBeNull();
  await click(trigger!);
  const items = Array.from(
    el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  );
  const item = items.find((b) => b.textContent?.includes(target));
  expect(item).toBeTruthy();
  await click(item!);
}

describe("ExperienceSection — 'Other bullets' export-fidelity mark (#1007)", () => {
  it("marks every Other row 'Not in Download PDF'", async () => {
    const el = await render();
    const row = rowFor(el, ORPHAN_BULLET);
    expect(row.textContent).toContain("Not in Download PDF");
    // A real role's own bullet carries no such mark — it already exports.
    const parsedRow = rowFor(el, PARSED_BULLET);
    expect(parsedRow.textContent).not.toContain("Not in Download PDF");
  });

  it("omits the 'Move to…' menu when there is nowhere to move a bullet", async () => {
    // No candidate targets at all — the shape `ExperienceSection`'s own
    // `moveTargets = []` default produces for every caller that predates #1007.
    const el = await render([]);

    const row = rowFor(el, ORPHAN_BULLET);
    expect(row.textContent).toContain("Not in Download PDF");
    expect(
      row.querySelector('[aria-label="Move this bullet to an entry"]'),
    ).toBeNull();
  });
});

describe("ExperienceSection — 'Other bullets' one-way move note (#1007)", () => {
  const NOTE = "can't be edited on its own once Undo closes";

  async function openMenu(targets: readonly MoveTarget[]) {
    const el = await render(targets);
    const trigger = rowFor(el, ORPHAN_BULLET).querySelector<HTMLButtonElement>(
      '[aria-label="Move this bullet to an entry"]',
    );
    await click(trigger!);
    return el;
  }

  it("says so when the menu offers a target outside Experience", async () => {
    const el = await openMenu([
      ...MOVE_TARGETS,
      { key: "projects:0", section: "projects", label: "Trail Mapper" },
    ]);
    expect(el.textContent).toContain(NOTE);
  });

  it("stays quiet when every target is an Experience role", async () => {
    const el = await openMenu(MOVE_TARGETS);
    expect(el.textContent).not.toContain(NOTE);
  });
});

describe("ExperienceSection — 'Other bullets' Move to role (#1007)", () => {
  it("adds the bullet to the picked role's bucket and drops it from Other", async () => {
    const el = await render();
    expect(el.textContent).toContain("Other bullets");

    await moveTo(el, ORPHAN_BULLET, ROLE_LABEL);

    // Spliced into the target's bucket…
    expect(api.addedBullets).toEqual({ "experience:0": [ORPHAN_BULLET] });
    // …and the ORIGINAL observation is gone by id — it was a genuinely
    // unmatched PARSED bullet, in no bucket of its own, so the removal half
    // takes the same id-keyed path a plain Other-bullets Remove would.
    expect(api.removedBullets.has(bulletId(ORPHAN_BULLET, 0))).toBe(true);
    // No more "Other bullets" bucket — its one bullet just moved out.
    expect(el.textContent).not.toContain("Other bullets");
    // The text re-appears as an ordinary bullet under the role it was moved
    // to, re-grouped for real by `groupBulletsByExperience` off the entry's
    // now-extended description — not asserted by hand.
    expect(el.textContent).toContain(ORPHAN_BULLET);
    expect(el.textContent).toContain(`Moved 1 change — ${ROLE_LABEL}`);
  });

  it("Undo restores the original bullet and clears the target's bucket", async () => {
    const el = await render();
    await moveTo(el, ORPHAN_BULLET, ROLE_LABEL);

    const undo = el.querySelector<HTMLElement>(`[aria-label="${UNDO_LABEL}"]`);
    expect(undo).not.toBeNull();
    await click(undo!);

    expect(api.addedBullets).toEqual({});
    expect(api.removedBullets.size).toBe(0);
    expect(el.textContent).toContain("Other bullets");
    expect(el.textContent).toContain("Reverted 1 change");
    // Back in the bucket it started in, not left duplicated in both.
    expect(rowFor(el, ORPHAN_BULLET).textContent).toContain(
      "Not in Download PDF",
    );
  });
});
