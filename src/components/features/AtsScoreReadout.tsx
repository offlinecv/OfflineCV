// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * AtsScoreReadout — renders the full score section: ring, verdict header,
 * three dimension cards, layout penalty note, and algo version footer.
 * Extracted from Result.tsx (issue #83). Includes the Dimension sub-component.
 */

import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import { getScoreTier } from "../../lib/score/score.ts";
import { ScoreRing } from "./ScoreRing.tsx";
import { VerdictHeader } from "./VerdictHeader.tsx";
import type { VerdictDimension } from "./VerdictHeader.tsx";
import { scoreBandBgClass, scoreBandTextClass } from "./scoreBand.ts";
import { timeAgo } from "../../lib/date-utils.ts";

// ── Dimension card ────────────────────────────────────────────────────────────

interface DimensionProps {
  label: string;
  value: number;
  max: number;
  gradable: boolean;
  hint: string;
  anchor: string;
}

function Dimension({
  label,
  value,
  max,
  gradable,
  hint,
  anchor,
}: DimensionProps) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const tier = getScoreTier(pct);
  const barCls = scoreBandBgClass(tier);
  const valueCls = scoreBandTextClass(tier);

  return (
    <a
      href={anchor}
      className="block flex flex-col gap-1.5 rounded-lg border border-border-light bg-surface-subtle p-3 hover:border-border-light"
    >
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">
        {label}
      </dt>
      <dd className="text-sm font-medium">
        {gradable ? (
          <>
            <span className={valueCls}>{value}</span>
            <span className="text-xs text-content-muted"> / {max}</span>
          </>
        ) : (
          <span className="text-content-muted">—</span>
        )}
      </dd>
      {gradable && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-card">
          <div
            className={`h-full rounded-full ${barCls}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p className="text-[11px] text-content-tertiary">{hint}</p>
    </a>
  );
}

// ── AtsScoreReadout ───────────────────────────────────────────────────────────

interface AtsScoreReadoutProps {
  score: AnonymousAtsScore;
}

export function AtsScoreReadout({ score }: AtsScoreReadoutProps) {
  const buildDate = __BUILD_DATE__.slice(0, 10);
  // Prefer a friendly "7m ago"; fall back to the absolute date if the build
  // timestamp is unparseable or somehow in the future.
  const buildAgo = timeAgo(__BUILD_DATE__) || buildDate;

  // Compute hint strings once — shared between VerdictHeader and Dimension cards.
  const specificityHint = `${score.specificity.metricBullets}/${score.specificity.totalBullets} bullets carry a metric`;
  const structureHint = `${score.structure.goodBullets}/${score.structure.totalBullets} bullets within 8–30 words`;
  const completenessHint =
    score.completeness.missing.length === 0
      ? "All expected fields present"
      : `Missing: ${score.completeness.missing.join(", ")}`;

  const dimensions: VerdictDimension[] = [
    {
      label: "Specificity",
      score: score.specificity.score,
      max: score.specificity.max,
      gradable: score.specificity.gradable,
      hint: specificityHint,
    },
    {
      label: "Structure",
      score: score.structure.score,
      max: score.structure.max,
      gradable: score.structure.gradable,
      hint: structureHint,
    },
    {
      label: "Completeness",
      score: score.completeness.score,
      max: score.completeness.max,
      gradable: score.completeness.gradable,
      hint: completenessHint,
    },
  ];

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
          Your resume score
        </h2>
        <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-content-secondary">
          alpha
        </span>
      </div>
      <p className="text-sm text-content-tertiary">
        Scored from what a generic text extractor pulled from your PDF — the
        starting point most resume parsers share.
      </p>
      <details className="text-sm text-content-tertiary">
        <summary className="cursor-pointer text-sm text-content-tertiary">
          How is this scored?
        </summary>
        <p className="mt-1 max-w-prose text-sm text-content-tertiary">
          A quick read on how your resume scores — based on what a generic text
          extractor pulled from your PDF, the same starting point most ATS
          parsers use. Not a universal score; systems weigh things differently.
          Dimensions below show where the points landed.
        </p>
      </details>
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="flex items-center gap-4">
          <ScoreRing score={score.overall} />
          <VerdictHeader score={score.overall} dimensions={dimensions} />
        </div>
        <dl className="grid flex-1 grid-cols-1 gap-3 text-xs sm:grid-cols-3">
          <Dimension
            label="Specificity"
            value={score.specificity.score}
            max={score.specificity.max}
            gradable={score.specificity.gradable}
            hint={specificityHint}
            anchor="#per-bullet-feedback"
          />
          <Dimension
            label="Structure"
            value={score.structure.score}
            max={score.structure.max}
            gradable={score.structure.gradable}
            hint={structureHint}
            anchor="#per-bullet-feedback"
          />
          <Dimension
            label="Completeness"
            value={score.completeness.score}
            max={score.completeness.max}
            gradable={score.completeness.gradable}
            hint={completenessHint}
            anchor="#contact"
          />
        </dl>
      </div>
      {score.layout.multiplier < 1 && (
        <p className="text-[11px] text-feedback-warning-text">
          Layout penalty applied (multiplier {score.layout.multiplier.toFixed(2)}
          ): pre-layout score was {score.preLayoutOverall}.
        </p>
      )}
      <p className="text-[11px] text-content-muted">
        {score.algoVersion && <>algo v{score.algoVersion} · </>}Built{" "}
        <span title={buildDate}>{buildAgo}</span>
      </p>
    </section>
  );
}
