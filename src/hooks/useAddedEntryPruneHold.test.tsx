// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Contract tests for the release path #658 added to the prune hold.
 *
 * The registry's #637 half is exercised end-to-end through the real strip and
 * the real edit hook in `ExperienceSection.prune-hold.test.tsx`. What that
 * harness cannot show is the part of the release contract with no observable
 * consequence today — a stay that ends on UNMOUNT must not prune, because the
 * unmount the prune itself causes would re-enter it, and an explicit "Remove
 * role" or a fresh parse would prune on teardown. Reverting that rule leaves the
 * section-level suite green (the redundant pass is a no-op there), so it is
 * pinned here, directly, alongside the live-input gate that is the whole reason
 * #637's rejection of this fix no longer applies. That gate has two independent
 * halves — focus containment, and an OPEN DRAFT that has outlived its focus — so
 * each is pinned on its own; the end-to-end consequence of the second (a typed,
 * unsaved title surviving the collapse) is in the section-level suite.
 *
 * jsdom + raw `createRoot`, matching the sibling component suites (the project
 * has no @testing-library/react). Focus is real `HTMLElement.focus()` +
 * `document.activeElement` — see the note on `withHost: false` for the one
 * behaviour that is asserted about a DOM API rather than through it.
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createElement, useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useAddedEntryPruneHold,
  useHoldWhile,
  type AddedEntryPruneHold,
} from "./useAddedEntryPruneHold.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ID = "added:0";
const SIBLING = "added:1";

/** The spare predicate handed to `pruneEmptyAddedEntries`, once per prune run. */
let runs: Array<(entryId: string) => boolean>;
let registry: AddedEntryPruneHold;

/**
 * The holder — a stand-in for `RoleEntry`, with something focusable inside it
 * the way every real entry has.
 *
 * READ mode renders only a button, and the text control appears only while a
 * draft is open. That is what a `RoleEntry` really does — an `EditableField` in
 * read mode is a `<span role="button">`, `InlineBulletAdd` collapses to an
 * `AddPill`, and the remove/rewrite controls are `Button`s — and modelling it is
 * load-bearing here: this stand-in used to render an `<input>` unconditionally,
 * which makes the open-draft half of the gate unfalsifiable (every case looks
 * like a live draft) and the plain "focus has left" case impossible to reach.
 */
function Entry({
  held,
  withHost,
  editing,
}: {
  held: boolean;
  withHost: boolean;
  editing: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useHoldWhile(registry, ID, held, withHost ? rootRef : undefined);
  return createElement(
    "div",
    { ref: rootRef },
    editing
      ? createElement("input", { "aria-label": "draft" })
      : createElement("button", { "aria-label": "field" }),
  );
}

/** The pruner — a stand-in for `ExperienceSection`, which owns the registry and
 *  outlives its holders. */
function Section({
  mounted = true,
  held,
  withHost = true,
  editing = false,
}: {
  mounted?: boolean;
  held: boolean;
  withHost?: boolean;
  editing?: boolean;
}) {
  registry = useAddedEntryPruneHold((isSpared) => {
    runs.push(isSpared);
  });
  return createElement(
    "div",
    null,
    mounted ? createElement(Entry, { held, withHost, editing }) : null,
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  runs = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function render(props: Parameters<typeof Section>[0]) {
  act(() => {
    root!.render(createElement(Section, props));
  });
  return container!;
}

describe("useHoldWhile — the end of a stay re-runs the prune (#658)", () => {
  it("prunes once, for the released entry only", () => {
    render({ held: true });
    expect(registry.isHeld(ID)).toBe(true);
    expect(runs).toHaveLength(0);

    render({ held: false });

    expect(registry.isHeld(ID)).toBe(false);
    expect(runs).toHaveLength(1);
    // Narrowed to the one entry whose stay ended: the pass it triggers is
    // section-wide, and a timer must not sweep a sibling the user is mid-edit in
    // or one they just opened with "+ Add experience".
    expect(runs[0]!(ID)).toBe(false);
    expect(runs[0]!(SIBLING)).toBe(true);
  });

  it("does not prune on a re-render that keeps the hold", () => {
    render({ held: true });
    render({ held: true });
    expect(runs).toHaveLength(0);
  });

  it("does not prune when a holder mounts unheld", () => {
    render({ held: false });
    expect(runs).toHaveLength(0);
  });

  it("does not prune when the stay ends by UNMOUNT", () => {
    render({ held: true });
    expect(registry.isHeld(ID)).toBe(true);

    render({ mounted: false, held: true });

    // The lease still lapses — that is #637's rule and it is unchanged.
    expect(registry.isHeld(ID)).toBe(false);
    // But a teardown is not a stay ending. The prune's own drop unmounts the
    // holder, an explicit "Remove role" unmounts it, and a fresh parse unmounts
    // the lot; none of them is the timer this fix reacts to.
    expect(runs).toHaveLength(0);
  });
});

describe("useHoldWhile — the live-input gate (#658, answering #637's rejection)", () => {
  it("stands down while focus is inside the holder", () => {
    const el = render({ held: true });
    const control = el.querySelector<HTMLButtonElement>('[aria-label="field"]')!;
    act(() => control.focus());
    // Not incidental to the assertion below — without real focus here the test
    // would pass with the gate deleted. A BUTTON, not an input, so this case
    // exercises focus containment alone.
    expect(document.activeElement).toBe(control);

    render({ held: false });

    expect(registry.isHeld(ID)).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it("prunes once focus has left the holder", () => {
    const el = render({ held: true });
    const control = el.querySelector<HTMLButtonElement>('[aria-label="field"]')!;
    act(() => control.focus());
    act(() => control.blur());
    expect(document.activeElement).toBe(document.body);

    render({ held: false });

    expect(runs).toHaveLength(1);
  });

  it("stands down for an OPEN DRAFT the user has blurred", () => {
    // The half focus containment cannot see. A `multiline` `EditableField` and an
    // expanded `InlineBulletAdd` both keep their draft across a blur on purpose,
    // so an entry the user is demonstrably mid-input in reads as unfocused — and
    // as empty, since a multiline draft commits only on an explicit Save. A
    // focus-only gate pruned it and destroyed the typed text.
    const el = render({ held: true, editing: true });
    const draft = el.querySelector<HTMLInputElement>('[aria-label="draft"]')!;
    act(() => draft.focus());
    act(() => draft.blur());
    expect(document.activeElement).toBe(document.body);

    // Still editing on both sides of the release: the draft outlives the blur,
    // which is the entire point.
    render({ held: false, editing: true });

    expect(registry.isHeld(ID)).toBe(false);
    expect(runs).toHaveLength(0);
    // And the draft is still there to be saved.
    expect(el.querySelector('[aria-label="draft"]')).not.toBeNull();
  });

  it("stands down for a holder that registers no root node", () => {
    // Unprovable is not the same as unfocused. Nothing in the tree omits the
    // ref today; the rule exists so a future holder cannot silently opt into
    // being pruned mid-keystroke by forgetting one argument.
    render({ held: true, withHost: false });
    expect(document.activeElement).toBe(document.body);

    render({ held: false, withHost: false });

    expect(runs).toHaveLength(0);
  });
});
