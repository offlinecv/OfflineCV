// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useCallback, useMemo, useState } from "react";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import { computeAnonymousAtsScore, type AnonymousAtsScore } from "../lib/score/score.ts";
import type { EditableParse } from "../hooks/useEditableParse.ts";
import { Card, StatusBadge, Button } from "@design-system";
import { FeedbackPanel } from "./features/FeedbackPanel.tsx";
import { AtsScoreReadout } from "./features/AtsScoreReadout.tsx";
import { useResumeAnalysisLlm } from "../hooks/useResumeAnalysisLlm.ts";
import { useLlmEscapeHatch } from "../hooks/useLlmEscapeHatch.ts";
import { LlmEscapeHatchBanner } from "./features/LlmEscapeHatchBanner.tsx";
import type { LlmParsedResume } from "../lib/webllm/parse-resume.ts";
import { mergeLlmParse } from "../lib/webllm/merge-override.ts";
import { ParsedHeader } from "./features/ParsedHeader.tsx";
import { ResultDetailTabs } from "./features/ResultDetailTabs.tsx";

// LAYOUT_TRIGGER_BLURBS for fonts_unmappable is still needed by LimitedParsingCard.
const FONTS_UNMAPPABLE_BLURB =
  "Text is present in the source but uses custom font encodings that don't decode to characters. Common with Framer, Affinity, and some InDesign exports.";

type SourceKind = "pdf" | "docx";

interface ResultProps {
  result: CascadeResult;
  /** EDITED score — re-graded by App from the current overrides (#82). */
  score: AnonymousAtsScore;
  /** PDF bytes for the source preview pane. Absent for DOCX uploads. */
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  onReset: () => void;
  /** Lifted edit state (#82) — threaded to ReconstructedResume for inline edits. */
  edit: EditableParse;
  /** Optional JD-driven rewrite steering (#226). Set only on `/jd-fit`. */
  jdContext?: string;
}

export function Result({
  result,
  score,
  bytes,
  sourceKind,
  onReset,
  edit,
  jdContext,
}: ResultProps) {
  const isFontsUnmappable = result.triggers.includes("fonts_unmappable");
  if (isFontsUnmappable) {
    return <LimitedParsingCard result={result} onReset={onReset} />;
  }
  return (
    <ParsedCard
      result={result}
      score={score}
      bytes={bytes}
      sourceKind={sourceKind}
      onReset={onReset}
      edit={edit}
      jdContext={jdContext}
    />
  );
}

// ── ParsedCard ────────────────────────────────────────────────────────────────

function ParsedCard({
  result,
  score,
  bytes,
  sourceKind,
  onReset,
  edit,
  jdContext,
}: {
  result: CascadeResult;
  score: AnonymousAtsScore;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  onReset: () => void;
  edit: EditableParse;
  jdContext?: string;
}) {
  const triggerCount = result.triggers.length;

  // Opt-in combined WebLLM analysis (#262, #273). One controller feeds the
  // single "Resume Quality" tab (the LLM critique plus "What an ATS misses" as
  // a bottom section) from one inference. Lifted here so the tab is only
  // advertised on WebGPU-capable browsers with extractable text; on everything
  // else the tab (and panel) is silently absent. The panel's single CTA triggers
  // the combined run; status (loading/running/done/error) is owned by the panel.
  const analysis = useResumeAnalysisLlm(result);

  // Degenerate-case LLM escape hatch (#243). Only available when
  // `result.suggestedEscalation === "llm"` AND WebGPU is available AND there is
  // text. When the user opts in and the pass completes, `llmOverride` is set and
  // the entire result surface re-renders from the LLM-parsed fields.
  const escapeHatch = useLlmEscapeHatch(result);
  // `llmOverride` is NOT keyed/reset on `result` change. Safe today because a new
  // file passes through the `parsing` phase, which unmounts `Result` and discards
  // this state — so an override never leaks onto a different resume. A future
  // keyed/persistent `Result` refactor that keeps this mounted across files must
  // reset `llmOverride` on `result` change, or a stale override will bleed through.
  const [llmOverride, setLlmOverride] = useState<LlmParsedResume | null>(null);
  const handleRecovered = useCallback((llmParsed: LlmParsedResume) => {
    setLlmOverride(llmParsed);
  }, []);

  // When `llmOverride` is set, build a synthetic CascadeResult that merges the
  // LLM-parsed fields into the original result. `rawText` / `markdown` / layout
  // fields stay original — the override is parse-field only. `suggestedEscalation`
  // is cleared to "none" since we've recovered. Score is re-derived from the
  // overridden parse so the readout reflects the LLM result.
  const activeResult: CascadeResult = useMemo(
    () => (llmOverride === null ? result : mergeLlmParse(result, llmOverride)),
    [result, llmOverride],
  );

  const activeScore: AnonymousAtsScore = useMemo(() => {
    if (llmOverride === null) return score;
    return computeAnonymousAtsScore({
      parsed: activeResult.parsed,
      fieldConfidence: activeResult.fieldConfidence,
      triggers: activeResult.triggers,
      rawText: activeResult.rawText,
      sections: activeResult.sections,
    });
  }, [activeResult, llmOverride, score]);

  const isLlmRecovered = llmOverride !== null;

  return (
    // Two stacked surfaces: the score "summary" card on top, the tabbed detail
    // card below. The gap + each card's own border draws the separator the
    // single-card layout lacked (the tab strip reads as its own section).
    <div className="flex flex-col gap-4">
      {/* Escape hatch banner — shown above the score card when the cascade
          flagged a degenerate result and WebGPU is available (#243). */}
      {escapeHatch.isAvailable && (
        <LlmEscapeHatchBanner
          controller={escapeHatch}
          onRecovered={handleRecovered}
        />
      )}

      <Card className="flex flex-col gap-6 shadow-xs">
        <ParsedHeader
          isLlmRecovered={isLlmRecovered}
          hasEdits={edit.hasEdits}
          pages={result.diagnostics.pages}
          elapsedMs={result.diagnostics.elapsedMs}
          onResetAll={edit.resetAll}
          onReset={onReset}
        />

        <AtsScoreReadout score={activeScore} />
        {/* Star-rating feedback (#51). The "Report a parsing gap" affordance
            lives in the "What an ATS misses" bottom section of the Resume Quality
            tab (#273), next to the disagreements it characterizes. */}
        <FeedbackPanel />
      </Card>

      <ResultDetailTabs
        activeResult={activeResult}
        activeScore={activeScore}
        result={result}
        bytes={bytes}
        sourceKind={sourceKind}
        edit={edit}
        jdContext={jdContext}
        analysis={analysis}
        triggerCount={triggerCount}
      />
    </div>
  );
}

// ── LimitedParsingCard ────────────────────────────────────────────────────────

function LimitedParsingCard({
  result,
  onReset,
}: {
  result: CascadeResult;
  onReset: () => void;
}) {
  const links = result.linkAnnotations;
  const uniqueUrls = Array.from(new Set(links.map((l) => l.url)));

  const pages = result.diagnostics.pages;

  return (
    <Card className="flex flex-col gap-5 shadow-xs">
      {/* 1. Header row */}
      <header className="flex items-center justify-between">
        <span className="flex items-center gap-3">
          <StatusBadge tone="limited">Not machine-readable</StatusBadge>
          <span className="text-xs text-content-muted">
            {pages} page{pages === 1 ? "" : "s"}
          </span>
        </span>
        <Button variant="link" className="text-content-primary" onClick={onReset}>
          Try a different PDF
        </Button>
      </header>

      {/* 2. Verdict block */}
      <div role="status">
        <h2 className="text-lg font-semibold">
          A generic parser read almost nothing from this PDF.
        </h2>
        <p className="mt-2 text-sm text-content-secondary">
          Most text-based resume screeners face the same challenge — they see almost nothing.
        </p>
      </div>

      {/* 3. Recovered links — visually primary content */}
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

      {/* 4. Fix hint — plain text, no second CTA button */}
      <p className="text-sm text-content-tertiary">
        Fix: re-export as a text-based PDF — not a scanned image or &ldquo;print to image&rdquo;.
      </p>

      {/* 5. "Why did this happen?" disclosure — collapsed by default */}
      <hr className="border-border-light" />
      <details className="text-sm">
        <summary className="cursor-pointer text-content-secondary hover:text-content-primary">
          Why did this happen?
        </summary>
        <p className="mt-2 text-content-secondary">
          {FONTS_UNMAPPABLE_BLURB}
        </p>
      </details>
    </Card>
  );
}
