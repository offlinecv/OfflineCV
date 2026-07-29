// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression test for #637 half 2 — the section-exit prune used to unmount the
 * `RoleEntry` hosting a just-armed "Removed 1 change · Undo" strip.
 *
 * This repro is only REACHABLE once half 1 lands. Before it, removing a user-
 * added role's bullet never shrank `addedBullets`, so `isAddedEntryEmpty` stayed
 * false, so `pruneEmptyAddedEntries` never touched the role and the strip was
 * never at risk. The test therefore drives the REAL `useEditableParse` and the
 * REAL `applyOverrides` → `computeAnonymousAtsScore` → `groupBulletsByExperience`
 * chain: the entry becomes empty because the shipped code emptied it, not
 * because the harness staged it.
 *
 * The second case is what makes the hold PER ENTRY rather than per section: an
 * empty SIBLING added role with no live undo must still be dropped by the very
 * same prune pass that spares the held one.
 *
 * jsdom + raw `createRoot` + fake timers, matching `ExperienceSection.test.tsx`.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ExperienceSection } from "./ReconstructedResume.tsx";
import { useEditableParse, type EditableParse } from "../../hooks/useEditableParse.ts";
import { applyOverrides } from "../../lib/edit/apply-overrides.ts";
import { computeAnonymousAtsScore } from "../../lib/score/score.ts";
import { groupBulletsByExperience } from "../../lib/score/group-bullets.ts";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import { projectScoreSections } from "../../lib/heuristics/projections.ts";
import { buildBlankResult } from "../../lib/heuristics/empty-result.ts";
import { toCanonicalResume } from "../../lib/heuristics/canonical.ts";
import type { SectionedResume } from "../../lib/heuristics/sections.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { batchUndoTargets } from "../../lib/rewrite-review/undo-batch.ts";
import { UNDO_HOLD_MS } from "./ApplyConfirmation.tsx";

const PARSED_BULLET = "Cut p99 checkout latency by 38% via edge caching.";
const HELD_BULLET = "Shipped a design system used by 40 engineers.";

/**
 * One PARSED role, so the EXPERIENCE section pool is non-empty. That matters:
 * with an empty one, `computeAnonymousAtsScore`'s glyph-less fallback (#365)
 * re-pools every role DESCRIPTION, and an added bullet — which lives in both
 * the description and the appended pool lines — would be graded twice.
 */
function baseResult(): CascadeResult {
  const blank = buildBlankResult();
  const byName = new Map<string, readonly string[]>([
    ["experience", [`• ${PARSED_BULLET}`]],
  ]);
  const sections: SectionedResume = {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
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

/**
 * Mounts `ExperienceSection` over the real edit hook and the real re-grade
 * pipeline: one parsed role, plus whatever the test adds through "+ Add
 * experience". Only the ADDED ones can be pruned.
 */
function Harness() {
  const edit = useEditableParse();
  api = edit;

  const groups = useMemo<BulletGroup[]>(() => {
    const base = baseResult();
    const core = applyOverrides(
      base.canonical.fields,
      base.rawText,
      base.canonical.sections,
      edit.contactOverrides,
      edit.experienceOverrides,
      edit.bulletOverrides,
      [],
      edit.educationOverrides,
      edit.skillsOverride,
      edit.addedEntries,
      edit.addedBullets,
      edit.removedBullets,
      edit.profileOverrides,
      base.canonical.fieldConfidence,
      edit.achievementOverrides,
      edit.descriptionOverrides,
      edit.summaryOverride,
    );
    const score = computeAnonymousAtsScore({
      parsed: core.fields,
      fieldConfidence: core.fieldConfidence,
      triggers: base.triggers,
      rawText: core.rawText,
      sections: projectScoreSections(core),
    });
    const experiences = core.fields.experience;
    const byIndex = new Map(
      groupBulletsByExperience([...(score.bullets ?? [])], experiences)
        .filter((g) => g.experienceIndex !== null)
        .map((g) => [g.experienceIndex, g] as const),
    );
    // `buildEntryGroups`' `sliceGroups` fallback: every entry renders, even
    // with zero matched bullets.
    return experiences.map(
      (exp, i) =>
        byIndex.get(i) ?? { experienceIndex: i, experience: exp, bullets: [] },
    );
  }, [edit]);

  return createElement(ExperienceSection, {
    groups,
    resumeSections: [],
    // false → no ModelSelector / rewrite CTA chrome in the test DOM.
    hasBullets: false,
    experienceOverrides: {},
    onExperienceFieldChange: () => {},
    bulletOverrides: edit.bulletOverrides,
    onBulletChange: edit.setBulletField,
    onRemoveBullet: edit.removeBullet,
    addedExperience: edit.addedEntries.filter((e) => e.section === "experience"),
    // Index 0 is the parsed role; indices 1+ are the user-added ones.
    originalCount: 1,
    onAddEntry: () => edit.addEntry("experience"),
    onRemoveEntry: edit.removeEntry,
    onEntryField: edit.setEntryField,
    onAddBullet: edit.addBullet,
    captureBulletUndo: edit.captureBulletUndo,
    summaryApply: {
      obsIndices: [],
      onReplace: () => {},
      onRemove: () => {},
      onAdd: () => {},
    },
    onPruneEmpty: (isHeld) => edit.pruneEmptyAddedEntries("experience", isHeld),
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Harness));
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

/** The real section-exit blur (#379): focus leaves the section entirely, then
 *  the deferred prune fires one macrotask later. */
async function exitSection(el: HTMLDivElement) {
  const section = el.querySelector("section")!;
  await act(async () => {
    section.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
    );
  });
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
}

function removeBulletButtons(el: HTMLDivElement): HTMLButtonElement[] {
  return Array.from(
    el.querySelectorAll<HTMLButtonElement>('[aria-label="Remove bullet"]'),
  );
}

const UNDO_LABEL = "Undo the changes just applied to the résumé";

/**
 * Two blank-header added roles; the first gets a bullet. Blank headers are
 * load-bearing: `isAddedEntryEmpty` is `headerEmpty && no bullets`, so a role
 * with a typed title is never prunable and a test built on one would pass with
 * the hold ripped out. Here the bullet is the ONLY thing keeping `held` alive,
 * and removing it hands the entry straight to the prune.
 */
function seedRoles(): { held: string; sibling: string } {
  let held = "";
  let sibling = "";
  act(() => {
    held = api.addEntry("experience");
    sibling = api.addEntry("experience");
  });
  act(() => api.addBullet(held, HELD_BULLET));
  return { held, sibling };
}

describe("ExperienceSection — the prune must not eat a live undo (#637 half 2)", () => {
  it("keeps the added role and its Undo strip alive across the prune tick", async () => {
    const el = await render();
    seedRoles();
    await act(async () => {});

    expect(el.textContent).toContain(HELD_BULLET);
    // The parsed role's bullet, then the added role's.
    const buttons = removeBulletButtons(el);
    expect(buttons).toHaveLength(2);

    // Blank-commit's destination: the per-bullet remove.
    await click(buttons[1]!);
    expect(el.textContent).toContain("Removed 1 change");

    // The role is NOW genuinely empty — half 1 emptied its bucket — so the
    // prune would drop it and take the strip with it.
    expect(api.addedBullets).toEqual({});
    expect(el.textContent).not.toContain(HELD_BULLET);

    await exitSection(el);

    expect(el.textContent).toContain("Removed 1 change");
    expect(el.querySelector(`[aria-label="${UNDO_LABEL}"]`)).not.toBeNull();
  });

  it("that surviving Undo still works after the prune tick", async () => {
    const el = await render();
    const { held } = seedRoles();
    await act(async () => {});

    await click(removeBulletButtons(el)[1]!);
    await exitSection(el);

    await click(el.querySelector<HTMLElement>(`[aria-label="${UNDO_LABEL}"]`)!);

    expect(el.textContent).toContain(HELD_BULLET);
    expect(el.textContent).toContain("Reverted 1 change");
    expect(removeBulletButtons(el)).toHaveLength(2);
    expect(api.addedBullets[held]).toEqual([HELD_BULLET]);
  });

  it("still drops an empty SIBLING added role in the same prune pass", async () => {
    const el = await render();
    const { held, sibling } = seedRoles();
    await act(async () => {});
    expect(api.addedEntries.map((e) => e.id)).toEqual([held, sibling]);

    await click(removeBulletButtons(el)[1]!);
    await exitSection(el);

    // Per-entry, not per-section: the held role survives, its blank sibling
    // — which has no live undo to protect — does not.
    expect(api.addedEntries.map((e) => e.id)).toEqual([held]);
  });

  it("prunes the held role once its strip is gone and focus leaves again", async () => {
    const el = await render();
    const { held } = seedRoles();
    await act(async () => {});

    await click(removeBulletButtons(el)[1]!);
    await exitSection(el);
    expect(api.addedEntries.map((e) => e.id)).toContain(held);

    // The hold is a lease on the LIVE strip, not a permanent exemption: once
    // the confirmation collapses, the next section exit drops the ghost.
    // Two advances, not one: `ApplyConfirmation` chains hold → collapsing →
    // exit, and the exit timer is not SCHEDULED until the effect reacting to
    // `collapsing` runs, so a single advance would never reach `onCollapse`.
    await act(async () => {
      vi.advanceTimersByTime(UNDO_HOLD_MS);
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(el.textContent).not.toContain("Removed 1 change");

    await exitSection(el);

    expect(api.addedEntries).toHaveLength(0);
  });
});

describe("useEditableParse.pruneEmptyAddedEntries — isHeld (#637 half 2)", () => {
  it("spares only the held id, and keeps identity when it spares everything", async () => {
    await render();
    let a = "";
    let b = "";
    act(() => {
      a = api.addEntry("experience");
      b = api.addEntry("experience");
    });
    // Flush the WebGPU-capability probe each freshly-mounted RoleEntry kicks
    // off, so its setState lands inside act().
    await act(async () => {});
    const before = api.addedEntries;

    act(() => api.pruneEmptyAddedEntries("experience", (id) => id === a || id === b));
    expect(api.addedEntries).toBe(before);

    act(() => api.pruneEmptyAddedEntries("experience", (id) => id === a));
    expect(api.addedEntries.map((e) => e.id)).toEqual([a]);
    expect(b).not.toBe(a);
  });

  it("prunes everything empty when no hold is supplied (#379 unchanged)", async () => {
    await render();
    act(() => {
      api.addEntry("experience");
      api.addEntry("experience");
    });
    await act(async () => {});
    act(() => api.pruneEmptyAddedEntries("experience"));
    expect(api.addedEntries).toHaveLength(0);
  });
});

describe("batchUndoTargets records the bucket for a remove (#637 half 1)", () => {
  it("carries addedEntryKey for a remove-only batch", () => {
    expect(
      batchUndoTargets([{ kind: "remove", obsIndex: 3 }], "added:7"),
    ).toEqual({ replaced: [], removed: [3], addedEntryKey: "added:7" });
  });

  it("still omits it for a replace-only batch", () => {
    expect(
      batchUndoTargets([{ kind: "replace", obsIndex: 3, text: "x" }], "added:7"),
    ).toEqual({ replaced: [3], removed: [] });
  });
});
