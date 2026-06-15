// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { getScoreLabel, getScoreTier } from "../lib/score/score.ts";
import { Card } from "./shared/Card.tsx";
import { StatusBadge } from "./shared/StatusBadge.tsx";
import { Button } from "./ui/Button.tsx";
import { FeedbackControl } from "./features/FeedbackControl.tsx";
import { ReconstructedResume } from "./features/ReconstructedResume.tsx";
import { AtsScoreReadout } from "./features/AtsScoreReadout.tsx";
import { EvidencePanel } from "./features/EvidencePanel.tsx";

// LAYOUT_TRIGGER_BLURBS for fonts_unmappable is still needed by LimitedParsingCard.
const FONTS_UNMAPPABLE_BLURB =
  "Text is present in the source but uses custom font encodings that don't decode to characters. Common with Framer, Affinity, and some InDesign exports.";

type SourceKind = "pdf" | "docx";

interface ResultProps {
  result: CascadeResult;
  score: AnonymousAtsScore;
  /** PDF bytes for the source preview pane. Absent for DOCX uploads. */
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  onReset: () => void;
}

export function Result({ result, score, bytes, sourceKind, onReset }: ResultProps) {
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
}: {
  result: CascadeResult;
  score: AnonymousAtsScore;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  onReset: () => void;
}) {
  return (
    <Card className="flex flex-col gap-6 shadow-sm">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusBadge tone="ok">Parsed</StatusBadge>
          <span className="text-xs text-content-muted">
            {result.diagnostics.pages} page
            {result.diagnostics.pages === 1 ? "" : "s"} ·{" "}
            {result.diagnostics.elapsedMs} ms
          </span>
          <FeedbackControl
            verdictBand={getScoreLabel(getScoreTier(score.overall))}
          />
        </div>
        <Button variant="link" onClick={onReset}>
          Try another file
        </Button>
      </header>

      <AtsScoreReadout score={score} />
      <ReconstructedResume result={result} score={score} />

      {/* Evidence — how a generic extractor read this file. Reference
          material, so it sits below the score and per-bullet findings.
          Layout flags head the block (the verdict); the preview and
          extracted-text panes are the raw material under it. Both panes are
          height-bounded so a two-page resume scrolls inside the row instead
          of pushing it open. */}
      <EvidencePanel result={result} bytes={bytes} sourceKind={sourceKind} />
    </Card>
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

  return (
    <Card className="flex flex-col gap-5 shadow-sm">
      <header className="flex items-center justify-between">
        <StatusBadge tone="limited">Limited parsing</StatusBadge>
        <Button variant="link" className="text-content-primary" onClick={onReset}>
          Try a different PDF
        </Button>
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
          {FONTS_UNMAPPABLE_BLURB}
        </p>
      </section>
    </Card>
  );
}
