// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { CascadeResult, LayoutTrigger } from "../lib/heuristics/types.ts";
import type {
  AnonymousAtsScore,
  BulletObservation,
} from "../lib/score/score.ts";
import { getScoreTier, getScoreLabel } from "../lib/score/score.ts";
import { PdfPreview } from "./PdfPreview";
import { Chip } from "./ui/Chip.tsx";
import { ScoreRing } from "./features/ScoreRing.tsx";
import { VerdictHeader } from "./features/VerdictHeader.tsx";
import { ContactCard } from "./features/ContactCard.tsx";
import { FeedbackControl } from "./features/FeedbackControl.tsx";

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
    <section className="flex flex-col gap-6 rounded-xl border border-border-light bg-surface-card p-5 shadow-sm">
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
      <ContactCard result={result} />
      <PerBulletFeedback bullets={score.bullets} />

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
    </section>
  );
}

function LayoutFlagsList({ triggers }: { triggers: readonly LayoutTrigger[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
        Layout flags
      </h2>
      {triggers.length === 0 ? (
        <Chip tone="success" icon="✓">
          Clean ATS layout — single-column, selectable text
        </Chip>
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
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
          Your resume score
        </h2>
        <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-content-secondary">
          alpha
        </span>
        {score.algoVersion && (
          <span className="text-[11px] text-content-muted">
            algo v{score.algoVersion}
          </span>
        )}
        <span className="text-[11px] text-content-muted">
          Built {buildDate}
        </span>
      </div>
      <p className="max-w-prose text-sm text-content-tertiary">
        A quick read on how your resume scores — based on what a generic text
        extractor pulled from your PDF, the same starting point most ATS
        parsers use. Not a universal score; systems weigh things differently.
        Dimensions below show where the points landed.
      </p>
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="flex items-center gap-4">
          <ScoreRing score={score.overall} />
          <VerdictHeader score={score.overall} />
        </div>
        <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3 flex-1">
          <Dimension
            label="Specificity"
            value={score.specificity.score}
            max={score.specificity.max}
            gradable={score.specificity.gradable}
            hint={`${score.specificity.metricBullets}/${score.specificity.totalBullets} bullets carry a metric`}
          />
          <Dimension
            label="Structure"
            value={score.structure.score}
            max={score.structure.max}
            gradable={score.structure.gradable}
            hint={`${score.structure.goodBullets}/${score.structure.totalBullets} bullets within 8–30 words`}
          />
          <Dimension
            label="Completeness"
            value={score.completeness.score}
            max={score.completeness.max}
            gradable={score.completeness.gradable}
            hint={
              score.completeness.missing.length === 0
                ? "All expected fields present"
                : `Missing: ${score.completeness.missing.join(", ")}`
            }
          />
        </dl>
      </div>
      {score.layout.multiplier < 1 && (
        <p className="text-[11px] text-feedback-warning-text">
          Layout penalty applied (multiplier {score.layout.multiplier.toFixed(2)}
          ): pre-layout score was {score.preLayoutOverall}.
        </p>
      )}
    </section>
  );
}

function Dimension({
  label,
  value,
  max,
  gradable,
  hint,
}: {
  label: string;
  value: number;
  max: number;
  gradable: boolean;
  hint: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border-light bg-surface-subtle p-3">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">
        {label}
      </dt>
      <dd className="text-sm font-medium">
        {gradable ? (
          <>
            {value}
            <span className="text-xs text-content-muted"> / {max}</span>
          </>
        ) : (
          <span className="text-content-muted">—</span>
        )}
      </dd>
      {gradable && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-card">
          <div
            className="h-full rounded-full bg-brand-amber"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p className="text-[11px] text-content-muted">{hint}</p>
    </div>
  );
}

function PerBulletFeedback({
  bullets,
}: {
  bullets: BulletObservation[] | undefined;
}) {
  if (!bullets || bullets.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
          Per-bullet feedback
        </h2>
        <p className="text-sm text-content-tertiary">
          No bullet-shaped lines detected.
        </p>
      </section>
    );
  }

  const attentionCount = bullets.filter(needsAttention).length;
  const summary =
    attentionCount === 0
      ? `All ${bullets.length} bullets pass every check.`
      : `${attentionCount} of ${bullets.length} bullet${
          bullets.length === 1 ? "" : "s"
        } need attention — missing a metric and at least one structure check.`;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
        Per-bullet feedback
      </h2>
      <p className="max-w-prose text-sm text-content-tertiary">
        Each bullet checked against three rules: an action verb, the 8–30-word
        length window, and a metric. {summary}
      </p>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Per-bullet rule checks</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="pb-1 text-left text-[11px] font-semibold uppercase tracking-wider text-content-muted"
            >
              {/* bullet text — no visible header */}
            </th>
            <th
              scope="col"
              className="pb-1 pr-2 text-right text-[11px] font-semibold uppercase tracking-wider text-content-muted"
            >
              Verb
            </th>
            <th
              scope="col"
              className="pb-1 pr-2 text-right text-[11px] font-semibold uppercase tracking-wider text-content-muted"
            >
              Length
            </th>
            <th
              scope="col"
              className="pb-1 text-right text-[11px] font-semibold uppercase tracking-wider text-content-muted"
            >
              Metric
            </th>
          </tr>
        </thead>
        <tbody>
          {bullets.map((b) => (
            <BulletRow key={b.index} bullet={b} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function needsAttention(b: BulletObservation): boolean {
  return !b.hasMetric && (!b.startsWithActionVerb || !b.wellFormedLength);
}

function BulletRow({ bullet }: { bullet: BulletObservation }) {
  const attention = needsAttention(bullet);
  const allPass =
    bullet.hasMetric && bullet.startsWithActionVerb && bullet.wellFormedLength;

  const rowCls = attention
    ? "bg-feedback-warning-bg"
    : "";
  const textCls = allPass ? "text-content-muted" : "text-content-primary";

  const lengthLabel = bullet.wellFormedLength
    ? `${bullet.wordCount} words`
    : bullet.wordCount < 8
      ? `${bullet.wordCount} words (too short)`
      : `${bullet.wordCount} words (too long)`;

  const lengthSuffix =
    bullet.wordCount < 8 ? " ↓" : bullet.wordCount > 30 ? " ↑" : "";

  return (
    <tr className={rowCls}>
      <td className={`py-1 pr-3 align-top text-sm leading-snug ${textCls}`}>
        <span className="mr-1.5 font-mono text-[11px] text-content-muted">
          #{bullet.index + 1}
        </span>
        {bullet.text}
      </td>
      <td className="py-1 pr-2 text-right align-top tabular-nums">
        {bullet.startsWithActionVerb ? (
          <>
            <span className="text-feedback-success-text" aria-hidden="true">
              ✓
            </span>
            <span className="sr-only">verb</span>
          </>
        ) : (
          <>
            <span className="text-feedback-warning-text" aria-hidden="true">
              ✗
            </span>
            <span className="sr-only">no action verb</span>
          </>
        )}
      </td>
      <td
        className="py-1 pr-2 text-right align-top tabular-nums"
        title={lengthLabel}
      >
        <span
          className={
            bullet.wellFormedLength
              ? "text-feedback-success-text"
              : "text-feedback-warning-text"
          }
        >
          {bullet.wordCount}
          {lengthSuffix}
        </span>
        <span className="sr-only">{lengthLabel}</span>
      </td>
      <td className="py-1 text-right align-top tabular-nums">
        {bullet.hasMetric ? (
          <>
            <span className="text-feedback-success-text" aria-hidden="true">
              ✓
            </span>
            <span className="sr-only">metric</span>
          </>
        ) : (
          <>
            <span className="text-feedback-warning-text" aria-hidden="true">
              ✗
            </span>
            <span className="sr-only">no metric</span>
          </>
        )}
      </td>
    </tr>
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
    <section className="flex flex-col gap-5 rounded-xl border border-border-light bg-surface-card p-5 shadow-sm">
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
    </section>
  );
}
