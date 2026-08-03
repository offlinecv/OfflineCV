// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useCopyToClipboard — the ONE definition of "put this text on the clipboard
 * and say what happened" (#609).
 *
 * Before this hook the same twelve lines were hand-rolled in three feature
 * components (`WebGpuUnavailableNotice`'s `CopyablePath`, `SectionRewrite`'s
 * `ProposedSection`, `LetterRevealDialog`), and they had already drifted:
 * two swallowed a failure into `idle` — leaving a button that still reads
 * "Copy" while the clipboard holds whatever was there before — and only the
 * third told the user. #609 would have been the fourth, which is where
 * CLAUDE.md's Golden Rule says it stops.
 *
 * Lives in `design-system/` next to {@link CopyButton} rather than in
 * `src/hooks/`: it carries no domain state, it is the logic half of a
 * primitive, and a downstream cloner repointing the `@design-system` alias has
 * to be able to swap both halves together.
 *
 * ── The two things this hook exists to get right ──
 *
 * 1. **Absence is its own branch.** `navigator.clipboard` is `undefined` on an
 *    insecure origin — `npm run dev:http`, a workflow this repo documents for
 *    LAN demos. `navigator.clipboard?.writeText(t)` evaluates to `undefined`,
 *    which `await`s cleanly and reports a copy that never happened. So the
 *    API is read off `navigator` explicitly and its absence sets `failed`
 *    (`LetterRevealDialog`'s lesson, now enforced for every caller).
 *
 * 2. **A failure persists; a confirmation expires.** `resetAfterMs` clears
 *    `copied` only. A transient "Copied ✓" that lingers would claim a copy the
 *    user made a minute ago, but a failure notice that vanishes on a timer is
 *    a message the user may never read — and the fallback it points at
 *    ("select the text yourself") stays true until they act on it.
 *
 * There is no toast in this design system (design-system/CLAUDE.md): callers
 * confirm by swapping content in the surface already mounted.
 */

import { useCallback, useEffect, useState } from "react";

/**
 * Idle, or the outcome of the last attempt. A boolean cannot hold "tried and
 * failed" apart from "not tried" — which is exactly what made the failure
 * invisible at two of the three pre-#609 call sites.
 */
export type CopyState = "idle" | "copied" | "failed";

export interface CopyToClipboard {
  /** Outcome of the most recent {@link copy}. */
  state: CopyState;
  /** Attempt a clipboard write. Never throws and never rejects. */
  copy: (text: string) => void;
  /**
   * Drop back to `idle`. For callers whose surface outlives the copy (a dialog
   * that stays open while the user switches to a different draft) — without it
   * a stale "Copied" would describe the previous selection.
   */
  reset: () => void;
}

export function useCopyToClipboard(
  /**
   * Clear a `copied` confirmation after this many ms, so a second copy of the
   * same value re-confirms visibly. Omitted → the confirmation holds until the
   * caller resets or unmounts. Never applies to `failed` (see the docblock).
   */
  resetAfterMs?: number,
): CopyToClipboard {
  const [state, setState] = useState<CopyState>("idle");

  const copy = useCallback((text: string) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setState("failed");
      return;
    }
    // `.then(onOk, onErr)` rather than `.then().catch()`: a `catch` chained
    // after the success handler would also swallow a throw FROM it, turning a
    // render-time bug into a silent "Couldn't copy".
    void clipboard.writeText(text).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  }, []);

  const reset = useCallback(() => setState("idle"), []);

  useEffect(() => {
    if (resetAfterMs === undefined || state !== "copied") return;
    const id = setTimeout(() => setState("idle"), resetAfterMs);
    return () => clearTimeout(id);
  }, [state, resetAfterMs]);

  return { state, copy, reset };
}
