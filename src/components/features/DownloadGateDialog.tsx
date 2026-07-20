// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * DownloadGateDialog — the pre-download checklist popover (#312).
 *
 * "Download PDF" on the reconstructed résumé used to export unconditionally,
 * even when the parse dropped a critical field (name / any contact method /
 * any experience entry). This is a soft guardrail, not a hard block: on
 * Download click with a gap, `ReconstructedResume` opens this dialog instead
 * of downloading immediately. The user either dismisses it and fixes the
 * field inline ("Fix now") or proceeds anyway ("Download anyway" — the
 * existing `download()` path, byte-for-byte unchanged).
 *
 * Reuse analysis (CLAUDE.md 3-tier rule), mirroring ConsentDialog:
 *   - Primitive: `Dialog` from `@design-system` owns the modal chrome, focus
 *     trap, Esc handling, and ARIA wiring. No raw `<dialog>` here.
 *   - Primitive: `Button` for both actions. No raw `<button>`.
 *   - Domain-specific composition (the missing-field list is résumé
 *     terminology), so it lives alongside `ConsentDialog` in
 *     `components/features/` rather than the domain-agnostic
 *     `design-system/shared/` tier.
 */

import { Button, Dialog } from "@design-system";
import type { CriticalMissingItem } from "../../lib/contact.ts";

interface DownloadGateDialogProps {
  open: boolean;
  /** Exactly the missing items to list — empty means the caller shouldn't
   *  have opened this dialog in the first place (nothing to show). */
  missing: readonly CriticalMissingItem[];
  /** Dismiss + scroll/focus the first gated field so the user can fix it
   *  inline. Re-clicking Download re-checks. */
  onFixNow: () => void;
  /** Proceed with the existing, unmodified `download()` path. */
  onDownloadAnyway: () => void;
  /** Esc / backdrop dismissal — treated the same as "Fix now" (stay put). */
  onClose: () => void;
}

export function DownloadGateDialog({
  open,
  missing,
  onFixNow,
  onDownloadAnyway,
  onClose,
}: DownloadGateDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Missing before download"
      className="max-w-sm"
    >
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1 text-sm text-content-secondary">
          {missing.map((item) => (
            <li key={item.key} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="text-feedback-warning-text"
              >
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
    </Dialog>
  );
}
