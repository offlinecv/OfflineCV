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
 * The #659 block at the end reuses this harness for the inverse of half 2: a
 * removal that did NOTHING must not arm a strip, because that strip would both
 * lie to the user and hold its entry back from this same prune. The harness is
 * what makes that repro honest — a double-click reaches `removeBullet`'s
 * `isAddedEntryKey` early return through the shipped ref-write ordering, with
 * nothing staged. The strip's own contract is pinned in `BulletRemoveStatus.test.tsx`.
 *
 * jsdom + raw `createRoot` + fake timers, matching `ExperienceSection.test.tsx`.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { bulletId } from "../../lib/score/bullet-id.ts";
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
// The two recipes that are easy to get silently wrong (see that module), shared
// with `ExperienceSection.other-bullets.test.tsx` rather than copied a third time.
import {
  UNDO_LABEL,
  collapseStrip,
  exitSection,
} from "./__test-utils__/experience-section-dom.ts";

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
    onBulletChange: edit.setBulletField,
    onRemoveBullet: edit.removeBullet,
    addedBullets: edit.addedBullets,
    addedExperience: edit.addedEntries.filter((e) => e.section === "experience"),
    // Index 0 is the parsed role; indices 1+ are the user-added ones.
    originalCount: 1,
    // Identity: no parsed entry is deleted here, so a render position IS its
    // parsed index (#856).
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

/**
 * Two clicks on the same control inside ONE `act`, i.e. a double-click. React
 * batches both updates to the end of the act scope, so the second handler runs
 * against the same render as the first — but `writeAddedBullets` assigns its ref
 * synchronously, so the second call finds the bucket line already spliced.
 *
 * That is how the `isAddedEntryKey` early return (#637) is reached from the UI
 * without staging anything: shipped code produces the no-op.
 */
async function doubleClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
}

/**
 * Type into a controlled field the way a user does. React's value tracker
 * swallows a direct `el.value = x` — no `onChange` fires, so the draft the test
 * thinks it typed is not the draft the component holds, and the test passes for
 * the wrong reason. Write through the prototype's native setter instead.
 *
 * Serves both draft-bearing controls in a `RoleEntry` — a `multiline`
 * `EditableField`'s `<textarea>` and an expanded `InlineBulletAdd`'s `<input>` —
 * because the tracker sits on the element's OWN prototype, so the setter has to
 * come from the matching one.
 */
async function type(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setValue.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * One stray click somewhere else on the page: focus leaves the control, landing
 * on `<body>`. Nothing else about the row changes — a `multiline`
 * `EditableField` does not commit on blur, and an expanded `InlineBulletAdd`
 * with text in it does not collapse, so the DRAFT is still on screen afterwards.
 */
async function blur(el: HTMLElement) {
  await act(async () => {
    el.blur();
  });
}

function removeBulletButtons(el: HTMLDivElement): HTMLButtonElement[] {
  return Array.from(
    el.querySelectorAll<HTMLButtonElement>('[aria-label="Remove bullet"]'),
  );
}

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

  it("prunes the held role the moment its strip collapses (#658)", async () => {
    const el = await render();
    const { held } = seedRoles();
    await act(async () => {});

    await click(removeBulletButtons(el)[1]!);
    await exitSection(el);
    // Spared while the strip is live — #637 half 2, unchanged.
    expect(api.addedEntries.map((e) => e.id)).toEqual([held]);

    // The hold is a lease on the LIVE strip, not a permanent exemption. Before
    // #658 the lease lapsing was inert — nothing called the prune again, so this
    // ghost sat in the list, the score and the exported PDF until the user
    // re-entered and re-exited the section. Now the release re-runs it, and this
    // test used to need a second `exitSection` right here to go green.
    await collapseStrip();

    expect(el.textContent).not.toContain("Removed 1 change");
    expect(api.addedEntries).toHaveLength(0);
    // Nothing in this test focuses anything, which is what lets the release
    // prune fire at all. The typing case below is the other half.
    expect(document.activeElement).toBe(document.body);
  });
});

describe("ExperienceSection — a collapsing strip re-runs the prune (#658)", () => {
  it("needs no section exit, and leaves a blank sibling to the one that follows", async () => {
    const el = await render();
    const { held, sibling } = seedRoles();
    await act(async () => {});

    // No blur anywhere in this test: the removal alone arms the strip, and the
    // strip's own timer is the trigger.
    await click(removeBulletButtons(el)[1]!);
    await collapseStrip();

    // Narrowed on purpose. The pass is section-wide, so an unnarrowed sweep off
    // a timer could drop the blank sibling — and a blank added role is also
    // exactly what one the user just opened with "+ Add experience" looks like,
    // since a header field's draft commits only on an explicit Save. The
    // section-exit pass still takes it (#379, #637's sibling criterion): that
    // one only ever fires with focus outside the whole section.
    expect(api.addedEntries.map((e) => e.id)).toEqual([sibling]);
    expect(sibling).not.toBe(held);

    await exitSection(el);
    expect(api.addedEntries).toHaveLength(0);
  });

  it("keeps an entry whose Undo put its bullet back", async () => {
    const el = await render();
    const { held } = seedRoles();
    await act(async () => {});

    await click(removeBulletButtons(el)[1]!);
    await click(el.querySelector<HTMLElement>(`[aria-label="${UNDO_LABEL}"]`)!);
    expect(api.addedBullets[held]).toEqual([HELD_BULLET]);

    // The "Reverted" strip holds the entry as well, and collapses in its turn —
    // so this release runs the prune over an entry that is no longer empty. The
    // release path never decides emptiness itself; `pruneEmptyAddedEntries` does,
    // inside its own state updater, which is the only reader that cannot be
    // holding a stale bucket.
    await collapseStrip();

    expect(api.addedEntries.map((e) => e.id)).toContain(held);
    expect(el.textContent).toContain(HELD_BULLET);
  });

  it("stands down while the user is typing in the entry, and the next section exit still gets it", async () => {
    const el = await render();
    const { held } = seedRoles();
    await act(async () => {});

    await click(removeBulletButtons(el)[1]!);

    // Enter edit mode on the held role's own blank title. Both added roles offer
    // one and the held role is the first added entry, so the first "Add Job
    // title" in document order is its own — the PARSED role has a title, so its
    // affordance reads "Edit Job title" and is not in this list.
    const titles = el.querySelectorAll<HTMLElement>(
      '[aria-label="Add Job title"]',
    );
    expect(titles).toHaveLength(2);
    await click(titles[0]!);

    const draft = el.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Job title"]',
    )!;
    // Real focus, via the rAF `EditableField.startEdit` schedules (the `click`
    // helper advances it). The gate reads `activeElement` containment, so if
    // this line were a no-op the test would pass with the gate deleted.
    expect(document.activeElement).toBe(draft);

    await type(draft, "Staff Engineer");
    // Uncommitted, and that is the point: a MULTILINE EditableField commits only
    // on an explicit Save, so the entry still reads as empty to
    // `isAddedEntryEmpty` — which is how the mid-keystroke yank #637 rejected
    // this fix over stays reachable.
    expect(api.addedEntries.find((e) => e.id === held)?.title).toBe("");

    await collapseStrip();

    // AC 4: the row is still there, with the draft and the caret still in it.
    expect(el.textContent).not.toContain("Removed 1 change");
    expect(api.addedEntries.map((e) => e.id)).toContain(held);
    expect(draft.value).toBe("Staff Engineer");
    expect(document.activeElement).toBe(draft);

    // And the lease really did lapse: the entry is no longer HELD, so the
    // section-exit pass drops it — that pass runs with focus outside the whole
    // section by definition, so it never faces this question. This is the
    // guarantee the reworded #637 test above used to carry.
    await exitSection(el);
    expect(api.addedEntries).toHaveLength(0);
  });

  it("stands down for a header draft the user blurred without saving", async () => {
    // The case a focus-only gate lost. `EditableField` keeps a MULTILINE draft
    // across a blur on purpose ("a multi-line paste that accidentally defocuses
    // shouldn't lose the draft"), so the draft outlives the focus the gate was
    // keyed to: one stray click elsewhere on the page and the entry read as
    // unfocused AND empty, so the release prune unmounted the row with the typed
    // title still in it. No section exit, no user action at the moment of loss.
    const el = await render();
    const { held } = seedRoles();
    await act(async () => {});

    await click(removeBulletButtons(el)[1]!);

    const titles = el.querySelectorAll<HTMLElement>(
      '[aria-label="Add Job title"]',
    );
    expect(titles).toHaveLength(2);
    await click(titles[0]!);

    const draft = el.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Job title"]',
    )!;
    expect(document.activeElement).toBe(draft);
    await type(draft, "Staff Engineer");

    await blur(draft);
    // The two facts that together make the row indistinguishable from a ghost to
    // a focus-only gate: focus is gone, and the draft never committed.
    expect(document.activeElement).toBe(document.body);
    expect(api.addedEntries.find((e) => e.id === held)?.title).toBe("");
    // Blur is not Cancel — the textarea (and the text in it) is still mounted.
    expect(draft.value).toBe("Staff Engineer");

    await collapseStrip();

    // The strip really did run its course, so the release fired and the gate is
    // what spared the row.
    expect(el.textContent).not.toContain("Removed 1 change");
    expect(api.addedEntries.map((e) => e.id)).toContain(held);
    // The SAME textarea node, still in the tree, with the draft intact — not a
    // remounted empty one.
    expect(el.contains(draft)).toBe(true);
    expect(draft.value).toBe("Staff Engineer");
  });

  it("stands down for a blurred '+ Add bullet' draft in the entry", async () => {
    // The other draft-bearing control, and the other element type: an expanded
    // `InlineBulletAdd` with text in it does not collapse on blur either (its
    // handler collapses only an EMPTY draft), so the same loss was reachable
    // through the affordance the emptied role is showing the user.
    const el = await render();
    const { held } = seedRoles();
    await act(async () => {});

    await click(removeBulletButtons(el)[1]!);

    // Pills in document order: the parsed role, the held role, its sibling.
    const pills = el.querySelectorAll<HTMLElement>(
      'button[aria-label="Add bullet"]',
    );
    expect(pills).toHaveLength(3);
    await click(pills[1]!);

    const draft = el.querySelector<HTMLInputElement>(
      'input[aria-label="Add bullet"]',
    )!;
    expect(document.activeElement).toBe(draft);
    await type(draft, "Grew ARR 30% in two quarters");

    await blur(draft);
    expect(document.activeElement).toBe(document.body);
    // Never committed, so the bucket is still empty and the entry still prunable.
    expect(api.addedBullets).toEqual({});
    expect(draft.value).toBe("Grew ARR 30% in two quarters");

    await collapseStrip();

    expect(el.textContent).not.toContain("Removed 1 change");
    expect(api.addedEntries.map((e) => e.id)).toContain(held);
    expect(el.contains(draft)).toBe(true);
    expect(draft.value).toBe("Grew ARR 30% in two quarters");
  });
});

describe("ExperienceSection — a no-op removal must not re-arm the strip (#659)", () => {
  it("keeps the first write's undo when a double-click's second write does nothing", async () => {
    const el = await render();
    const { held } = seedRoles();
    await act(async () => {});

    // One user gesture, two handler runs. The first splices the bucket; the
    // second finds nothing left and reports `false`.
    await doubleClick(removeBulletButtons(el)[1]!);

    expect(api.addedBullets).toEqual({});
    expect(el.textContent).toContain("Removed 1 change");

    await click(el.querySelector<HTMLElement>(`[aria-label="${UNDO_LABEL}"]`)!);

    // The armed Undo has to be the one snapshotted BEFORE the removal that
    // landed. An ungated second `setStatus` replaces it with a snapshot taken
    // after — `captureBulletUndoSnapshot` reads the bucket as it is then (now
    // empty) and filters an already-removed id out of `restore` — so the button
    // stays mounted, stays clickable, and restores nothing.
    expect(el.textContent).toContain(HELD_BULLET);
    expect(api.addedBullets[held]).toEqual([HELD_BULLET]);
    expect(el.textContent).toContain("Reverted 1 change");
  });

  it("prunes the entry once that strip collapses, exactly as one real removal does", async () => {
    const el = await render();
    const { held } = seedRoles();
    await act(async () => {});

    await doubleClick(removeBulletButtons(el)[1]!);
    // One hold, taken by the write that landed — not two, and not one per click.
    await exitSection(el);
    expect(api.addedEntries.map((e) => e.id)).toEqual([held]);

    await collapseStrip();

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

describe("batchUndoTargets records the bucket for every write (#637, #657)", () => {
  const ID = bulletId("Shipped the thing", 0);

  it("carries addedEntryKey for a remove-only batch", () => {
    expect(batchUndoTargets([{ kind: "remove", obsId: ID }], "added:7")).toEqual(
      { replaced: [], removed: [ID], addedEntryKey: "added:7" },
    );
  });

  it("carries it for a replace-only batch too, since #657", () => {
    // A replace on a user-ADDED bullet rewrites its line inside the bucket
    // (`replaceAddedBulletLine`), not in the override map, so the bucket is the
    // only slot an undo can restore it from.
    expect(
      batchUndoTargets([{ kind: "replace", obsId: ID, text: "x" }], "added:7"),
    ).toEqual({ replaced: [ID], removed: [], addedEntryKey: "added:7" });
  });
});
