// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ExportGateBody — the pre-download checklist (#312), and the "fix it now" jump
 * that answers it.
 *
 * A sibling of `ExportDialog` rather than a section inside it: the dialog owns
 * "which body am I showing" and the three download hooks, this owns one body and
 * nothing else. It shares no state with its parent — `missing` in, two callbacks
 * out — so the split costs nothing and keeps `ExportDialog` under the ~200 LOC
 * ceiling CLAUDE.md sets.
 *
 * **The gate is soft, and it is re-derived per click.** `Fix now` /
 * `Download anyway` mean exactly what they meant in the deleted
 * `DownloadGateDialog`; the checklist just renders in the export dialog rather
 * than opening a second overlay on top of it. The parent recomputes `missing`
 * from the current override-applied fields on every click, so an edit made via
 * `Fix now` clears the item on the next one with no extra plumbing.
 */

import { useEffect, useRef } from "react";
import { Button } from "@design-system";
import type { CriticalMissingItem } from "../../lib/contact.ts";
import { SECTION_IDS, scrollToSection, prefersReducedMotion } from "../../lib/anchors.ts";

export function ExportGateBody({
  missing,
  onFixNow,
  onDownloadAnyway,
}: {
  missing: readonly CriticalMissingItem[];
  onFixNow: () => void;
  onDownloadAnyway: () => void;
}) {
  // Clicking `Download PDF` unmounts the whole format list — including the
  // button that was just activated — and replaces it with this. Without moving
  // focus it lands on `<body>`: a keyboard user is outside the dialog's tab
  // ring and a screen-reader user is told nothing, while the dialog's title has
  // silently become "Missing before download" and a blocker list has appeared.
  // `aria-live` on the wrapper announces the swap; the focus move is what makes
  // `Fix now` / `Download anyway` reachable by Tab from where the user is.
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    wrapper.current?.focus();
  }, []);

  return (
    <div
      ref={wrapper}
      tabIndex={-1}
      aria-live="polite"
      className="flex flex-col gap-3 focus:outline-hidden"
    >
      <ul className="flex flex-col gap-1 text-sm text-content-secondary">
        {missing.map((item) => (
          <li key={item.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-feedback-warning-text">
              •
            </span>
            {item.label}
          </li>
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onFixNow}>
          Fix now
        </Button>
        <Button variant="primary" size="sm" onClick={onDownloadAnyway}>
          Download anyway
        </Button>
      </div>
    </div>
  );
}

/**
 * Scroll to + enter edit mode on the first gated field the checklist named.
 *
 * Name/Contact both surface via `EditableField` inside ContactCard, whose
 * accessible name is `Edit <label>` (see ContactDetails.tsx) — targeted through
 * that rather than by threading new refs through the contact-card tree.
 * Experience has no single inline field to aim at (it is the "+ Add experience"
 * pill), so a missing-experience-only gate just scrolls to the résumé.
 */
export function fixFirstGap(missing: readonly CriticalMissingItem[]): void {
  const first = missing[0];
  if (!first) return;
  const targetLabel =
    first.key === "full_name" ? "Name" : first.key === "contact" ? "Email" : null;
  // Defer past the dialog's own close so focus isn't immediately stolen back.
  requestAnimationFrame(() => {
    if (!targetLabel) {
      scrollToSection(SECTION_IDS.reconstructed);
      return;
    }
    const target = document.querySelector<HTMLElement>(
      `[aria-label="Edit ${targetLabel}"]`,
    );
    // Same motion preference `scrollToSection` honours — this one aims at a
    // field rather than a section, so it cannot go through that helper.
    target?.scrollIntoView?.({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    });
    target?.focus();
    target?.click();
  });
}
