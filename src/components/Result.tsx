// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { CascadeResult, LayoutTrigger } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { PdfPreview } from "./PdfPreview";

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
      ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200"
      : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200";
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}
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
    <section className="flex flex-col gap-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusPill tone="ok">Parsed</StatusPill>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.diagnostics.pages} page
            {result.diagnostics.pages === 1 ? "" : "s"} ·{" "}
            {result.diagnostics.elapsedMs} ms
          </span>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="text-xs text-neutral-600 hover:underline dark:text-neutral-300"
        >
          Try another PDF
        </button>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Source PDF
          </h2>
          <PdfPreview bytes={bytes} />
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Extracted plain text
          </h2>
          <pre className="max-h-[600px] overflow-auto rounded border border-neutral-200 bg-neutral-50 p-3 text-xs leading-relaxed dark:border-neutral-800 dark:bg-neutral-950">
            {result.rawText || "(no text extracted)"}
          </pre>
        </div>
      </div>

      <LayoutFlagsList triggers={result.triggers} />
      <AtsScoreReadout score={score} />
    </section>
  );
}

function LayoutFlagsList({ triggers }: { triggers: readonly LayoutTrigger[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
        Layout flags
      </h2>
      {triggers.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          None — single-column, text-PDF layout.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {triggers.map((t) => (
            <li key={t} className="text-sm">
              <span className="font-mono text-xs text-neutral-700 dark:text-neutral-200">
                {t}
              </span>{" "}
              <span className="text-neutral-600 dark:text-neutral-400">
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
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Reference ATS score
        </h2>
        <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          alpha
        </span>
        {score.algoVersion && (
          <span className="text-[10px] text-neutral-500">
            algo v{score.algoVersion}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-semibold">{score.overall}</span>
        <span className="text-sm text-neutral-500">/ 100</span>
      </div>
      <p className="max-w-prose text-xs text-neutral-600 dark:text-neutral-400">
        Our reference number for iterating on the parser. Not a universal
        score — different ATSes weigh things differently. See the dimensions
        below.
      </p>
      <dl className="mt-1 grid grid-cols-3 gap-3 text-xs">
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
      {score.layout.multiplier < 1 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
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
  return (
    <div className="flex flex-col gap-1 rounded border border-neutral-200 p-2 dark:border-neutral-800">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </dt>
      <dd className="text-base font-medium">
        {gradable ? (
          <>
            {value}
            <span className="text-xs text-neutral-500"> / {max}</span>
          </>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
      </dd>
      <p className="text-[10px] text-neutral-500 dark:text-neutral-400">
        {hint}
      </p>
    </div>
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
    <section className="flex flex-col gap-5 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="flex items-center justify-between">
        <StatusPill tone="limited">Limited parsing</StatusPill>
        <button
          type="button"
          onClick={onReset}
          className="text-xs font-medium text-neutral-900 hover:underline dark:text-neutral-100"
        >
          Try a different PDF
        </button>
      </header>

      <div>
        <h2 className="text-base font-semibold">
          Some text wasn't readable in this PDF
        </h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {result.diagnostics.pages} page
          {result.diagnostics.pages === 1 ? "" : "s"} scanned. Below is what we
          could recover.
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Recovered links
        </h3>
        {uniqueUrls.length === 0 ? (
          <p className="text-sm text-neutral-500">
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
                  className="font-mono text-xs text-neutral-700 underline decoration-dotted hover:decoration-solid dark:text-neutral-200"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <hr className="border-neutral-200 dark:border-neutral-800" />

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          What happened
        </h3>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          {LAYOUT_TRIGGER_BLURBS.fonts_unmappable}
        </p>
      </section>
    </section>
  );
}
