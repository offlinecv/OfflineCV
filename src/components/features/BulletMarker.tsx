// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * BulletMarker — the `•` in front of an editable bullet, plus a warning mark in
 * the gutter to its left when Fix It has a step for that bullet (#913), which is
 * the way into that step.
 *
 * It replaces the amber glyph chips that used to trail a flagged bullet, and
 * the legend beside the Experience heading that keyed them. Those sat inside
 * the résumé's own text, so the column could not be read as a preview of the
 * PDF. The reason lives where Fix It already shows it: the dock names the
 * failed check and how to fix it.
 *
 * Invariants:
 *  - The text column is the PDF's. Every bullet draws the same muted `•` in the
 *    same fixed-width box, flagged or not; the flag is a `⚠︎` hung in the
 *    card's left padding (`right-full`), outside the column. Swapping the `•`
 *    itself for a warning glyph read as a broken bullet.
 *  - Zero added width. The mark and the control are absolutely positioned, so
 *    a flagged bullet wraps like a passing one — and like the PDF.
 *  - Never colour-only (WCAG 1.4.1). A flagged bullet has a mark in the gutter
 *    where a passing one has none; the control's description
 *    (`aria-describedby`, and a `title` for the pointer) names the failed
 *    checks.
 *  - One mechanism. Whether the mark shows is whether `useFixItStep` finds a
 *    step, and activating it enters Fix It at that step. No second focus or
 *    highlight path, no second count.
 *  - The control's 24×24 target (WCAG 2.2 SC 2.5.8) is centred on the mark and
 *    ends at the `•`, so it never overlaps the bullet text's own
 *    click-to-edit target on its right (the #581/#591 class). It is marked
 *    `data-fixit-marker` so a step's focus skips it and lands on the text
 *    (`useFixItMode`'s `focusControl`).
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
    <span className="relative flex w-1.5 shrink-0 justify-center text-content-muted">
      <span aria-hidden="true">•</span>
      {step && (
        <>
          {/* U+26A0 + U+FE0E: text presentation, so it inherits the token
              colour instead of rendering as the OS emoji. */}
          <span
            aria-hidden="true"
            className="absolute top-1/2 right-full mr-1 -translate-y-1/2 text-xs text-feedback-warning-text"
          >
            ⚠︎
          </span>
          <Button
            variant="link"
            aria-label="Fix this bullet"
            aria-describedby={descriptionId}
            title={checks}
            data-fixit-marker
            onClick={step.enter}
            className="absolute top-1/2 -left-5.5 h-6 w-6 -translate-y-1/2"
          />
          <span id={descriptionId} hidden>
            {checks}
          </span>
        </>
      )}
    </span>
  );
}
