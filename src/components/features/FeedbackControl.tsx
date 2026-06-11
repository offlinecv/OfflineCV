// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * FeedbackControl — thumbs up / down feedback widget.
 *
 * Hidden entirely when analytics are disabled (VITE_POSTHOG_KEY unset).
 * After the user votes, transitions to a "thanks" confirmation state.
 *
 * Follows Result.tsx precedent: raw <button> elements (no Button primitive),
 * semantic tokens only, accessible aria-labels.
 */

import { useState } from "react";
import { ANALYTICS_ENABLED, trackFeedback } from "../../lib/analytics.ts";

interface FeedbackControlProps {
  verdictBand: string;
}

export function FeedbackControl({ verdictBand }: FeedbackControlProps) {
  const [submitted, setSubmitted] = useState(false);

  if (!ANALYTICS_ENABLED) return null;

  if (submitted) {
    return (
      <p className="text-xs text-content-muted">Thanks for the feedback.</p>
    );
  }

  function handleThumb(thumb: "up" | "down") {
    trackFeedback({ verdictBand, thumb });
    setSubmitted(true);
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-content-muted">Was this score helpful?</span>
      <button
        type="button"
        aria-label="Thumbs up — score was helpful"
        onClick={() => handleThumb("up")}
        className="rounded px-2 py-0.5 text-sm text-content-secondary hover:bg-surface-subtle"
      >
        👍
      </button>
      <button
        type="button"
        aria-label="Thumbs down — score was not helpful"
        onClick={() => handleThumb("down")}
        className="rounded px-2 py-0.5 text-sm text-content-secondary hover:bg-surface-subtle"
      >
        👎
      </button>
    </div>
  );
}
