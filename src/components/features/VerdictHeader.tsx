// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { getScoreLabel, getScoreTier } from "../../lib/score/score.ts";
import { scoreBandTextClass } from "./scoreBand.ts";

export interface VerdictDimension {
  label: string;
  score: number;
  max: number;
  gradable: boolean;
  hint: string;
}

interface VerdictHeaderProps {
  score: number;
  dimensions: VerdictDimension[];
}

export function VerdictHeader({ score, dimensions }: VerdictHeaderProps) {
  const tier = getScoreTier(score);
  const label = getScoreLabel(tier);
  const colorCls = scoreBandTextClass(tier);

  // Find biggest gap: lowest score/max among gradable dimensions
  const gradable = dimensions.filter((d) => d.gradable && d.max > 0);
  const biggestGap =
    gradable.length > 0
      ? gradable.reduce((worst, d) =>
          d.score / d.max < worst.score / worst.max ? d : worst,
        )
      : null;

  return (
    <div className="flex flex-col justify-center gap-0.5">
      <p className={`text-2xl font-semibold ${colorCls}`}>{label}</p>
      {biggestGap && (
        <p className="text-sm text-content-muted">
          <span className="font-medium text-content-secondary">
            Biggest gap: {biggestGap.label}
          </span>
          {" — "}
          {biggestGap.hint}
        </p>
      )}
    </div>
  );
}
