// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useFeedbackDialog — owns `FeedbackDialog`'s (#900) open state, the inline
 * `FeedbackNudge`'s visibility (#912), and the localStorage-backed lifecycle
 * that decides when we are allowed to ask at all.
 *
 * A single instance is owned at page level (`App`), because every way in — the
 * ambient `[★ Feedback]` button deep inside `ParsedHeader`, the nudge, and the
 * export milestone that raises the nudge — has to reach the SAME dialog.
 *
 * ## The milestone raises a NUDGE, not the dialog (#912)
 *
 * #900 opened the dialog itself here, and that was the one part of its design
 * running against the strongest guidance available: NN/g's *User-Feedback
 * Requests* endorses asking after task completion and keeping an
 * always-available way in — both of which we do — while explicitly
 * discouraging modal popups for the ask. A native `showModal()` carries a
 * browser focus trap, so an automatic open takes keyboard focus off whatever
 * the user was doing, unprompted, and announces itself to a screen reader as
 * an interruption. For an *invitation* that is the wrong instrument.
 *
 * So the milestone now shows an inline, dismissible star row. Picking a star
 * opens the dialog — user-initiated, which is exactly when a modal is fine.
 *
 * That also collapses the two-moment dance #900 needed. `ExportDialog` stays
 * open after a download on purpose (#421), so #900 had to RECORD the milestone
 * in `notifyResumeExported` and only open it from `notifyExportClosed`, or it
 * would stack a second native modal over the findings the download had just
 * produced. A non-modal nudge cannot stack, so both callbacks remain only
 * because the nudge should not appear *behind* the export dialog either — the
 * user would never see it arrive.
 *
 * ## Cooldown, not a lifetime cap (#912)
 *
 * #900 gated the automatic trigger on `seenCount > 0` — shown once, ever, and
 * never again. Worse, `openDialog()` incremented that same counter, so a user
 * who clicked the ambient button out of curiosity permanently disabled the
 * automatic ask. The issue this replaced was filed because the old inline
 * panel nagged; the fix overshot into near-silence.
 *
 * The standing recommendation is a global cooldown rather than a permanent
 * lock, so:
 *
 *   ocv_feedback_prompted_at — epoch ms of the last time we asked
 *                              UNPROMPTED. Only the nudge writes it; an
 *                              ambient open never does, because a user opening
 *                              the dialog themselves is not us asking them.
 *                              Absent means never asked.
 *   ocv_feedback_submitted   — set once a submission ships. Permanent kill
 *                              switch for the automatic ask; the ambient button
 *                              keeps working, since a submitted user reopening
 *                              it on purpose is not spam. Shared with the
 *                              retired `FeedbackPanel` on purpose: someone who
 *                              already wrote in should not be asked again.
 *
 * `ocv_feedback_dialog_seen` (#900's counter) is deliberately NOT read. A
 * returning browser holds a non-zero value under it, and honouring that would
 * keep the lifetime cap alive for exactly the repeat testers this change is
 * for — so those browsers become eligible once, then fall under the cooldown
 * like everyone else. That one extra ask is the intended cost of loosening the
 * cap, not an oversight.
 */

import { useRef, useState } from "react";
import { usePersistentFlag } from "./usePersistentFlag.ts";

const LS_KEY_PROMPTED_AT = "ocv_feedback_prompted_at";
const LS_KEY_SUBMITTED = "ocv_feedback_submitted";

/**
 * How long after an unprompted ask before we may ask again.
 *
 * Fourteen days: long enough that a tester working through several résumés in
 * one week is asked once rather than each time, short enough that someone who
 * dismissed it while busy is reachable in the next round of testing. A number
 * rather than a `seen < N` count on purpose — the failure mode being fixed is
 * asking too often, and only elapsed time measures that.
 *
 * Module-private: nothing outside needs it, and the tests deliberately drive
 * timestamps well inside and well outside the window rather than deriving from
 * this value — a test that computes its fixture from the constant it is
 * checking passes for any constant, this one included.
 */
const FEEDBACK_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export interface FeedbackDialogController {
  open: boolean;
  /** The rating the dialog should open on, or 0 to start at the star step.
   *  Non-zero only when the nudge's own stars were used — see `openDialog`. */
  initialRating: number;
  /** True while the inline nudge should render (#912). */
  nudgeVisible: boolean;
  /** Open on demand. `rating` carries a star picked on the nudge, so the
   *  dialog opens on the branch the user already chose rather than asking
   *  them to pick again. */
  openDialog: (rating?: number) => void;
  close: () => void;
  /** Dismiss the nudge without opening anything — a real answer ("not now"),
   *  and it starts the cooldown the same as showing it did. */
  dismissNudge: () => void;
  /** Call once a PDF or Markdown export completes. Arms the nudge if the
   *  cooldown allows; nothing appears until `notifyExportClosed`. */
  notifyResumeExported: () => void;
  /** Call from `ExportDialog`'s `onClose`. Shows the nudge if — and only if —
   *  a résumé export armed it while that dialog was open. */
  notifyExportClosed: () => void;
  /** Call once a submission has shipped via `trackFeedback` — persists the
   *  submitted flag so the automatic ask never fires again. */
  markSubmitted: () => void;
}

export function useFeedbackDialog(): FeedbackDialogController {
  const [submitted, setSubmitted] = usePersistentFlag(LS_KEY_SUBMITTED, "");
  const [promptedAt, setPromptedAt] = usePersistentFlag(LS_KEY_PROMPTED_AT, "");
  const [open, setOpen] = useState(false);
  const [initialRating, setInitialRating] = useState(0);
  const [nudgeVisible, setNudgeVisible] = useState(false);
  // Guards a single arm per session even if two exports complete in quick
  // succession before the persisted timestamp is read back.
  const armedRef = useRef(false);
  // The milestone, earned but not yet shown — see the two-moment note above.
  const pendingRef = useRef(false);

  function openDialog(rating = 0): void {
    setInitialRating(rating);
    setOpen(true);
    // Opening from the nudge answers it; leaving it on screen behind the
    // dialog would offer the same stars twice.
    setNudgeVisible(false);
  }

  function notifyResumeExported(): void {
    if (submitted === "1") return;
    if (!cooldownElapsed(promptedAt)) return;
    if (armedRef.current) return;
    armedRef.current = true;
    pendingRef.current = true;
  }

  function notifyExportClosed(): void {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    // The cooldown starts when the ask becomes VISIBLE, not when it is
    // answered. A nudge the user scrolled past is still an ask they received,
    // and re-asking tomorrow because they ignored it is the nagging this
    // exists to prevent.
    setPromptedAt(String(Date.now()));
    setNudgeVisible(true);
  }

  function dismissNudge(): void {
    setNudgeVisible(false);
  }

  function close(): void {
    setOpen(false);
  }

  function markSubmitted(): void {
    setSubmitted("1");
  }

  return {
    open,
    initialRating,
    nudgeVisible,
    openDialog,
    close,
    dismissNudge,
    notifyResumeExported,
    notifyExportClosed,
    markSubmitted,
  };
}

/**
 * True when enough time has passed since the last unprompted ask — including
 * the never-asked case, and including a stored value this build cannot parse.
 *
 * An unreadable timestamp resolves to "may ask", not "may not". The competing
 * failure modes are one extra invitation against a permanently silent one, and
 * a corrupt key that locks a user out of ever being asked is precisely the
 * bug #912 was filed about, arrived at by a different route.
 */
function cooldownElapsed(promptedAt: string): boolean {
  if (promptedAt === "") return true;
  const at = Number.parseInt(promptedAt, 10);
  if (!Number.isFinite(at)) return true;
  return Date.now() - at >= FEEDBACK_COOLDOWN_MS;
}
