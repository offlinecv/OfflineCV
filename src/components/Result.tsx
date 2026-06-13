// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { CascadeResult, LayoutTrigger } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { getScoreTier, getScoreLabel } from "../lib/score/score.ts";
import { PdfPreview } from "./PdfPreview";
import { ScoreRing } from "./features/ScoreRing.tsx";
import { VerdictHeader } from "./features/VerdictHeader.tsx";
import type { VerdictDimension } from "./features/VerdictHeader.tsx";
import { Card } from "./shared/Card.tsx";
import { FeedbackControl } from "./features/FeedbackControl.tsx";
import { ReconstructedResume } from "./features/ReconstructedResume.tsx";
import {
  scoreBandTextClass,
  scoreBandBgClass,
} from "./features/scoreBand.ts";

interface ResultProps {
  result: CascadeResult;
  score: AnonymousAtsScore;
  bytes: ArrayBuffer;
  onReset: () => void;
}

const LAYOUT_TRIGGER_BLURBS: Record<LayoutTrigger, string> = {
  two_column:
    "Two-column layout — some text extractors read across columns and scramble the order.",
  scanned:
    "Image-only PDF — no selectable text, so a plain-text extractor returns nothing.",
  fonts_unmappable:
    "Text is present in the source but uses custom font encodings that don't decode to characters. Common with Framer, Affinity, and some InDesign exports.",
};

export function Result({ result, score, bytes, onReset }: ResultProps) {
  const isFontsUnmappable = result.triggers.includes("fonts_unmappable");
  if (isFontsUnmappable) {
    return <LimitedParsingCard result={result} onReset={onReset} />;
  }
  return (
    <ParsedCard result={result} score={score} bytes={bytes} onReset={onReset} />
  );
}

function StatusPill({
  tone,
  children,
}: {
  tone: "ok" | "limited";
  children: React.ReactNode;
}) {
  const cls =
    tone === "ok"
      ? "bg-feedback-success-bg text-feedback-success-text"
      : "bg-feedback-warning-bg text-feedback-warning-text";
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {children}
    </span>
  );
}

function ParsedCard({
  result,
  score,
  bytes,
  onReset,
}: {
  result: CascadeResult;
  score: AnonymousAtsScore;
  bytes: ArrayBuffer;
  onReset: () => void;
}) {
  return (
    <Card className="flex flex-col gap-6 shadow-sm">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusPill tone="ok">Parsed</StatusPill>
          <span className="text-xs text-content-muted">
            {result.diagnostics.pages} page
            {result.diagnostics.pages === 1 ? "" : "s"} ·{" "}
            {result.diagnostics.elapsedMs} ms
          </span>
          <FeedbackControl
            verdictBand={getScoreLabel(getScoreTier(score.overall))}
          />
        </div>
        <button
          type="button"
          onClick={onReset}
          className="text-xs text-content-tertiary hover:underline"
        >
          Try another PDF
        </button>
      </header>

      <AtsScoreReadout score={score} />
      <ReconstructedResume result={result} score={score} />

      {/* Evidence — how a generic extractor read this PDF. Reference
          material, so it sits below the score and per-bullet findings.
          Layout flags head the block (the verdict); the preview and
          extracted-text panes are the raw material under it. Both panes are
          height-bounded so a two-page resume scrolls inside the row instead
          of pushing it open. */}
      <section className="flex flex-col gap-4">
        <LayoutFlagsList triggers={result.triggers} />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
              Source PDF
            </h2>
            <div className="max-h-[600px] overflow-y-auto">
              <PdfPreview bytes={bytes} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
              Extracted plain text
            </h2>
            <pre className="max-h-[600px] overflow-auto rounded border border-border-light bg-surface-subtle p-3 text-sm leading-relaxed">
              {result.rawText || "(no text extracted)"}
            </pre>
          </div>
        </div>
      </section>
    </Card>
  );
}

function LayoutFlagsList({ triggers }: { triggers: readonly LayoutTrigger[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
        Layout flags
      </h2>
      {triggers.length === 0 ? (
        <p className="text-sm text-content-tertiary">
          No layout flags — standard single-column, text-selectable PDF.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {triggers.map((t) => (
            <li key={t} className="text-sm">
              <span className="font-mono text-xs text-content-secondary">
                {t}
              </span>{" "}
              <span className="text-content-tertiary">
                — {LAYOUT_TRIGGER_BLURBS[t]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AtsScoreReadout({ score }: { score: AnonymousAtsScore }) {
  const buildDate = __BUILD_DATE__.slice(0, 10);

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
        {buildDate}
      </p>
    </section>
  );
}

function Dimension({
  label,
  value,
  max,
  gradable,
  hint,
  anchor,
}: {
  label: string;
  value: number;
  max: number;
  gradable: boolean;
  hint: string;
  anchor: string;
}) {
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

function LimitedParsingCard({
  result,
  onReset,
}: {
  result: CascadeResult;
  onReset: () => void;
}) {
  const links = result.linkAnnotations;
  const uniqueUrls = Array.from(new Set(links.map((l) => l.url)));

  return (
    <Card className="flex flex-col gap-5 shadow-sm">
      <header className="flex items-center justify-between">
        <StatusPill tone="limited">Limited parsing</StatusPill>
        <button
          type="button"
          onClick={onReset}
          className="text-xs font-medium text-content-primary hover:underline"
        >
          Try a different PDF
        </button>
      </header>

      <div>
        <h2 className="text-base font-semibold">
          Some text wasn't readable in this PDF
        </h2>
        <p className="mt-1 text-sm text-content-tertiary">
          {result.diagnostics.pages} page
          {result.diagnostics.pages === 1 ? "" : "s"} scanned. Below is what we
          could recover.
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
          Recovered links
        </h3>
        {uniqueUrls.length === 0 ? (
          <p className="text-sm text-content-muted">
            No link annotations were embedded in this PDF.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {uniqueUrls.map((url) => (
              <li key={url} className="text-sm">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-xs text-content-secondary underline decoration-dotted hover:decoration-solid"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <hr className="border-border-light" />

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
          What happened
        </h3>
        <p className="text-sm text-content-secondary">
          {LAYOUT_TRIGGER_BLURBS.fonts_unmappable}
        </p>
      </section>
    </Card>
  );
}
