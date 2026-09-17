// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import type { ScoreTier } from "../../lib/score/types.ts";
import { getScoreTier } from "../../lib/score/score.ts";

/** Maps a score tier to the Tailwind text-color token for that band. */
export function scoreBandTextClass(tier: ScoreTier): string {
  switch (tier) {
    case "high":
      return "text-feedback-success-icon";
    case "medium":
      return "text-accent-primary";
    case "low":
      return "text-feedback-warning-icon";
    default:
      return "text-feedback-warning-icon";
  }
}

/** Maps a score tier to the Tailwind bg-color token for that band. */
export function scoreBandBgClass(tier: ScoreTier): string {
  switch (tier) {
    case "high":
      return "bg-feedback-success-icon";
    case "medium":
      return "bg-accent-primary";
    case "low":
      return "bg-feedback-warning-icon";
    default:
      return "bg-feedback-warning-icon";
  }
}

/**
 * Percent-of-max plus both band classes for one dimension, derived once.
 *
 * The same dimension is drawn twice — expanded by `ScoreDimensionRow`, docked
 * by `CollapsedScoreBar` — and each needs the same percent, bar colour and
 * value colour from the same `value`/`max` pair. Deriving it in both places
 * was a correctness risk rather than a tidiness one: the tier is looked up
 * from the ROUNDED percent, so a change to the rounding in one copy would make
 * one score render a different band expanded than docked, on the same screen
 * (#953).
 *
 * `max <= 0` yields 0 rather than `NaN`/`Infinity` — an ungradable dimension
 * reaches this with a zero max, and a `NaN%` width silently drops the bar.
 */
export function scoreBandParts(
  value: number,
  max: number,
): { pct: number; barCls: string; valueCls: string } {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const tier = getScoreTier(pct);
  return {
    pct,
    barCls: scoreBandBgClass(tier),
    valueCls: scoreBandTextClass(tier),
  };
}
