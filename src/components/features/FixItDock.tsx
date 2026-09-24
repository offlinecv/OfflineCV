// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FixItDock — the fixed bottom chrome both Fix It panels sit in (#810):
 * `FixItToolbar` while stepping, `FixItFinished` at the end. One definition,
 * so the dock cannot change width when one panel swaps for the other.
 *
 * The dock is drawn over the page, so it also owns the space it covers
 * (#1002). It measures itself and publishes the clearance a target needs as
 * `--fixit-dock-clearance` on the root, which two rules read: the root's
 * `scroll-padding-bottom` (`styles.css`), so a step's `scrollIntoView` stops
 * above the dock rather than under it, and `Result`'s bottom padding, so the
 * last step in the document can scroll that far at all. A fixed guess cannot
 * do this: the dock grows with the step, one block per issue, and a bullet can
 * carry three.
 */

import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Read by `styles.css` and `Result`; unset (0) whenever no dock is mounted. */
const DOCK_CLEARANCE_VAR = "--fixit-dock-clearance";

// `bottom-6` (24px) under the dock, plus 16px so a target clears the dock
// visibly rather than touching its top edge.
const DOCK_OFFSET_PX = 24 + 16;

const DOCK =
  "fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] max-w-2xl rounded-2xl border border-border bg-surface-card/95 p-4 shadow-xl backdrop-blur-md transition-all duration-200";

export function FixItDock({
  label,
  children,
}: {
  /** The region's accessible name. */
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () =>
      root.style.setProperty(
        DOCK_CLEARANCE_VAR,
        `${el.offsetHeight + DOCK_OFFSET_PX}px`,
      );
    publish();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(DOCK_CLEARANCE_VAR);
    };
  }, []);
  return (
    <aside ref={ref} role="region" aria-label={label} className={DOCK}>
      {children}
    </aside>
  );
}
