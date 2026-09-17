// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useAutoCollapse — the countdown / scroll / hold lifecycle behind the score
 * widget's docked strip (#953).
 *
 * `AtsScoreReadout` reveals the full score on arrival and docks it to a
 * one-line strip shortly after, so the résumé the user dropped a file to see
 * is not held below the fold by a diagnostic they have already read. That is
 * four pieces of interaction state — a timer, a scroll listener, a pointer and
 * focus hold, and a "the user has decided" lock — which CLAUDE.md keeps out of
 * feature components and in a hook that can be tested without a layout engine.
 *
 * The HOLD is the part worth stating. Collapsing content out from under
 * someone who is still reading it is a defect, and a pointer is only one way
 * to read: a keyboard user tabs into the panel and never generates a
 * `mouseenter`. So hover and focus BOTH hold the countdown, and `guardProps`
 * ships all four handlers as one object precisely so a caller cannot wire the
 * mouse half and silently skip the focus half — which is exactly what this
 * widget shipped with before, while its docblock claimed otherwise.
 *
 * `onBlur` ignores focus moving BETWEEN descendants (`relatedTarget` still
 * inside). Without that check, tabbing from one control to the next inside the
 * very panel being read would release the hold and restart the countdown.
 *
 * `toggle` LOCKS. Once the user has stated a preference, neither the timer nor
 * the scroll listener may overrule it — an auto-collapse that fights a manual
 * expand is worse than no auto-collapse at all.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent } from "react";

export interface AutoCollapseOptions {
  /** Initial state. Defaults to expanded — the post-drop reveal. */
  defaultCollapsed?: boolean;
  /** Countdown from arrival (or from a `resetKey` change) before docking. */
  idleMs?: number;
  /** Shorter countdown resumed after a hover/focus hold is released. */
  releaseMs?: number;
  /** Scrolling this many px AWAY FROM where the widget was revealed docks it.
   *  Displacement, not absolute offset — see the scroll effect. */
  scrollThresholdPx?: number;
  /** Changing this re-reveals: the panel re-expands and the countdown restarts,
   *  because a new parse is new information the reader has not seen.
   *
   *  A user lock wins over it — someone who chose the docked strip keeps it.
   *
   *  The key is only as good as what the caller passes, and it must identify
   *  the PARSE rather than anything derived from it. `AtsScoreReadout` keyed on
   *  the overall score until #956 review: the score re-grades on every override,
   *  so an ordinary edit below the fold re-expanded the widget, pushed the
   *  résumé being typed in down by the difference, and dropped it back a few
   *  seconds later — twice per edit. It now takes a `resetKey` prop fed from
   *  `parseIdentity` (parse lane) or `parseKey` (authoring lane). */
  resetKey?: unknown;
}

export interface AutoCollapseGuardProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

export interface AutoCollapse {
  collapsed: boolean;
  /** User-driven set. Locks out the timer and the scroll listener for good. */
  toggle: (collapsed: boolean) => void;
  /** Spread onto the element whose hover/focus should hold the countdown. */
  guardProps: AutoCollapseGuardProps;
}

export function useAutoCollapse({
  defaultCollapsed = false,
  idleMs = 4500,
  releaseMs = 2500,
  scrollThresholdPx = 40,
  resetKey,
}: AutoCollapseOptions = {}): AutoCollapse {
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed);
  const [locked, setLocked] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRef = useRef<boolean>(false);
  const focusRef = useRef<boolean>(false);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const arm = useCallback(
    (ms: number) => {
      clear();
      if (locked) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // Re-checked at fire time, not at arm time: a hold taken while the
        // countdown was already running must still suppress the collapse.
        if (!hoverRef.current && !focusRef.current) setCollapsed(true);
      }, ms);
    },
    [clear, locked],
  );

  // A new `resetKey` re-expands. This has to be its own effect: the arrival
  // countdown below returns early while `collapsed`, so on its own a key change
  // arriving at a docked widget did nothing at all and the "new parse is a new
  // reveal" promise was false in exactly the state it was written for.
  const prevResetKey = useRef(resetKey);
  useEffect(() => {
    if (Object.is(prevResetKey.current, resetKey)) return;
    prevResetKey.current = resetKey;
    if (locked) return;
    setCollapsed(false);
  }, [resetKey, locked]);

  // Arrival countdown. Skipped once docked or locked, so a collapsed widget
  // never holds a pending timer. Re-expanding above re-enters this effect,
  // which is what restarts the clock.
  useEffect(() => {
    if (collapsed || locked) return;
    arm(idleMs);
    return clear;
  }, [resetKey, collapsed, locked, arm, clear, idleMs]);

  // Scrolling away is a stronger "done reading" signal than the clock, so it
  // docks immediately rather than shortening the countdown.
  //
  // DISPLACEMENT since the reveal, not absolute `scrollY` (#956 review). The
  // widget is not always revealed at the top of the document: a drop is
  // accepted anywhere on the window, so a reader at `scrollY ≈ 1500` who drops
  // a second résumé gets a widget that is already past the threshold before
  // they touch anything — docked by the first scroll event of any size,
  // including the scroll UP to go look at it, or a scroll-anchoring
  // correction, or the many intermediate events a smooth rail scroll emits.
  // Re-expanding re-enters this effect, so a re-reveal re-baselines too.
  //
  // It still honours the hold, and that is not belt-and-braces: without the
  // check this path walks straight around the guarantee the rest of the hook
  // makes. Focusing a control inside the panel can make the BROWSER scroll it
  // into view, so a keyboard user reading the expanded widget would dock it by
  // the act of reading it. The threshold is also direction-blind — scrolling
  // back UP to re-read the score crosses it just the same — and a reader whose
  // pointer or focus is on the widget is the one case where that reading is
  // certainly wrong.
  useEffect(() => {
    if (collapsed || locked) return;
    const revealedAt = window.scrollY;
    const onScroll = () => {
      if (hoverRef.current || focusRef.current) return;
      if (Math.abs(window.scrollY - revealedAt) > scrollThresholdPx) {
        setCollapsed(true);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [collapsed, locked, scrollThresholdPx]);

  // No separate unmount cleanup for the hold-release timer: `release` returns
  // early unless `!collapsed && !locked`, which is exactly the condition under
  // which the countdown effect above is mounted WITH `return clear` — and
  // `clear` reads `timerRef` at call time, so it cancels whatever is pending
  // regardless of which path armed it. An effect that reads as a safety net
  // while being unreachable is worse than none (#956 review).

  const release = useCallback(() => {
    if (hoverRef.current || focusRef.current) return;
    if (collapsed || locked) return;
    arm(releaseMs);
  }, [arm, collapsed, locked, releaseMs]);

  const guardProps: AutoCollapseGuardProps = {
    onMouseEnter: () => {
      hoverRef.current = true;
      clear();
    },
    onMouseLeave: () => {
      hoverRef.current = false;
      release();
    },
    onFocus: () => {
      focusRef.current = true;
      clear();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      focusRef.current = false;
      release();
    },
  };

  const toggle = useCallback(
    (next: boolean) => {
      clear();
      setLocked(true);
      setCollapsed(next);
    },
    [clear],
  );

  return { collapsed, toggle, guardProps };
}
