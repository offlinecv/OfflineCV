// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FeedbackDialog — the multi-step feedback interstitial (#900).
 *
 * Replaces the inline `FeedbackPanel`, which sat below the score card and
 * quietly demoted to an unbordered star strip after two views — testers
 * reported they could not find or recognize it. This is a `Dialog`
 * (`@design-system`) instead: harder to miss, and it routes by sentiment
 * rather than showing every field to every rater.
 *
 * Step 1 is a bare star rating; picking one routes immediately (no separate
 * "next" click) to Step 2A (4-5★, `FeedbackPositiveStep`) or Step 2B (1-3★,
 * `FeedbackConstructiveStep`) — each split into its own file because it owns
 * its own form state, and together they'd push this file well past
 * CLAUDE.md's ~200 LOC feature-component ceiling.
 *
 * Open/close, the automatic-vs-ambient triggers, and the localStorage
 * capping all live in `useFeedbackDialog` (`src/hooks/`) — this component is
 * display + step routing + the actual `trackFeedback` call only.
 *
 * In-place confirmation only (issue §3 — no toast/snackbar): submitting from
 * either step 2 body lands on a terminal `thanks` step rather than closing.
 * A dialog that simply vanishes confirms nothing, and confirms it to a screen
 * reader least of all — so the thank-you is a focused `aria-live` region, the
 * same acknowledgement the retired `FeedbackPanel` gave. It closes only on the
 * user's own `Close`, matching `ExportDialog`: no dialog in this codebase
 * auto-dismisses.
 */

import { useEffect, useRef, useState } from "react";
import { Button, Dialog, StarRating } from "@design-system";
import { trackFeedback, type FeedbackArgs } from "../../lib/analytics.ts";
import { FeedbackPositiveStep } from "./FeedbackPositiveStep.tsx";
import { FeedbackConstructiveStep } from "./FeedbackConstructiveStep.tsx";

interface FeedbackDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful submission so the caller can persist
   *  `ocv_feedback_submitted` — see `useFeedbackDialog`. */
  onSubmitted: () => void;
}

type Step = "rating" | "positive" | "constructive" | "thanks";

const TITLES: Record<Step, string> = {
  rating: "How did your resume turn out?",
  positive: "Thank you! We're glad it helped.",
  constructive: "How can we make OfflineCV better?",
  thanks: "Feedback sent",
};

/** What the step bodies collect — everything but the rating, which the
 *  shell already knows from routing Step 1. */
type StepSubmission = Omit<FeedbackArgs, "rating">;

export function FeedbackDialog({ open, onClose, onSubmitted }: FeedbackDialogProps) {
  const [step, setStep] = useState<Step>("rating");
  const [rating, setRating] = useState(0);
  const thanksRef = useRef<HTMLDivElement>(null);

  // Fresh every time the dialog opens — a snoozed-then-reopened session
  // should never land on last time's step or rating.
  useEffect(() => {
    if (open) {
      setStep("rating");
      setRating(0);
    }
  }, [open]);

  // Submitting unmounts the button that was just activated, which would drop
  // focus to `<body>` — outside the dialog's tab ring — while the whole body
  // silently changes. Moving focus into the confirmation is also what makes a
  // screen reader announce that the submission landed.
  useEffect(() => {
    if (step === "thanks") thanksRef.current?.focus();
  }, [step]);

  function handleRate(value: number): void {
    setRating(value);
    setStep(value >= 4 ? "positive" : "constructive");
  }

  function handleSubmit(fields: StepSubmission): void {
    try {
      trackFeedback({ rating, ...fields });
    } catch {
      // Best-effort: capture() is fire-and-forget; still confirm below.
    }
    onSubmitted();
    setStep("thanks");
  }

  return (
    <Dialog open={open} onClose={onClose} title={TITLES[step]} className="max-w-md">
      {step === "rating" && (
        <div className="flex flex-col items-center gap-4 py-2">
          <p className="text-sm text-content-secondary">
            Tap a star to rate your experience.
          </p>
          <StarRating
            value={rating}
            onChange={handleRate}
            ariaLabel="Rate your resume experience from 1 to 5 stars"
          />
          <div className="flex w-full justify-end">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
      {step === "positive" && (
        <FeedbackPositiveStep
          onSubmit={handleSubmit}
          onBack={() => setStep("rating")}
          onClose={onClose}
        />
      )}
      {step === "constructive" && (
        <FeedbackConstructiveStep
          onSubmit={handleSubmit}
          onBack={() => setStep("rating")}
          onClose={onClose}
        />
      )}
      {step === "thanks" && (
        <div className="flex flex-col gap-4">
          <div
            ref={thanksRef}
            tabIndex={-1}
            aria-live="polite"
            className="flex flex-col gap-1 focus:outline-hidden"
          >
            <p className="text-sm font-semibold text-content-primary">
              Thanks for your feedback!
            </p>
            <p className="text-sm text-content-tertiary">
              It helps us improve OfflineCV.
            </p>
          </div>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
