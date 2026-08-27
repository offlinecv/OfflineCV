// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useFeedbackDialog — owns `FeedbackDialog`'s (#900) open state and its
 * localStorage-backed lifecycle: the automatic milestone trigger, the ambient
 * trigger, and the capping that keeps both well-behaved.
 *
 * A single instance is owned at page level (`App`), because the two ways in
 * — the ambient `[★ Feedback]` button (deep inside `ParsedHeader`) and the
 * automatic trigger (earned from `ExportDialog`'s résumé-only callback, also
 * page level) — both need to open the SAME dialog. Threading one controller
 * down covers both without two sources of truth for "is the dialog open".
 *
 * **The export milestone is earned and flushed at two different moments, on
 * purpose.** `ExportDialog` deliberately stays open after a download so the
 * row that produced the file can render its failure `error` and its #621
 * glyph findings — the #421 fix, spelled out in that file's docblock. Opening
 * from the export callback would stack a second native modal over it and pull
 * focus off that advisory, so `notifyResumeExported` only RECORDS the
 * milestone; `notifyExportClosed`, wired to the export dialog's own `onClose`,
 * is what opens the dialog.
 *
 * Persistence:
 *   ocv_feedback_dialog_seen — incremented once per real open (auto or
 *                             ambient). A dismissed prompt is still "seen",
 *                             so this doubles as the snooze: the automatic
 *                             trigger only fires while the dialog has never
 *                             been shown at all. Deliberately NOT the retired
 *                             `FeedbackPanel`'s `ocv_feedback_seen`, which
 *                             counted every mount of the results page — every
 *                             returning browser already holds a non-zero value
 *                             under that key, so reusing it would leave the
 *                             milestone trigger permanently dead for exactly
 *                             the repeat testers #900 exists for.
 *   ocv_feedback_submitted — set once a submission ships. Suppresses the
 *                             automatic trigger permanently; the ambient
 *                             button keeps working — a submitted user
 *                             reopening it on purpose is not spam. Shared with
 *                             the retired panel on purpose: a user who already
 *                             sent feedback should not be asked again.
 */

import { useRef, useState } from "react";
import { usePersistentCounter, usePersistentFlag } from "./usePersistentFlag.ts";

const LS_KEY_SEEN = "ocv_feedback_dialog_seen";
const LS_KEY_SUBMITTED = "ocv_feedback_submitted";

export interface FeedbackDialogController {
  open: boolean;
  /** Open on demand — the ambient `[★ Feedback]` trigger. */
  openDialog: () => void;
  close: () => void;
  /** Call once a PDF or Markdown export completes. Records the milestone the
   *  first time only (see the capping rules above); nothing opens until
   *  `notifyExportClosed` fires. */
  notifyResumeExported: () => void;
  /** Call from `ExportDialog`'s `onClose`. Opens the dialog if — and only if
   *  — a résumé export earned the milestone while it was open. */
  notifyExportClosed: () => void;
  /** Call once a submission has shipped via `trackFeedback` — persists the
   *  submitted flag so the automatic trigger never fires again. */
  markSubmitted: () => void;
}

export function useFeedbackDialog(): FeedbackDialogController {
  const [submitted, setSubmitted] = usePersistentFlag(LS_KEY_SUBMITTED, "");
  const [seenCount, incrementSeen] = usePersistentCounter(LS_KEY_SEEN);
  const [open, setOpen] = useState(false);
  // Guards a single auto-trigger per session even if two exports complete in
  // quick succession before `seenCount`'s state update is read back.
  const autoFiredRef = useRef(false);
  // The milestone, earned but not yet shown — see the two-moment note above.
  const pendingRef = useRef(false);

  function openDialog(): void {
    if (!open) incrementSeen();
    setOpen(true);
  }

  function notifyResumeExported(): void {
    if (submitted === "1") return;
    if (seenCount > 0) return; // already shown once — snoozed, not re-nagged
    if (autoFiredRef.current) return;
    autoFiredRef.current = true;
    pendingRef.current = true;
  }

  function notifyExportClosed(): void {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    openDialog();
  }

  function close(): void {
    setOpen(false);
  }

  function markSubmitted(): void {
    setSubmitted("1");
  }

  return {
    open,
    openDialog,
    close,
    notifyResumeExported,
    notifyExportClosed,
    markSubmitted,
  };
}
