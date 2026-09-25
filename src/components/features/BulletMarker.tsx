// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * BulletMarker — the `•` in front of an editable bullet, tinted when Fix It has
 * a step for that bullet (#913), and the way into that step.
 *
 * It replaces the amber glyph chips that used to trail a flagged bullet, and
 * the legend beside the Experience heading that keyed them. Those sat inside
 * the résumé's own text, so the column could not be read as a preview of the
 * PDF. The marker carries the whole signal instead, and the reason
 * lives where Fix It already shows it: the dock names the failed check and how
 * to fix it.
 *
 * Invariants:
 *  - Zero added width. The glyph box is the SAME element with the SAME classes
 *    in both states, and a fixed width — only its colour and the glyph inside
 *    it change, and a wider glyph overflows the box evenly rather than
 *    widening it. The control is absolutely positioned on top, so a flagged
 *    bullet wraps like a passing one — and like the PDF.
 *  - Never colour-only (WCAG 1.4.1). A flagged bullet draws a `▲` where a
 *    passing one draws a `•`, so it is findable without telling the tint
 *    apart; the control's description (`aria-describedby`, and a `title` for
 *    the pointer) names the failed checks.
 *  - One mechanism. Whether a marker is tinted is whether `useFixItStep` finds
 *    a step, and activating it enters Fix It at that step. No second focus or
 *    highlight path, no second count.
 *  - The control's 24×24 target (WCAG 2.2 SC 2.5.8) extends LEFT from the
 *    glyph's right edge, into the gutter, so it never overlaps the bullet
 *    text's own click-to-edit target on its right (the #581/#591 class). It is
 *    marked `data-fixit-marker` so a step's focus skips it and lands on the
 *    text (`useFixItMode`'s `focusControl`).
 */

import { Button } from "@design-system";
import { useFixItStep } from "../../hooks/useFixItMode.ts";

export function BulletMarker({
  bulletId,
  anchorId,
}: {
  /** The bullet's stable id — what its guidance item is keyed by. */
  bulletId: string;
  /** The row's Fix It anchor, from which the description id is derived. */
  anchorId: string;
}) {
  const step = useFixItStep(bulletId);
  const checks = step?.item.issues.map((issue) => issue.title).join(", ");
  const descriptionId = `${anchorId}-checks`;
  return (
    <span
      className={`relative mt-1.5 flex w-1.5 shrink-0 justify-center ${
        step ? "text-feedback-warning-text" : "text-content-muted"
      }`}
    >
      {step ? (
        <span aria-hidden="true" className="text-xs">
          ▲
        </span>
      ) : (
        <span aria-hidden="true">•</span>
      )}
      {step && (
        <>
          <Button
            variant="link"
            aria-label="Fix this bullet"
            aria-describedby={descriptionId}
            title={checks}
            data-fixit-marker
            onClick={step.enter}
            className="absolute top-1/2 right-0 h-6 w-6 -translate-y-1/2"
          />
          <span id={descriptionId} hidden>
            {checks}
          </span>
        </>
      )}
    </span>
  );
}
