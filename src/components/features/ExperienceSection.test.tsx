// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression test for the "Other bullets" bucket's remove-undo path (#626).
 *
 * `groupBulletsByExperience` appends the `experienceIndex === null` group only
 * `if (other && other.length > 0)`, so removing that bucket's LAST bullet drops
 * the group from the render list and unmounts its `RoleEntry` in the same render
 * that performs the removal. While the confirmation strip lived inside
 * `RoleEntry`, it died with it — the remove was undoable by nothing, on the one
 * path #626 newly created. A parsed role never hits this: it keeps rendering
 * with an empty bullet list.
 *
 * The harness re-grades the pool the way App does (drop the removed bullet, then
 * regroup through the REAL `groupBulletsByExperience`), so the group's
 * disappearance is produced by the shipped grouping rule rather than staged.
 *
 * Runs in jsdom with raw `createRoot`, matching `ResumeBulletRow.test.tsx`.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { createElement, useCallback, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ExperienceSection } from "./ReconstructedResume.tsx";
import { groupBulletsByExperience } from "../../lib/score/group-bullets.ts";
import type { BulletExperience } from "../../lib/score/group-bullets.ts";
import type { BulletObservation } from "../../lib/score/score.ts";

function bullet(index: number, text: string): BulletObservation {
  return {
    text,
    index,
    hasMetric: true,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: 9,
  };
}

/** One parsed role whose `description` matches BULLETS[0] — so BULLETS[1] is
 *  unmatched and lands in the "Other bullets" bucket. */
const MATCHED = "Cut p99 checkout latency by 38% via edge caching.";
const UNMATCHED = "Ran the weekly incident review for 12 on-call engineers.";

const EXPERIENCES: BulletExperience[] = [
  { title: "Staff Engineer", company: "Acme", description: MATCHED },
];

const POOL = [bullet(0, MATCHED), bullet(1, UNMATCHED)];

/**
 * Mounts `ExperienceSection` over live pool state. `onRemoveBullet` drops the
 * bullet from the pool, which regroups and (for the last unmatched bullet)
 * removes the "Other" group entirely on the next render.
 */
function Harness() {
  const [removed, setRemoved] = useState<readonly number[]>([]);
  const groups = useMemo(() => {
    const grouped = groupBulletsByExperience(
      POOL.filter((b) => !removed.includes(b.index)),
      EXPERIENCES,
    );
    const byIndex = new Map(
      grouped
        .filter((g) => g.experienceIndex !== null)
        .map((g) => [g.experienceIndex, g] as const),
    );
    const other = grouped.find((g) => g.experienceIndex === null);
    // `buildEntryGroups`' `sliceGroups` fallback, reproduced: every PARSED role
    // renders even with zero bullets — which is exactly why a parsed role can
    // host its own strip and the "Other" bucket cannot.
    const withFallback = EXPERIENCES.map(
      (exp, i) =>
        byIndex.get(i) ?? { experienceIndex: i, experience: exp, bullets: [] },
    );
    return other ? [...withFallback, other] : withFallback;
  }, [removed]);
  const onRemoveBullet = useCallback(
    (index: number) => setRemoved((prev) => [...prev, index]),
    [],
  );
  const restore = useCallback(
    () => () => setRemoved([]),
    [],
  );
  return createElement(ExperienceSection, {
    groups,
    resumeSections: [],
    // false → no ModelSelector / rewrite CTA chrome in the test DOM.
    hasBullets: false,
    experienceOverrides: {},
    onExperienceFieldChange: () => {},
    bulletOverrides: {},
    onBulletChange: () => {},
    onRemoveBullet,
    addedExperience: [],
    originalCount: EXPERIENCES.length,
    onAddEntry: () => {},
    onRemoveEntry: () => {},
    onEntryField: () => {},
    onAddBullet: () => {},
    // Stand-in for `useEditableParse.captureBulletUndo`: returns a thunk that
    // restores the pool, which is all the strip needs to offer a real Undo.
    captureBulletUndo: restore,
    summaryApply: {
      obsIndices: [],
      onReplace: () => {},
      onRemove: () => {},
      onAdd: () => {},
    },
    onPruneEmpty: () => {},
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
  // Flush the WebGPU-capability probes `useSectionRewrite` /
  // `useResumeRewriteUi` kick off on mount, so their setState lands inside
  // act() rather than after the test ends.
  await act(async () => {});
  return container;
}

// Fake timers so the strip's enter-rAF and its hold/exit timers never fire on
// their own — matching `ApplyConfirmation.test.tsx`. Nothing here asserts on
// the animation; every assertion is about what is MOUNTED right after the
// click, which is what "undoable" means.
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
  // Flush the strip's enter-rAF inside act (mirrors `ApplyConfirmation.test`'s
  // `settle`) — a frame is far short of the hold, so nothing collapses — plus
  // any capability probe a re-mounted RoleEntry just kicked off.
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
}

function removeButtons(el: HTMLDivElement): HTMLButtonElement[] {
  return Array.from(
    el.querySelectorAll<HTMLButtonElement>('[aria-label="Remove bullet"]'),
  );
}

const UNDO_LABEL = "Undo the changes just applied to the résumé";

describe("ExperienceSection — 'Other bullets' remove is undoable (issue 626)", () => {
  it("keeps the Removed/Undo strip after the bucket's LAST bullet — and its group — disappears", async () => {
    const el = await render();

    // Two rows: the matched bullet under the role, the unmatched one under
    // "Other bullets" (appended last).
    expect(el.textContent).toContain("Other bullets");
    const buttons = removeButtons(el);
    expect(buttons).toHaveLength(2);

    await click(buttons[1]!);

    // The group is gone — that is the condition that used to kill the strip.
    expect(el.textContent).not.toContain("Other bullets");
    expect(removeButtons(el)).toHaveLength(1);

    // …and the remove is still undoable.
    expect(el.textContent).toContain("Removed 1 change");
    expect(el.querySelector(`[aria-label="${UNDO_LABEL}"]`)).not.toBeNull();
  });

  it("clicking that Undo restores the bullet and confirms the revert", async () => {
    const el = await render();
    await click(removeButtons(el)[1]!);

    await click(el.querySelector<HTMLElement>(`[aria-label="${UNDO_LABEL}"]`)!);

    expect(el.textContent).toContain("Other bullets");
    expect(el.textContent).toContain(UNMATCHED);
    expect(el.textContent).toContain("Reverted 1 change");
  });

  it("still hosts a parsed role's own strip in the role (not lifted)", async () => {
    const el = await render();
    await click(removeButtons(el)[0]!);
    // The role survives losing its last bullet, so its strip stays inline.
    expect(el.textContent).toContain("Removed 1 change");
    expect(el.textContent).toContain("Staff Engineer");
  });
});
