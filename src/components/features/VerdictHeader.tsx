// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { getScoreLabel, getScoreTier } from "../../lib/score/score.ts";
import { scoreBandTextClass } from "./scoreBand.ts";

interface VerdictHeaderProps {
  score: number;
  /** One actionable next-step sentence, precomputed by `getScoreRecommendation`
   *  (#42). Replaces the former "biggest gap" diagnostic: it points at the same
   *  weakest dimension but is layout/scanned-aware and says what to *do*. */
  recommendation: string;
}

export function VerdictHeader({ score, recommendation }: VerdictHeaderProps) {
  const tier = getScoreTier(score);
  const label = getScoreLabel(tier);
  const colorCls = scoreBandTextClass(tier);

  return (
    <div className="flex flex-col justify-center gap-0.5">
      <p className={`text-2xl font-semibold ${colorCls}`}>{label}</p>
      {/* Deliberately unclamped (#953). A `line-clamp` needs a non-hover way
          back to the hidden remainder, and `title` is not one — it is
          mouse-hover-only, so on touch and keyboard the clipped tail is simply
          gone. That tail carries the instruction: the layout-penalty
          recommendation runs ~150 chars and ends in what to actually do. The
          sentence is short enough that letting it wrap costs a line or two
          against the ~240px the rest of the compaction bought. */}
      <p className="text-sm text-content-secondary">{recommendation}</p>
    </div>
  );
}
