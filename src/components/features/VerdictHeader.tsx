// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { getScoreLabel, getScoreTier } from "../../lib/score/score.ts";
import { scoreBandTextClass } from "./scoreBand.ts";

interface VerdictHeaderProps {
  score: number;
}

export function VerdictHeader({ score }: VerdictHeaderProps) {
  const tier = getScoreTier(score);
  const label = getScoreLabel(tier);
  const colorCls = scoreBandTextClass(tier);

  return (
    <div className="flex flex-col justify-center gap-0.5">
      <p className={`text-2xl font-semibold ${colorCls}`}>{label}</p>
      <p className="text-sm text-content-muted">
        ATS readiness · {score} / 100
      </p>
    </div>
  );
}
