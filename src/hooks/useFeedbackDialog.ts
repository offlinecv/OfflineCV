// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useFeedbackDialog — owns `FeedbackDialog`'s (#900) open state, the
 * non-modal `FeedbackNudge`'s visibility (#912), and the localStorage-backed lifecycle
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
 * So the milestone now shows a non-modal, dismissible star row. Picking a star
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
 * ## One ask per résumé, with a short global cooldown (#912, #1005)
 *
 * #900 gated the automatic trigger on `seenCount > 0` — shown once, ever, and
 * never again. Worse, `openDialog()` incremented that same counter, so a user
 * who clicked the ambient button out of curiosity permanently disabled the
 * automatic ask. The issue this replaced was filed because the old inline
 * panel nagged; the fix overshot into near-silence.
 *
 * A new résumé is a new experience to rate, so eligibility is keyed on the
 * parse (`parseKey` — the pristine-parse fingerprint `App` already derives for
 * the journey ledger, an 8-hex hash, never résumé text), with a short global
 * cooldown behind it as the anti-nag backstop:
 *
 *   ocv_feedback_asked       — JSON array of the parse keys we have asked
 *                              about, newest last, capped at
 *                              `ASKED_PARSES_CAP`. The same résumé is never
 *                              asked about twice, across reloads too.
 *   ocv_feedback_prompted_at — epoch ms of the last UNPROMPTED ask, whatever
 *                              the résumé. Absent means never asked.
 *   ocv_feedback_submitted   — set once a submission ships. Permanent kill
 *                              switch for the automatic ask; the ambient button
 *                              keeps working, since a submitted user reopening
 *                              it on purpose is not spam. Shared with the
 *                              retired `FeedbackPanel` on purpose: someone who
 *                              already wrote in should not be asked again.
 *
 * Only a milestone writes the first two; an ambient open never does, because a
 * user opening the dialog themselves is not us asking them.
 *
 * `ocv_feedback_dialog_seen` (#900's counter) is deliberately NOT read. A
 * returning browser holds a non-zero value under it, and honouring that would
 * keep the lifetime cap alive for exactly the repeat testers this change is
 * for — so those browsers become eligible once, then fall under the per-parse
 * rule like everyone else. That one extra ask is the intended cost of
 * loosening the cap, not an oversight.
 *
 * ## Two milestones, one slot (#1005)
 *
 * A résumé export, and finishing Fix It (`FixItFinished`, #810 — either way
 * in). Neither renders the nudge in the page flow: since #955/#1000 the top of
 * `/` is the docked score card and the export dialog opens from the sticky
 * header, so a block above `<Result>` is off-screen for a scrolled user and
 * shoves the score card down for everyone else. The nudge lives in the fixed
 * bottom dock instead — inside Fix It's own dock while that is mounted (it
 * registers itself through `registerNudgeHost`), in a dock of its own
 * otherwise. Either way it is visible wherever the user is and moves nothing.
 *
 * The nudge belongs to the parse that raised it: `nudgeVisible` is true only
 * while that same `parseKey` is on screen, so an ask earned by résumé A cannot
 * surface on résumé B.
 */

import { createContext, useCallback, useRef, useState } from "react";
import { usePersistentFlag } from "./usePersistentFlag.ts";

const LS_KEY_PROMPTED_AT = "ocv_feedback_prompted_at";
const LS_KEY_ASKED = "ocv_feedback_asked";
const LS_KEY_SUBMITTED = "ocv_feedback_submitted";

/**
 * The minimum gap between two unprompted asks, whatever résumé they are about.
 *
 * One hour. The per-parse rule already stops the same résumé being asked about
 * twice, so this guards only against a burst: a tester dropping five résumés in
 * a sitting is asked about the first, not all five back to back. A day would
 * swallow exactly the multi-résumé testing session #1005 wants each résumé of
 * rated; fourteen days (#912's first cut) was a lifetime cap in practice for
 * anyone testing in weekly rounds.
 *
 * Module-private: nothing outside needs it, and the tests deliberately drive
 * timestamps well inside and well outside the window rather than deriving from
 * this value — a test that computes its fixture from the constant it is
 * checking passes for any constant, this one included.
 */
const FEEDBACK_COOLDOWN_MS = 60 * 60 * 1000;

/** How many asked-about parse keys to remember. Far more than one browser
 *  parses in practice; the cap exists so the key cannot grow without bound. */
const ASKED_PARSES_CAP = 50;

export interface FeedbackDialogController {
  open: boolean;
  /** The rating the dialog should open on, or 0 to start at the star step.
   *  Non-zero only when the nudge's own stars were used — see `openDialog`. */
  initialRating: number;
  /** True while the nudge should render — only for the parse that raised it. */
  nudgeVisible: boolean;
  /** True while a Fix It dock is mounted and hosting the nudge, so the page
   *  must not draw a second dock for it. */
  nudgeHosted: boolean;
  /** Open on demand, at the star step — the ambient `[★ Feedback]` buttons.
   *  Takes NO argument, on purpose: it is handed straight to a `Button`'s
   *  `onClick`, which calls it with the click event, so an optional parameter
   *  here would receive a `MouseEvent` as a "rating". */
  openDialog: () => void;
  /** Open from a star picked on the nudge, so the dialog opens on the branch
   *  the user already chose rather than asking them to pick again. */
  rateFromNudge: (rating: number) => void;
  close: () => void;
  /** Dismiss the nudge without opening anything — a real answer ("not now"). */
  dismissNudge: () => void;
  /** Call once a PDF or Markdown export completes. Arms the nudge if this parse
   *  is eligible; nothing appears until `notifyExportClosed`. */
  notifyResumeExported: () => void;
  /** Call from `ExportDialog`'s `onClose`. Shows the nudge if — and only if —
   *  a résumé export armed it, for this parse, while that dialog was open. */
  notifyExportClosed: () => void;
  /** Call when Fix It reaches its finished state. Nothing is covering the
   *  page, so the nudge shows at once if this parse is eligible. */
  notifyFixItFinished: () => void;
  /** Mark a Fix It dock as the nudge's host while it is mounted. Returns the
   *  unregister. Stable identity, so it can sit in an effect's deps. */
  registerNudgeHost: () => () => void;
  /** Call once a submission has shipped via `trackFeedback` — persists the
   *  submitted flag so the automatic ask never fires again. */
  markSubmitted: () => void;
}

/** What a dock needs to host the nudge — the slice `FeedbackNudgeSlot` reads. */
export type FeedbackNudgeController = Pick<
  FeedbackDialogController,
  | "nudgeVisible"
  | "rateFromNudge"
  | "dismissNudge"
  | "notifyFixItFinished"
  | "registerNudgeHost"
>;

/**
 * Carries the page's controller down to Fix It's dock, which sits inside
 * `Result` → `FixItScope` → `FixItToolbar` — three components that otherwise
 * know nothing about feedback. Null outside `App` (the authoring lane, tests),
 * where the dock simply hosts no nudge.
 */
export const FeedbackNudgeContext =
  createContext<FeedbackNudgeController | null>(null);

/**
 * @param parseKey the résumé on screen, as a persistable string, or null when
 *   no parsed résumé is (parsing, authoring from scratch). Null is never asked.
 */
export function useFeedbackDialog(
  parseKey: string | null,
): FeedbackDialogController {
  const [submitted, setSubmitted] = usePersistentFlag(LS_KEY_SUBMITTED, "");
  const [promptedAt, setPromptedAt] = usePersistentFlag(LS_KEY_PROMPTED_AT, "");
  const [asked, setAsked] = usePersistentFlag(LS_KEY_ASKED, "");
  const [open, setOpen] = useState(false);
  const [initialRating, setInitialRating] = useState(0);
  // The parse the nudge was raised for. Visibility is derived from it rather
  // than stored as a boolean, so a new résumé hides it by construction — no
  // reset effect, and no committed frame where A's ask sits over B.
  const [nudgeFor, setNudgeFor] = useState<string | null>(null);
  const [hosts, setHosts] = useState(0);
  // Parses asked about in this session, read synchronously — two milestones in
  // one tick (StrictMode's double effect, an export racing Fix It) must not
  // both pass before the persisted list is read back.
  const askedRef = useRef(new Set<string>());
  // The export milestone, earned but not yet shown, and for which parse — see
  // the two-moment note above.
  const pendingRef = useRef<string | null>(null);

  function eligible(key: string | null): key is string {
    if (key === null || submitted === "1") return false;
    if (askedRef.current.has(key) || readAsked(asked).includes(key)) {
      return false;
    }
    return cooldownElapsed(promptedAt);
  }

  // The cooldown and the per-parse record start when the ask becomes VISIBLE,
  // not when it is answered. A nudge the user ignored is still an ask they
  // received, and re-asking because they ignored it is the nagging this
  // exists to prevent.
  function raise(key: string): void {
    askedRef.current.add(key);
    setAsked(
      JSON.stringify([...readAsked(asked), key].slice(-ASKED_PARSES_CAP)),
    );
    setPromptedAt(String(Date.now()));
    setNudgeFor(key);
  }

  function openAt(rating: number): void {
    setInitialRating(rating);
    setOpen(true);
    // Opening answers the nudge; leaving it on screen behind the dialog would
    // offer the same stars twice.
    setNudgeFor(null);
  }

  // Deliberately ignores whatever it is called with — see the interface.
  function openDialog(): void {
    openAt(0);
  }

  function rateFromNudge(rating: number): void {
    openAt(rating);
  }

  function notifyResumeExported(): void {
    if (pendingRef.current === parseKey) return;
    if (eligible(parseKey)) pendingRef.current = parseKey;
  }

  function notifyExportClosed(): void {
    const key = pendingRef.current;
    pendingRef.current = null;
    // Re-checked, not trusted: Fix It may have asked about this parse while the
    // export dialog was open, and the parse may have changed under it.
    if (key !== null && key === parseKey && eligible(key)) raise(key);
  }

  function notifyFixItFinished(): void {
    if (eligible(parseKey)) raise(parseKey);
  }

  const registerNudgeHost = useCallback(() => {
    setHosts((n) => n + 1);
    return () => setHosts((n) => n - 1);
  }, []);

  function dismissNudge(): void {
    setNudgeFor(null);
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
    nudgeVisible: nudgeFor !== null && nudgeFor === parseKey,
    nudgeHosted: hosts > 0,
    openDialog,
    rateFromNudge,
    close,
    dismissNudge,
    notifyResumeExported,
    notifyExportClosed,
    notifyFixItFinished,
    registerNudgeHost,
    markSubmitted,
  };
}

/** The stored asked-about list; anything unreadable reads as empty — the same
 *  fail-open rule as `cooldownElapsed`. */
function readAsked(raw: string): string[] {
  if (raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * True when enough time has passed since the last unprompted ask — including
 * the never-asked case, and including a stored value this build cannot parse.
 *
 * An unreadable or future-dated timestamp resolves to "may ask", not "may not". The competing
 * failure modes are one extra invitation against a permanently silent one, and
 * a corrupt key that locks a user out of ever being asked is precisely the
 * bug #912 was filed about, arrived at by a different route.
 */
function cooldownElapsed(promptedAt: string): boolean {
  if (promptedAt === "") return true;
  const at = Number.parseInt(promptedAt, 10);
  if (!Number.isFinite(at)) return true;
  const since = Date.now() - at;
  // A timestamp in the future (a clock set back, a hand-edited key) would
  // otherwise hold the ask off until that date — possibly forever.
  if (since < 0) return true;
  return since >= FEEDBACK_COOLDOWN_MS;
}
