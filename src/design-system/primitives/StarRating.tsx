// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * StarRating — the ONE 1–N star rating primitive.
 *
 * Implemented as a native radio group: each star is a visually-hidden
 * `<input type="radio">` behind a star glyph `<label>`. This gives keyboard
 * operability for free — Tab moves into the group, arrow keys move between
 * stars and select (native radio behaviour) — and exposes proper
 * `radiogroup`/`radio` semantics to assistive tech without re-implementing
 * roving tabindex by hand.
 *
 * Touch targets are 44×44px (WCAG 2.5.5). Selection-driven fill only — no
 * hover-only affordance.
 *
 * Design rules (CLAUDE.md): semantic tokens only; never hand-roll a parallel
 * star widget in feature code — import this primitive.
 */

import { useId } from "react";

interface StarRatingProps {
  /** Selected value, 1..max. 0 means unset (no star selected). */
  value: number;
  onChange: (value: number) => void;
  /** Number of stars. Defaults to 5. */
  max?: number;
  disabled?: boolean;
  /** Accessible name for the group (e.g. "Rate ResumeLint from 1 to 5 stars"). */
  ariaLabel?: string;
  /** Id of an external element (e.g. a validation error) describing the group. */
  ariaDescribedBy?: string;
}

export function StarRating({
  value,
  onChange,
  max = 5,
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
}: StarRatingProps) {
  const name = useId();
  const stars = Array.from({ length: max }, (_, i) => i + 1);

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      className="inline-flex"
    >
      {stars.map((star) => {
        const filled = star <= value;
        return (
          <label
            key={star}
            className="relative inline-flex h-11 w-11 cursor-pointer items-center justify-center text-2xl leading-none"
          >
            <input
              type="radio"
              name={name}
              value={star}
              checked={value === star}
              disabled={disabled}
              onChange={() => onChange(star)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className={filled ? "text-brand-amber" : "text-content-muted"}
            >
              {filled ? "★" : "☆"}
            </span>
            <span className="sr-only">
              {star} star{star === 1 ? "" : "s"}
            </span>
          </label>
        );
      })}
    </div>
  );
}
