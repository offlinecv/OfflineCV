// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Dialog — the ONE modal-dialog primitive.
 *
 * Built on the native `<dialog>` element so we inherit, for free:
 *   - ARIA `role="dialog"` and `aria-modal="true"` semantics
 *   - browser-managed focus trap (Tab cycles inside, can't escape to the page)
 *   - automatic Esc-to-close (with `onCancel` honored)
 *   - `::backdrop` pseudo-element for the dim overlay
 *
 * Drive open/close via the `open` prop — a `useEffect` calls `showModal()` /
 * `close()` so the browser's modality lifecycle stays in sync with React state.
 * The dialog's own `onClose` event (fires on Esc or programmatic close) is
 * forwarded to the `onClose` prop so consumers don't need a separate listener.
 * A programmatic-close ref flag swallows the redundant `close` event the
 * effect's own `dialog.close()` would otherwise re-emit — without it, a
 * consumer that does work in `onClose` (toggle state, abort a request) would
 * see it fire twice per user gesture (once from `handleCancel`, once from the
 * effect's close).
 *
 * Design rules (CLAUDE.md):
 *   – Semantic tokens only; no hardcoded hex or raw palette classes.
 *   – Never use raw `<dialog>` in feature code — import this primitive instead.
 *   – Pairs `aria-labelledby` with the `title` (when provided) so screen
 *     readers announce the dialog name. When no title, the caller MUST pass
 *     `aria-label` via the `ariaLabel` prop.
 */

import { useEffect, useId, useRef } from "react";
import type { ReactNode, SyntheticEvent } from "react";

interface DialogProps {
  /** Whether the modal is shown. Toggle from the caller. */
  open: boolean;
  /** Called when the user closes via Esc, the close button, or `cancel`. */
  onClose: () => void;
  /** Optional heading rendered at the top of the dialog. Pair with `aria-labelledby` automatically. */
  title?: string;
  /** Required when `title` is omitted — the accessible name for the dialog. */
  ariaLabel?: string;
  /**
   * Optional classes appended to the `<dialog>` element itself — caller-side
   * positioning/sizing (e.g. `fixed left-1/2 -translate-x-1/2`, max-width).
   * Use positioning/layout utilities only: the chrome (radius/border/bg/
   * padding) and the UA `dialog:not([open]){display:none}` rule that hides a
   * closed dialog stay owned by the primitive, so don't pass `display`/`hidden`
   * utilities here — they'd break the closed-state hide.
   */
  className?: string;
  children: ReactNode;
}

const CHROME =
  "rounded-xl border border-border-light bg-surface-card p-5 text-content-primary backdrop:bg-content-primary/40 backdrop:backdrop-blur-sm";

export function Dialog({
  open,
  onClose,
  title,
  ariaLabel,
  className,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // True while the effect's own `dialog.close()` runs, so the close event it
  // emits isn't re-forwarded to the caller's `onClose` (which already fired
  // upstream — `handleCancel` for Esc, a consumer button handler otherwise).
  const isProgrammaticCloseRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // showModal() is what gives us the focus trap + backdrop. Calling it
      // on an already-open dialog throws (InvalidStateError), so guard.
      dialog.showModal();
    } else if (!open && dialog.open) {
      isProgrammaticCloseRef.current = true;
      dialog.close();
    }
  }, [open]);

  // Native `<dialog>` fires `cancel` on Esc; the default behavior is to
  // close, but we preventDefault so the close goes through `onClose` — the
  // single source of truth for the controlled `open` state.
  function handleCancel(event: SyntheticEvent<HTMLDialogElement>): void {
    event.preventDefault();
    onClose();
  }

  function handleClose(): void {
    if (isProgrammaticCloseRef.current) {
      isProgrammaticCloseRef.current = false;
      return;
    }
    onClose();
  }

  const labelledBy = title ? titleId : undefined;
  const cls = className ? `${CHROME} ${className}` : CHROME;

  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClose={handleClose}
      aria-labelledby={labelledBy}
      aria-label={!title ? ariaLabel : undefined}
      className={cls}
    >
      {title && (
        <h2
          id={titleId}
          className="mb-3 text-sm font-semibold text-content-primary"
        >
          {title}
        </h2>
      )}
      {children}
    </dialog>
  );
}
