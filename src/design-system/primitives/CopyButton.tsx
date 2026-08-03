// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * CopyButton — a {@link Button} that writes `value` to the clipboard and
 * reports the outcome in its own label (#609).
 *
 * The house confirmation pattern, applied to the one action that had been
 * hand-rolled three times: this design system ships no toast
 * (design-system/CLAUDE.md), so a completed action confirms by swapping the
 * content of the control the user just pressed. The swap is announced through
 * an `sr-only` `aria-live="polite"` region (precedent: `ReconstructedSkills`,
 * `SkillTermGuidance`) — the label change alone reaches a sighted user and
 * nobody else — and meaning is carried by the WORD, never by colour.
 *
 * ── The live region duplicates the label, knowingly (#732 review) ──
 *
 * When the button carries no `aria-label`, its visible text IS its accessible
 * name, so a screen reader focused on it may announce the change itself — and
 * then again from the live region. That redundancy is the deliberate choice
 * over both alternatives:
 *
 *   - **Drop the region.** Accessible-name-change announcement is inconsistent
 *     across screen readers, so this trades a possible double-announcement for
 *     a possible SILENT one — worse for an action whose whole feedback is the
 *     confirmation. It also breaks the one call site that is not redundant at
 *     all: `WebGpuUnavailableNotice`'s `CopyablePath` passes a fixed
 *     `aria-label` ("Copy chrome://flags"), so its name never changes and the
 *     region is the ONLY channel it has.
 *   - **Keep the name fixed and swap only the visible text.** Then the visible
 *     label reads "Copied" while the accessible name still says "Copy prompt",
 *     which is what WCAG 2.5.3 Label in Name exists to prevent — a speech-input
 *     user saying "click Copied" would hit nothing.
 *
 * Announcing twice is the least-bad of the three. If this is ever revisited, it
 * needs profiling against real screen readers, not a re-reading of the spec.
 *
 * Renders a fragment, not a wrapper: every call site puts this inside a flex
 * row it already sizes, and the live region is `sr-only` (absolutely
 * positioned), so it contributes no box. Layout stays with the caller, matching
 * `Button` / `TextAreaField`.
 *
 * A caller that needs the failure to render somewhere other than the label —
 * `LetterRevealDialog` puts a full "select the text above and copy it
 * yourself" sentence beside its button — should use {@link useCopyToClipboard}
 * directly and keep its own markup. Both halves come from the same module pair,
 * so there is still exactly one clipboard implementation in the tree.
 */

import type { ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button.tsx";
import { useCopyToClipboard } from "./useCopyToClipboard.ts";

interface CopyButtonProps {
  /**
   * The text to copy. Read at click time, so a caller may recompute it on
   * every render (the exported rewrite prompt does — it tracks live steering).
   */
  value: string;
  /** Idle label — what the button offers to do. */
  children: ReactNode;
  /** Label held after a successful copy. */
  copiedLabel?: ReactNode;
  /**
   * Label held after a failed copy. The default states the outcome only;
   * a caller whose text stays selectable on screen should say so here, since
   * "select it yourself" is a real instruction rather than a shrug.
   */
  failedLabel?: ReactNode;
  /** Clear the confirmation after this many ms. See `useCopyToClipboard`. */
  resetAfterMs?: number;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  disabled?: boolean;
  /** Accessible name. Defaults to the button's own label text. */
  "aria-label"?: string;
}

export function CopyButton({
  value,
  children,
  copiedLabel = "Copied",
  failedLabel = "Couldn’t copy",
  resetAfterMs,
  variant = "ghost",
  size = "sm",
  className,
  disabled,
  "aria-label": ariaLabel,
}: CopyButtonProps) {
  const { state, copy } = useCopyToClipboard(resetAfterMs);

  const label =
    state === "copied" ? copiedLabel : state === "failed" ? failedLabel : children;

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => copy(value)}
      >
        {label}
      </Button>
      {/* Rendered unconditionally (empty while idle): a live region has to be
          in the DOM BEFORE its content changes, or assistive tech has nothing
          to observe and the first copy announces nothing. */}
      <span className="sr-only" role="status" aria-live="polite">
        {state === "idle" ? "" : label}
      </span>
    </>
  );
}
