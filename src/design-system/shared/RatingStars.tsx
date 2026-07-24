// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * RatingStars — a READ-ONLY, fractional 0–max star display.
 *
 * Distinct concern from the `StarRating` primitive: that one is an INTERACTIVE
 * radio group for a user to GIVE a rating (discrete, keyboard-operable, fires
 * `onChange`). This one DISPLAYS a computed rating that can land between stars
 * (e.g. a 4.2★ job fit), so it is non-interactive and supports fractional fill.
 * Reuse this everywhere a rating is shown; never hand-roll a parallel star row.
 *
 * Fractional fill is a two-layer overlay: a muted row of outline stars, and an
 * identical row of filled stars clipped to `(value / max) · 100%` width. This
 * gives true sub-star precision (a 4.2 shows four full stars plus a fifth filled
 * ~20%) without per-star half/quarter glyph juggling.
 *
 * `showValue` prints the rounded number beside the glyphs. Stars are a
 * low-precision encoding — at a small size the fractional overlay is a couple of
 * pixels wide, so a 4.2 and a 4.6 are indistinguishable by eye. Turn it on
 * wherever the exact value matters (#569); the numeral is `aria-hidden` because
 * the `aria-label` already carries it, so AT must not hear it twice.
 *
 * Accessibility: the whole widget is one `role="img"` with an `aria-label`
 * carrying the numeric value ("4.2 out of 5") — assistive tech reads the number,
 * not ten individual star glyphs. The glyphs themselves are `aria-hidden`.
 *
 * Design rules (CLAUDE.md): semantic tokens only (accent for fill, muted for the
 * track); no hardcoded colour.
 */

const SIZE_CLS = {
  sm: "text-xs",
  md: "text-base",
} as const;

interface RatingStarsProps {
  /** The rating to display, 0..max (may be fractional). */
  value: number;
  /** Number of stars. Defaults to 5. */
  max?: number;
  /** Glyph size. Defaults to "md". */
  size?: keyof typeof SIZE_CLS;
  /** Accessible label. Defaults to "{value} out of {max} stars". Pass a richer
   *  one (e.g. "Overall match: 4.2 out of 5 stars") at a callsite where context
   *  matters. */
  ariaLabel?: string;
  /** Print the rounded value beside the stars. Defaults to false. */
  showValue?: boolean;
}

export function RatingStars({
  value,
  max = 5,
  size = "md",
  ariaLabel,
  showValue = false,
}: RatingStarsProps) {
  const clamped = value < 0 ? 0 : value > max ? max : value;
  // Round to 2 dp so the inline width is a clean "84%", not "84.00000000000001%".
  const pct = Math.round((clamped / max) * 10000) / 100;
  const rounded = Math.round(clamped * 10) / 10;
  const label = ariaLabel ?? `${rounded} out of ${max} stars`;
  const stars = "★".repeat(max);

  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-flex items-center gap-1 leading-none ${SIZE_CLS[size]}`}
    >
      {/* The glyph box is its own element so the fill overlay's `inset-0` is
          measured against the STARS alone — an adjacent numeral inside it would
          widen the box and under-fill every rating. */}
      <span aria-hidden="true" className="relative inline-block whitespace-nowrap">
        {/* Track: outline/muted stars fill the width and set the box size. */}
        <span aria-hidden="true" className="text-content-muted">
          {stars}
        </span>
        {/* Fill: filled stars clipped to the rating fraction, overlaid exactly. */}
        <span
          aria-hidden="true"
          className="absolute inset-0 overflow-hidden text-accent-primary"
          style={{ width: `${pct}%` }}
        >
          {stars}
        </span>
      </span>
      {showValue && (
        <span aria-hidden="true" className="tabular-nums text-content-secondary">
          {rounded.toFixed(1)}
        </span>
      )}
    </span>
  );
}
