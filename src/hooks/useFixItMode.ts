// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fix It step-through mode (#810) — the mode's state, and the one definition of
 * how a résumé target shows it is the current step.
 *
 * `useFixItMode` owns whether the mode is on, which guidance item is current,
 * and where focus goes on the way in and out. Focus is the part with an
 * invariant: entering moves focus into the résumé, so leaving must hand it back
 * to whatever the user was on — the Fix It button, or the docked strip's copy —
 * or a keyboard user who presses Done lands on `<body>` at the top of the tab
 * order with no context. When that element has gone (the strip re-rendered it
 * away) the step the user was on takes focus instead.
 *
 * `useFixItTarget` is what every anchor in the résumé calls, so the highlight
 * treatment lives here once rather than as a class string copied into each
 * section. The context carries only the active anchor id: targets re-render on
 * a step change, never on a keystroke.
 *
 * `useFixItStep` is the way in from the résumé itself (#913): a flagged
 * bullet's tinted marker asks it for that bullet's step, and activating the
 * marker enters the mode there. It reads the SAME guidance items the dock
 * steps through, so a marker exists only where a step does — there is no
 * second definition of "this bullet needs attention" to drift from the count.
 * Its context is separate from `FixItContext` because its value changes on
 * every re-grade, which the targets reading the active anchor must not see.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  computeScoreGuidance,
  type GuidanceItem,
  type ResumeStructureInput,
} from "../lib/score/guidance.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { scrollIntoViewMotionAware } from "../lib/anchors.ts";

interface FixItContextValue {
  /** The DOM anchor id of the current guidance item, or null when inactive. */
  activeAnchor: string | null;
}

export const FixItContext = createContext<FixItContextValue>({
  activeAnchor: null,
});

/** Inline targets (a contact field, the name) pad sideways; blocks pad all round. */
type FixItTargetShape = "inline" | "block";

const TARGET_BASE = "transition-all duration-200 outline-hidden";
const TARGET_ACTIVE =
  "ring-2 ring-accent-primary ring-offset-2 ring-offset-surface-card bg-accent-forward-bg/25 rounded";
const TARGET_PAD: Record<FixItTargetShape, string> = {
  inline: "px-1",
  block: "p-2",
};

/**
 * Which of the current step's edit chrome shows while it is current, even with
 * the pointer and focus elsewhere (#913; styles/edit-chrome.css). `all` suits a
 * target that is one field — a missing field's "+ email" prompt, the summary's
 * placeholder. `focus` shows only the control `focusControl` lands on — a
 * section's `[data-fixit-focus]` add pill — and never every Remove and Move in
 * the section, on the step that asks for more entries. A block target
 * defaults to `focus`, so one without a marked control must ask for `all`.
 */
type FixItReveal = "all" | "focus";

const REVEAL_CLASS: Record<FixItReveal, string> = {
  all: "edit-reveal",
  focus: "edit-reveal-focus",
};

/**
 * Props that make an element a Fix It anchor: its id, focusable by script
 * only, and the highlight while it is the current step. Merge `className`
 * into the element's own classes.
 */
export function useFixItTarget(
  anchorId: string,
  shape: FixItTargetShape,
  reveal: FixItReveal = shape === "inline" ? "all" : "focus",
): { id: string; tabIndex: -1; className: string } {
  const { activeAnchor } = useContext(FixItContext);
  const active = activeAnchor === anchorId;
  return {
    id: anchorId,
    tabIndex: -1,
    className: active
      ? `${TARGET_BASE} ${TARGET_ACTIVE} ${TARGET_PAD[shape]} ${REVEAL_CLASS[reveal]}`
      : TARGET_BASE,
  };
}

/**
 * Where a step's focus goes inside its target: the control marked
 * `data-fixit-focus` (a section's add control), else the first control in it,
 * else the target itself. The marker exists because a section's first control
 * is often the wrong one — in Skills it is the first chip's remove button, and
 * Enter there would delete a skill on the step that asks for more.
 *
 * A bullet's tinted marker (`data-fixit-marker`, #913) is skipped: it is the
 * way INTO the step, first in the row, and landing on it would leave Enter
 * re-entering the step instead of editing the bullet the step is about.
 */
function focusControl(target: HTMLElement): HTMLElement {
  return (
    target.querySelector<HTMLElement>("[data-fixit-focus]") ??
    target.querySelector<HTMLElement>(
      "button:not([data-fixit-marker]), input, textarea, [tabindex='0']",
    ) ??
    target
  );
}

/** Scroll a target into view and focus its control. `preventScroll`, or the
 *  focus scroll pre-empts the smooth one and can leave it under the dock. */
function focusTarget(anchorId: string): void {
  const target = document.getElementById(anchorId);
  if (!target) return;
  scrollIntoViewMotionAware(target, "center");
  focusControl(target).focus?.({ preventScroll: true });
}

/**
 * The element Done hands focus back to. `<body>` is no target: Safari, and
 * Firefox on macOS, do not focus a button on mouse click, so a click on Fix It
 * leaves `<body>` active, and "returning" there is the stranding this hook
 * exists to prevent. Null sends `exit` to the last step's target instead
 * (#1003).
 */
function returnTarget(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/** The current step: tracked by item id, with its position as the fallback. */
interface Step {
  id: string | null;
  index: number;
  /** Stepped past the last item, into the finished panel. */
  pastEnd: boolean;
}

const START: Step = { id: null, index: 0, pastEnd: false };

/** What a marker needs to enter the mode at its own step — see `useFixItStep`. */
export interface FixItEntry {
  /** Each bullet step, keyed by its `bulletId`: every marker looks itself up
   *  on every re-grade, so the lookup is a map, not a scan of the items. */
  bulletSteps: ReadonlyMap<string, GuidanceItem>;
  /** Enter the mode at the item with this id; a no-op for an unknown id. */
  startAt: (itemId: string) => void;
}

export const FixItEntryContext = createContext<FixItEntry>({
  bulletSteps: new Map(),
  startAt: () => {},
});

/** The bullet steps of `items`, keyed as `FixItEntry.bulletSteps` is. */
export function bulletStepsOf(
  items: readonly GuidanceItem[],
): ReadonlyMap<string, GuidanceItem> {
  const steps = new Map<string, GuidanceItem>();
  for (const item of items) {
    // First wins, as a `find` over the items would.
    if (
      item.targetType === "bullet" &&
      item.bulletId !== undefined &&
      !steps.has(item.bulletId)
    ) {
      steps.set(item.bulletId, item);
    }
  }
  return steps;
}

/**
 * The Fix It step for one bullet, or null when it has none — outside a
 * provider (`FixItScope`, which both résumé lanes mount), for a bullet
 * whose checks all pass, and for one Fix It does not step through (a read-only
 * project/achievement row, or a metric-less bullet past the metric budget:
 * `computeScoreGuidance` decides, not this hook).
 */
export function useFixItStep(
  bulletId: string,
): { item: GuidanceItem; enter: () => void } | null {
  const { bulletSteps, startAt } = useContext(FixItEntryContext);
  const item = bulletSteps.get(bulletId);
  return item ? { item, enter: () => startAt(item.id) } : null;
}

export interface FixItMode {
  active: boolean;
  /** The current item's index, clamped to the list as it shrinks — or
   *  `items.length` once the user has stepped past the last item. */
  index: number;
  /** Null when the mode is off — feed to `FixItContext`. */
  activeAnchor: string | null;
  start: () => void;
  navigate: (index: number) => void;
  exit: () => void;
  /** Feed to `FixItEntryContext` — the markers' way in (#913). */
  entry: FixItEntry;
}

/**
 * `resetKey` is the parse identity: a new résumé ends the mode and rewinds it.
 * Edits re-derive `items` on every keystroke and must do neither.
 *
 * The current step is tracked by item id, not by position, so an edit that
 * adds or resolves an item elsewhere in the list leaves the user where they
 * were. Only when the current item itself goes — the edit resolved it — does
 * the step fall back to its old position, which is now the next item; that
 * item is scrolled into view but NOT focused, because focus is still in the
 * field the user just edited.
 *
 * `navigate(items.length)` steps past the end: no item is current, so no
 * target keeps the highlight under the finished panel, and `navigate` back to
 * the last index returns to it.
 */
function useFixItMode(
  items: readonly GuidanceItem[],
  resetKey: unknown,
): FixItMode {
  const [active, setActive] = useState(false);
  const [current, setCurrent] = useState<Step>(START);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  // The element the last step highlighted. An element, not an id: editing a
  // bullet re-keys its id while React keeps the same `<li>`, and exit falls
  // back to it when the entry control has gone.
  const lastTarget = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setActive(false);
    setCurrent(START);
    returnFocusTo.current = null;
    lastTarget.current = null;
  }, [resetKey]);

  const found = items.findIndex((item) => item.id === current.id);
  const index = current.pastEnd
    ? items.length
    : found >= 0
      ? found
      : items.length > 0
        ? Math.min(current.index, items.length - 1)
        : 0;
  const item = items[index];
  const activeAnchor = active ? (item?.targetAnchor ?? null) : null;

  // Re-pin to the item now at this step once the tracked one has gone, and
  // bring it into view — `nearest`, so a target already on screen stays put.
  useEffect(() => {
    if (!active || !item || item.id === current.id) return;
    setCurrent({ id: item.id, index, pastEnd: false });
    scrollIntoViewMotionAware(
      document.getElementById(item.targetAnchor),
      "nearest",
    );
  }, [active, item, index, current.id]);

  useEffect(() => {
    if (activeAnchor) lastTarget.current = document.getElementById(activeAnchor);
  }, [activeAnchor]);

  const navigate = useCallback(
    (next: number) => {
      const target = items[next];
      setCurrent({
        id: target?.id ?? null,
        index: next,
        pastEnd: next >= items.length,
      });
      if (target) focusTarget(target.targetAnchor);
    },
    [items],
  );

  // Entering from the Fix It button and from a bullet's marker is one path:
  // either way the control the user was on is where Done hands focus back.
  // Only on the way IN: a marker clicked while the mode is already on moves
  // the step, and must not overwrite the control the user entered from.
  const enter = useCallback(
    (next: number) => {
      if (!active) returnFocusTo.current = returnTarget();
      setActive(true);
      navigate(next);
    },
    [active, navigate],
  );

  const start = useCallback(() => enter(0), [enter]);

  const startAt = useCallback(
    (itemId: string) => {
      const next = items.findIndex((item) => item.id === itemId);
      if (next >= 0) enter(next);
    },
    [items, enter],
  );
  const entry = useMemo(
    () => ({ bulletSteps: bulletStepsOf(items), startAt }),
    [items, startAt],
  );

  const exit = useCallback(() => {
    setActive(false);
    const back = returnFocusTo.current;
    returnFocusTo.current = null;
    const fallback = lastTarget.current;
    if (back?.isConnected) {
      back.focus();
    } else if (fallback?.isConnected) {
      focusControl(fallback).focus();
    }
  }, []);

  return { active, index, activeAnchor, start, navigate, exit, entry };
}

/**
 * One lane's guidance items and the mode that steps through them — the pair
 * every lane rendering an editable résumé needs (`Result` on `/`, the
 * authoring lane), derived once here so the two cannot disagree about which
 * bullets have a step. `score` is null until the #313 reveal gate opens, and
 * then there is nothing to step through.
 */
export function useScoreFixIt(
  score: AnonymousAtsScore | null,
  fields: ResumeStructureInput,
  resetKey: unknown,
): { items: readonly GuidanceItem[]; fixIt: FixItMode } {
  const items = useMemo(
    () => (score ? computeScoreGuidance(score, fields) : []),
    [score, fields],
  );
  const fixIt = useFixItMode(items, resetKey);
  return { items, fixIt };
}
