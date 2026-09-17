// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { getScoreTier } from "../../lib/score/score.ts";
import { scoreBandTextClass } from "./scoreBand.ts";

interface ScoreRingProps {
  score: number;
  max?: number;
  /** Ring diameter in CSS px. Defaults to 96 (the original standalone size);
   *  `AtsScoreReadout` passes 84 for the expanded score widget (#953).
   *
   *  Sizes much below ~80 would need the inner labels re-sized — `text-3xl`
   *  overflows a small ring — so add that branch alongside the first caller
   *  that actually passes one. An earlier revision carried it speculatively,
   *  gated on `size < 80`, which no caller ever satisfied: an unreachable
   *  branch that no test could cover and no reviewer could check. */
  size?: number;
}

export function ScoreRing({ score, max = 100, size = 96 }: ScoreRingProps) {
  const tier = getScoreTier(score);
  const ringColorCls = scoreBandTextClass(tier);

  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(1, score / max));
  const dashOffset = circumference * (1 - progress);

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden="true"
      >
        {/* Track circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="text-surface-subtle"
          stroke="currentColor"
        />
        {/* Progress arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className={ringColorCls}
          stroke="currentColor"
        />
      </svg>
      <div
        className="absolute flex flex-col items-center justify-center"
        style={{ transform: "rotate(0deg)" }}
      >
        <span className={`text-3xl font-semibold leading-none ${ringColorCls}`}>
          {score}
        </span>
        <span className="text-2xs text-content-muted">/ {max}</span>
      </div>
    </div>
  );
}
