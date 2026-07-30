// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Regression test for #659 — the "Removed 1 change · Undo" strip used to confirm
 * a removal that provably did nothing.
 *
 * `useEditableParse.removeBullet` reports whether its write landed: `false` when
 * a user-ADDED bullet's bucket line is already gone (the deliberate
 * `isAddedEntryKey` early return, #637) or when the id is already in
 * `removedBullets` (#648). `useBulletRemoveStatus` must follow that report rather
 * than the mere fact of having called it. Three things key off it, and this file
 * pins all three:
 *
 *   1. the strip's copy — the user is not told a change was made that was not;
 *   2. the ARMED UNDO — a second, no-op call must not overwrite a live strip's
 *      undo with one snapshotted after the real removal already landed, which
 *      restores nothing (`captureBulletUndoSnapshot` reads the bucket as it is
 *      now, and filters an already-removed id out of `restore`);
 *   3. `pending`, which `RoleEntry` hands to `useHoldWhile` — a no-op removal
 *      must not hold an empty added role back from the section-exit prune (#379).
 *
 * All three were unheld before this file: flipping either the strip's gate or
 * `removeBullet`'s `false` left the whole suite green.
 *
 * `onRemoveBullet` is a STUB here on purpose. The unit under test is the wiring
 * from the write's report to the strip, the undo and the hold; that the real hook
 * reports the truth is pinned separately, against the real regrade pipeline, in
 * `useEditableParse.added-bullet-remove.test.tsx` ("reports that repeat click as
 * NOT recorded") and in `ExperienceSection.prune-hold.test.tsx` (#659, where the
 * no-op is produced by shipped code rather than staged).
 *
 * jsdom + raw `createRoot` + fake timers, matching `ExperienceSection.test.tsx`
 * (the project has no @testing-library/react).
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useBulletRemoveStatus,
  type BulletRemoveControl,
} from "./BulletRemoveStatus.tsx";
import { RoleEntry } from "./ReconstructedRole.tsx";
import {
  useAddedEntryPruneHold,
  type AddedEntryPruneHold,
} from "../../hooks/useAddedEntryPruneHold.ts";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";
import type { ResolvedWrite } from "../../lib/rewrite-review/apply-accepted.ts";
import { countWords } from "../../lib/score/score.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const BULLET = "Shipped a design system used by 40 engineers.";
const OBS_ID = "0|shipped a design system used by 40 engineers.";
const UNDO_LABEL = "Undo the changes just applied to the résumé";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

async function mount(node: ReactElement): Promise<HTMLDivElement> {
  await act(async () => {
    root!.render(node);
  });
  // Flush the WebGPU-capability probe a freshly-mounted RoleEntry kicks off, so
  // its setState lands inside act().
  await act(async () => {});
  return container!;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
}

// ── the hook's own contract ─────────────────────────────────────────────────

describe("useBulletRemoveStatus — the strip follows the write (#659)", () => {
  let control: BulletRemoveControl;
  /** Every undo thunk the hook captured, newest last. */
  let captured: Array<() => void>;
  let undone: number;

  function Probe({ landed }: { landed: boolean }) {
    control = useBulletRemoveStatus(
      () => landed,
      (_writes: readonly ResolvedWrite[]) => {
        const thunk = () => {
          undone += 1;
        };
        captured.push(thunk);
        return thunk;
      },
    );
    return createElement("div", null, control.strip);
  }

  beforeEach(() => {
    captured = [];
    undone = 0;
  });

  it("renders NO strip for a removal that reports nothing", async () => {
    const el = await mount(createElement(Probe, { landed: false }));

    let result = true;
    await act(async () => {
      result = control.removeBullet(OBS_ID, BULLET);
    });

    expect(result).toBe(false);
    expect(el.textContent).not.toContain("Removed");
    expect(el.querySelector(`[aria-label="${UNDO_LABEL}"]`)).toBeNull();
    // What #637 half 2 reads to hold the entry back from the prune.
    expect(control.pending).toBe(false);
  });

  it("discards the snapshot it took for that no-op", async () => {
    await mount(createElement(Probe, { landed: false }));

    await act(async () => {
      control.removeBullet(OBS_ID, BULLET);
    });

    // The capture is unavoidable — it has to happen BEFORE the write, and the
    // write is what reveals the no-op (issue 510's ordering rule). What must not
    // happen is that snapshot reaching the user as an Undo affordance.
    expect(captured).toHaveLength(1);
    expect(undone).toBe(0);
  });

  it("still renders the strip and a working Undo for a real removal", async () => {
    const el = await mount(createElement(Probe, { landed: true }));

    let result = false;
    await act(async () => {
      result = control.removeBullet(OBS_ID, BULLET);
    });

    expect(result).toBe(true);
    expect(el.textContent).toContain("Removed 1 change");
    expect(control.pending).toBe(true);

    const undo = el.querySelector<HTMLElement>(`[aria-label="${UNDO_LABEL}"]`);
    expect(undo).not.toBeNull();
    await click(undo!);

    expect(undone).toBe(1);
    expect(el.textContent).toContain("Reverted 1 change");
  });

  it("keeps a live strip's OWN undo when a later call reports nothing", async () => {
    // The harm the copy alone understates. Both calls capture, so an ungated
    // second `setStatus` swaps the armed thunk for the newer one — snapshotted
    // AFTER the real removal landed, so it restores nothing. Whichever thunk the
    // mounted button holds is the one the user gets, and it must be the first.
    let landed = true;
    function Swinger() {
      control = useBulletRemoveStatus(
        () => landed,
        () => {
          const n = captured.length;
          const thunk = () => {
            undone = n;
          };
          captured.push(thunk);
          return thunk;
        },
      );
      return createElement("div", null, control.strip);
    }
    const el = await mount(createElement(Swinger));

    await act(async () => {
      control.removeBullet(OBS_ID, BULLET);
    });
    landed = false;
    await act(async () => {
      control.removeBullet(OBS_ID, BULLET);
    });

    expect(captured).toHaveLength(2);
    await click(el.querySelector<HTMLElement>(`[aria-label="${UNDO_LABEL}"]`)!);
    // Thunk 0 — the one captured before the write that actually landed.
    expect(undone).toBe(0);
  });

  it("is inert, and reports so, with no writer wired at all", async () => {
    function Unwired() {
      control = useBulletRemoveStatus(undefined, undefined);
      return createElement("div", null, control.strip);
    }
    const el = await mount(createElement(Unwired));

    let result = true;
    await act(async () => {
      result = control.removeBullet(OBS_ID, BULLET);
    });

    expect(result).toBe(false);
    expect(el.textContent).not.toContain("Removed");
  });
});

// ── what keys off it: the section-exit prune hold ───────────────────────────

describe("RoleEntry — a no-op removal takes no prune hold (#659)", () => {
  const ENTRY_KEY = "added:0";

  function group(): BulletGroup {
    return {
      experienceIndex: 1,
      experience: { title: "Principal Engineer", company: "Cascadia Analytics" },
      bullets: [
        {
          text: BULLET,
          id: OBS_ID,
          index: 0,
          hasMetric: true,
          startsWithActionVerb: true,
          wellFormedLength: true,
          wordCount: countWords(BULLET),
        },
      ],
    };
  }

  let registry: AddedEntryPruneHold;

  function Host({ landed }: { landed: boolean }) {
    registry = useAddedEntryPruneHold();
    return createElement(RoleEntry, {
      group: group(),
      experienceIndex: 1,
      onBulletChange: () => {},
      onAddBullet: () => {},
      onRemoveBullet: () => landed,
      captureUndo: () => () => {},
      // Set for a user-ADDED role, which is the only kind the prune can drop.
      onRemove: () => {},
      entryKey: ENTRY_KEY,
      pruneHold: registry,
    });
  }

  async function clickRemove(el: HTMLDivElement) {
    await click(
      el.querySelector<HTMLElement>('[aria-label="Remove bullet"]')!,
    );
  }

  it("leaves the entry unheld when the write reports nothing", async () => {
    const el = await mount(createElement(Host, { landed: false }));
    expect(registry.isHeld(ENTRY_KEY)).toBe(false);

    await clickRemove(el);

    // Without this, an added role kept alive by a strip that represents nothing
    // survives a prune it should not have — and since the strip never armed,
    // there is no collapse to release the hold and re-run the prune (#658)
    // either, so it survives until the next section exit.
    expect(registry.isHeld(ENTRY_KEY)).toBe(false);
    expect(el.textContent).not.toContain("Removed");
  });

  it("does hold it for a real removal", async () => {
    const el = await mount(createElement(Host, { landed: true }));

    await clickRemove(el);

    expect(registry.isHeld(ENTRY_KEY)).toBe(true);
    expect(el.textContent).toContain("Removed 1 change");
  });
});
