// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * FeedbackPanel — inline, PostHog-backed feedback panel (#51, #193).
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
 * ## Render-state machine (#193)
 *
 * State is computed once at mount from localStorage; it never changes mid-session.
 *
 * | mode     | condition                          | render                         |
 * |----------|------------------------------------|--------------------------------|
 * | "done"   | submitted flag set                 | null                           |
 * | "full"   | not submitted AND seen count < 2   | full amber Card (current)      |
 * | "compact"| not submitted AND seen count >= 2  | quiet inline star strip        |
 *
 * localStorage keys:
 *   rl_feedback_seen      — integer, incremented once per real mount
 *   rl_feedback_submitted — "1" once handleSubmit succeeds
 *
 * Design rules (CLAUDE.md): `Card` + `Button` + `StarRating` from
 * `@design-system`; semantic tokens only; explicit labels on every field.
 */

import { useEffect, useId, useRef, useState } from "react";
import { ANALYTICS_ENABLED, trackFeedback } from "../../lib/analytics.ts";
import { Card, Button, StarRating, GitHubStarCta } from "@design-system";
import {
  usePersistentFlag,
  usePersistentCounter,
} from "../../hooks/usePersistentFlag.ts";
import { useGitHubStars } from "../../hooks/useGitHubStars.ts";
import { useReportGap } from "../../hooks/useReportGap.ts";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { ParseDisagreement } from "../../lib/heuristics/disagreement.ts";

/**
 * StarCtaOnce — renders the `card` variant of `GitHubStarCta` and fires
 * `onSeen` once on mount so the parent can persist the one-time flag.
 * Kept local to this file because it is only meaningful in the
 * post-submission thank-you surface.
 */
function StarCtaOnce({
  onSeen,
  starCount,
}: {
  onSeen: () => void;
  starCount: number | undefined;
}) {
  // Fire `onSeen` exactly once on mount to set the one-time localStorage flag.
  // The empty dep array is intentional: `onSeen` identity is stable (it wraps
  // `setStarCtaSeen` from usePersistentFlag which never changes reference).
  useEffect(() => {
    onSeen();
  }, []); // intentional one-shot mount effect
  return <GitHubStarCta variant="card" count={starCount} />;
}

const CATEGORIES = ["Parsing", "Scoring", "UI", "Other"] as const;
type Category = (typeof CATEGORIES)[number];

// localStorage key constants (internal — only used within this module).
const LS_KEY_SEEN = "rl_feedback_seen";
const LS_KEY_SUBMITTED = "rl_feedback_submitted";
// One-time star CTA seen flag (set when shown after a 4–5★ submission).
const LS_KEY_STAR_CTA_SEEN = "rl_star_cta_seen";

interface FeedbackPanelProps {
  /** The active parse result. When provided, the "Report a parsing gap"
   *  affordance is rendered (it builds a structure-only repro artifact from it).
   *  Absent on surfaces that have no parse (the gap report needs one). */
  result?: CascadeResult;
  /** Characterized disagreements from the opt-in WebLLM pass (#242/#245), so a
   *  WebLLM user reports a *characterized* gap. Empty/omitted when the user
   *  hasn't run the comparison — the report still works, just without them. */
  disagreements?: readonly ParseDisagreement[];
}

/**
 * FeedbackPanel — the one owning feedback surface. Composes two independent
 * sections:
 *   - the star-rating form (analytics-gated: no sink → no form)
 *   - the "Report a parsing gap" affordance (#245), which is a LOCAL download
 *     and works regardless of analytics (only its count-only telemetry is gated)
 *
 * Reuse-gate: the gap-report extends THIS surface rather than adding a parallel
 * feedback component (CLAUDE.md). The two sections render independently so the
 * gap report still appears in a keyless OSS build where the rating form does not.
 */
export function FeedbackPanel({ result, disagreements }: FeedbackPanelProps = {}) {
  return (
    <>
      <FeedbackRatingForm />
      {result && (
        <ReportGapSection result={result} disagreements={disagreements} />
      )}
    </>
  );
}

function FeedbackRatingForm() {
  // ── Persistent state ──────────────────────────────────────────────────────
  const [persistedSubmitted, setPersistedSubmitted] = usePersistentFlag(
    LS_KEY_SUBMITTED,
    "",
  );
  const [seenCount, incrementSeen] = usePersistentCounter(LS_KEY_SEEN);
  const [starCtaSeen, setStarCtaSeen] = usePersistentFlag(
    LS_KEY_STAR_CTA_SEEN,
    "",
  );

  // Star count for the post-feedback CTA (fail-silent — undefined if API errors).
  const { count: starCount } = useGitHubStars();

  // ── Render-state: computed once at mount, never mutated mid-session ───────
  // "done"    → already submitted (persisted)
  // "full"    → not submitted AND first/second parse (seen < 2)
  // "compact" → not submitted AND repeat user (seen >= 2)
  const isSubmittedPersisted = persistedSubmitted === "1";
  type Mode = "full" | "compact" | "done";
  const initialMode: Mode = isSubmittedPersisted
    ? "done"
    : seenCount < 2
      ? "full"
      : "compact";
  // Freeze the mode at mount; expanding compact→full is handled by in-session state below.
  const [mode] = useState<Mode>(initialMode);

  // ── In-session form state ─────────────────────────────────────────────────
  const [rating, setRating] = useState(0);
  const [category, setCategory] = useState<Category | "">("");
  const [feedbackText, setFeedbackText] = useState("");
  const [wantsContact, setWantsContact] = useState(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [ratingError, setRatingError] = useState(false);

  // When compact strip is interacted with (star picked), expand to full form.
  // Uses existing `expanded = rating > 0` gate below.
  const [compactExpanded, setCompactExpanded] = useState(false);

  const errorId = useId();
  const textId = useId();
  const emailId = useId();
  const contactId = useId();
  const headingId = useId();
  const thanksRef = useRef<HTMLDivElement>(null);

  // Progressive disclosure: the panel opens as a single line (heading + stars);
  // the rest of the form only unfolds once the user commits to a rating.
  const expanded = rating > 0;

  // ── seen counter increment (StrictMode-safe) ──────────────────────────────
  // Use a ref latch so the increment fires exactly once per real mount, even
  // if React StrictMode double-invokes the effect in development.
  const didIncrementRef = useRef(false);
  useEffect(() => {
    if (didIncrementRef.current) return;
    // Only increment when the panel is actually going to render.
    if (!ANALYTICS_ENABLED) return;
    if (isSubmittedPersisted) return;
    didIncrementRef.current = true;
    incrementSeen();
    // Intentionally runs once on mount; incrementSeen identity is stable.
  }, []);

  // Move focus to the thank-you region after a successful submission so
  // screen-reader users hear the confirmation.
  useEffect(() => {
    if (submitted) thanksRef.current?.focus();
  }, [submitted]);

  // No analytics sink → no panel (submissions would silently vanish).
  if (!ANALYTICS_ENABLED) return null;

  // ── Done state ────────────────────────────────────────────────────────────
  if (submitted) {
    // Sentiment gate: only show star CTA after a 4–5 star rating, and only
    // once per browser (rl_star_cta_seen flag). Mark seen on first render.
    const showStarCta = rating >= 4 && starCtaSeen !== "1";

    return (
      <div className="flex flex-col gap-3">
        <Card className="flex flex-col gap-1 border-l-4 border-l-brand-amber bg-accent-forward-bg shadow-sm">
          <div ref={thanksRef} tabIndex={-1} className="outline-hidden">
            <p className="text-sm font-semibold text-content-primary">
              Thanks for your feedback!
            </p>
            <p className="text-sm text-content-tertiary">
              It helps us improve ResumeLint.
            </p>
          </div>
        </Card>
        {showStarCta && (
          <StarCtaOnce onSeen={() => setStarCtaSeen("1")} starCount={starCount} />
        )}
      </div>
    );
  }

  if (mode === "done") {
    return null;
  }

  // ── Submit handler ────────────────────────────────────────────────────────
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
        wantsContact,
        // Email is PII — only forward it when the user opted into follow-up.
        email: wantsContact ? email : undefined,
      });
    } catch {
      // Best-effort: capture() is fire-and-forget; swallow and still thank.
    }
    // Persist the submitted flag so the panel stays dismissed across reloads.
    setPersistedSubmitted("1");
    setSubmitted(true);
  }

  // ── Compact strip (mode === "compact", not yet expanded) ──────────────────
  if (mode === "compact" && !compactExpanded) {
    return (
      // -mt-8 cancels the parent Card's gap-6 and lifts this quiet strip up onto
      // AtsScoreReadout's muted footer line (left-aligned + short, so its right
      // side is empty) — turns two stacked footnote rows into one, killing the
      // empty band below the score. Right-aligned, so the lift can't misalign.
      <div className="flex items-center justify-end gap-2 -mt-8">
        <span className="text-xs text-content-muted">Rate ResumeLint</span>
        <StarRating
          value={rating}
          onChange={(v) => {
            setRating(v);
            setRatingError(false);
            setCompactExpanded(true);
          }}
          ariaLabel="Rate ResumeLint from 1 to 5 stars"
        />
      </div>
    );
  }

  // ── Full panel (mode === "full", or compact strip expanded by star click) ──
  return (
    <Card className="flex flex-col gap-4 border-l-4 border-l-brand-amber bg-accent-forward-bg shadow-sm">
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        {/* Collapsed line: heading + inline rating on one row. */}
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h2
              id={headingId}
              className="text-sm font-semibold text-content-primary"
            >
              How's ResumeLint working for you?
            </h2>
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
          </div>
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

        {/* Rest of the form unfolds once a rating is picked. */}
        {expanded && (
          <div className="flex flex-col gap-4">
            {/* Category (optional) */}
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-content-secondary">
                What area needs improvement? (optional)
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

            {/* Contact opt-in: email field is gated behind this checkbox. */}
            <div className="flex flex-col gap-2">
              <label
                htmlFor={contactId}
                className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium text-content-secondary"
              >
                <input
                  id={contactId}
                  type="checkbox"
                  checked={wantsContact}
                  disabled={submitting}
                  onChange={(e) => setWantsContact(e.target.checked)}
                  className="h-4 w-4 accent-brand-amber"
                />
                I'd like the team to follow up with me
              </label>
              {wantsContact && (
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={emailId}
                    className="text-xs font-medium text-content-secondary"
                  >
                    Your email
                  </label>
                  <input
                    id={emailId}
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={submitting}
                    placeholder="you@example.com"
                    className="w-full rounded border border-border-light bg-surface-card px-2 py-1.5 text-sm text-content-primary placeholder:text-content-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-amber"
                  />
                </div>
              )}
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
          </div>
        )}
      </form>
    </Card>
  );
}

/**
 * ReportGapSection — "Report a parsing gap" affordance (#245).
 *
 * Generates a structure-only, PII-redacted repro artifact (see
 * `lib/heuristics/repro-artifact.ts`) and downloads it LOCALLY so the user can
 * attach it to a GitHub issue by hand. NOTHING is uploaded — the copy says so,
 * and the implementation has no network path. Renders regardless of analytics
 * (the download is local); only `trackGapReported` (count-only) is env-gated.
 *
 * Progressive disclosure: a quiet one-line trigger that unfolds into the
 * explainer + download button, mirroring the rating form's collapsed-first feel.
 * Built from `Card`/`Button` primitives; semantic tokens only.
 */
function ReportGapSection({
  result,
  disagreements,
}: {
  result: CascadeResult;
  disagreements?: readonly ParseDisagreement[];
}) {
  const [open, setOpen] = useState(false);
  const { report, reported, error } = useReportGap(result, disagreements ?? []);
  const headingId = useId();

  if (!open) {
    return (
      <div className="flex items-center justify-end gap-2 -mt-2">
        <Button
          variant="link"
          size="sm"
          onClick={() => setOpen(true)}
          aria-expanded={false}
        >
          Parser missed something? Report a parsing gap
        </Button>
      </div>
    );
  }

  return (
    <Card className="flex flex-col gap-3 border-l-4 border-l-brand-amber bg-accent-forward-bg shadow-sm">
      <div className="flex flex-col gap-1">
        <h2
          id={headingId}
          className="text-sm font-semibold text-content-primary"
        >
          Report a parsing gap
        </h2>
        <p className="max-w-prose text-sm text-content-tertiary">
          Download a small, <strong>structure-only</strong> diagnostic file —
          section boundaries, counts, and layout flags. It carries{" "}
          <strong>none of your résumé text</strong> (no name, email, phone, or
          bullet content), so it's safe to attach to a public issue. Nothing is
          uploaded; the download stays in this browser until you attach it
          yourself.
        </p>
      </div>

      {reported ? (
        <div
          role="status"
          className="flex flex-col gap-1 rounded border border-border-light bg-surface-subtle p-3"
        >
          <p className="text-sm font-medium text-content-primary">
            Diagnostic file downloaded.
          </p>
          <p className="text-sm text-content-tertiary">
            Attach it to a new issue at{" "}
            <a
              href="https://github.com/resumelint-org/resumelint/issues/new"
              target="_blank"
              rel="noreferrer noopener"
              className="underline decoration-dotted hover:decoration-solid"
            >
              github.com/resumelint-org/resumelint
            </a>{" "}
            describing what the parser got wrong.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={report}
            aria-describedby={headingId}
          >
            Download diagnostic file
          </Button>
          {disagreements && disagreements.length > 0 && (
            <span className="text-xs text-content-muted">
              Includes {disagreements.length} characterized gap
              {disagreements.length === 1 ? "" : "s"} from the on-device
              comparison (kinds only — no recovered text).
            </span>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-feedback-error-text">
          {error}
        </p>
      )}
    </Card>
  );
}
