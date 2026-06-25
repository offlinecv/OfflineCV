// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * FeedbackPanel — inline, PostHog-backed feedback panel (#51).
 *
 * Renders below the score card on the results page. Collects a required 1–5
 * star rating plus an optional category, free text, and opt-in email, then
 * fires the `feedback_submitted` event. Anonymous by default — email is only
 * sent when the user types one (see `buildFeedbackProps`).
 *
 * Hidden entirely when analytics are disabled (`VITE_POSTHOG_KEY` unset): with
 * no sink, a submission would silently vanish, so we don't render the form at
 * all. This replaces the old thumbs-up/down `FeedbackControl` as the single
 * feedback surface (Reuse Gate — one owning surface, one `feedback_submitted`).
 *
 * Submission is best-effort: PostHog `capture()` is fire-and-forget, so any
 * error still transitions to the inline thank-you state.
 *
 * Design rules (CLAUDE.md): `Card` + `Button` + `StarRating` from
 * `@design-system`; semantic tokens only; explicit labels on every field.
 */

import { useEffect, useId, useRef, useState } from "react";
import { ANALYTICS_ENABLED, trackFeedback } from "../../lib/analytics.ts";
import { Card, Button, StarRating } from "@design-system";

const CATEGORIES = ["Parsing", "Scoring", "UI", "Other"] as const;
type Category = (typeof CATEGORIES)[number];

export function FeedbackPanel() {
  const [rating, setRating] = useState(0);
  const [category, setCategory] = useState<Category | "">("");
  const [feedbackText, setFeedbackText] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [ratingError, setRatingError] = useState(false);

  const errorId = useId();
  const textId = useId();
  const emailId = useId();
  const headingId = useId();
  const thanksRef = useRef<HTMLDivElement>(null);

  // Move focus to the thank-you region after a successful submission so
  // screen-reader users hear the confirmation.
  useEffect(() => {
    if (submitted) thanksRef.current?.focus();
  }, [submitted]);

  // No analytics sink → no panel (submissions would silently vanish).
  if (!ANALYTICS_ENABLED) return null;

  if (submitted) {
    return (
      <Card className="flex flex-col gap-1">
        <div ref={thanksRef} tabIndex={-1} className="outline-hidden">
          <p className="text-sm font-semibold text-content-primary">
            Thanks for your feedback!
          </p>
          <p className="text-sm text-content-tertiary">
            It helps us improve ResumeLint.
          </p>
        </div>
      </Card>
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) {
      // Reachable via Enter inside a text field even with Submit disabled.
      setRatingError(true);
      return;
    }
    setSubmitting(true);
    try {
      trackFeedback({
        rating,
        category: category || undefined,
        feedbackText,
        email,
      });
    } catch {
      // Best-effort: capture() is fire-and-forget; swallow and still thank.
    }
    setSubmitted(true);
  }

  return (
    <Card className="flex flex-col gap-4">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-0.5">
          <h2
            id={headingId}
            className="text-sm font-semibold text-content-primary"
          >
            How's ResumeLint working for you?
          </h2>
        </div>

        {/* Rating (required) */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-content-secondary">
            Your rating
          </span>
          <StarRating
            value={rating}
            onChange={(v) => {
              setRating(v);
              setRatingError(false);
            }}
            disabled={submitting}
            ariaLabel="Rate ResumeLint from 1 to 5 stars"
            ariaDescribedBy={ratingError ? errorId : undefined}
          />
          {ratingError && (
            <p
              id={errorId}
              role="alert"
              className="text-xs text-feedback-error-text"
            >
              Please select a rating before submitting.
            </p>
          )}
        </div>

        {/* Category (optional) */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-content-secondary">
            What area? (optional)
          </span>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => {
              const selected = category === c;
              return (
                <Button
                  key={c}
                  type="button"
                  variant={selected ? "primary" : "ghost"}
                  aria-pressed={selected}
                  disabled={submitting}
                  onClick={() => setCategory(selected ? "" : c)}
                  className="rounded-full border border-border-light px-3 py-1"
                >
                  {c}
                </Button>
              );
            })}
          </div>
        </div>

        {/* Free text (optional) */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor={textId}
            className="text-xs font-medium text-content-secondary"
          >
            Any other thoughts? (optional)
          </label>
          <textarea
            id={textId}
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            disabled={submitting}
            rows={3}
            placeholder="Tell us what worked, what didn't, or what you'd change…"
            className="w-full resize-y rounded border border-border-light bg-surface-card px-2 py-1.5 text-sm text-content-primary placeholder:text-content-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-amber"
          />
        </div>

        {/* Email (optional, opt-in) */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor={emailId}
            className="text-xs font-medium text-content-secondary"
          >
            Your email (optional)
          </label>
          <input
            id={emailId}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            placeholder="you@example.com"
            className="w-full rounded border border-border-light bg-surface-card px-2 py-1.5 text-sm text-content-primary placeholder:text-content-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-amber"
          />
          <span className="text-xs text-content-muted">
            Optional — only if you'd like a reply.
          </span>
        </div>

        <div>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={rating === 0 || submitting}
          >
            {submitting ? "Submitting…" : "Submit feedback"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
