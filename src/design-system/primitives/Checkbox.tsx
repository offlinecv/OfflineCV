// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Checkbox — the ONE labelled boolean-toggle primitive.
 *
 * Owns the raw `<input type="checkbox">` + its `<label>` pairing so feature
 * code never hand-rolls one. Extracted for #608's "use the quality findings"
 * opt-out, which would otherwise have been the THIRD verbatim copy of the same
 * six lines — `DownloadReportDialog` ("Include my name and contact details")
 * and `FeedbackPanel` already carried it, both with the identical
 * `h-4 w-4 accent-accent-primary` input inside a `flex … gap-2` label.
 *
 * The first of those two took the swap in #823, when `DownloadReportDialog`
 * was folded into `ExportDialog` and the markup-querying tests that had made a
 * migration awkward went with it. `FeedbackPanel` is still unmigrated: an
 * unrelated surface whose own tests query the raw markup, so it belongs in its
 * own change. This primitive renders the same real `<input type="checkbox">`
 * it does, so that migration stays a mechanical swap.
 *
 * Not a switch: this is a checkbox by role and by semantics (a setting that
 * takes effect on the next action, not an immediately-applied mode). A `Switch`
 * would be a second primitive for one concern — see the root CLAUDE.md's
 * "exactly one primitive per concern".
 *
 * Design rules (CLAUDE.md): semantic tokens only; no hardcoded hex or raw
 * palette classes. `min-h-9` keeps the hit target reachable on touch.
 */

import { useId } from "react";

interface CheckboxProps {
  /** Controlled checked state. */
  checked: boolean;
  /** Called with the next checked state on toggle. */
  onChange: (checked: boolean) => void;
  /** Visible label text, rendered beside the box and part of the hit target. */
  label: string;
  /**
   * Optional second line under the label — the "what this actually does"
   * explanation. Sits inside the `<label>` so clicking it still toggles.
   */
  hint?: string;
  /** When true, the input is non-interactive and the row is dimmed. */
  disabled?: boolean;
  /** Extra classes on the root label (layout stays with the caller). */
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  className,
}: CheckboxProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={[
        "flex min-h-9 cursor-pointer items-start gap-2 text-sm",
        "text-content-secondary",
        disabled ? "cursor-not-allowed opacity-60" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        // `mt-0.5` optically centres the box against the first line of a
        // two-line (label + hint) row; with `items-start` it would otherwise
        // sit flush with the cap height.
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent-primary"
      />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {hint && <span className="text-2xs text-content-muted">{hint}</span>}
      </span>
    </label>
  );
}
