// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useState } from "react";
import type { CascadeResult, LayoutTrigger } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import type { EditableParse } from "../hooks/useEditableParse.ts";
import { Card, StatusBadge, Button, Tabs, TabList, Tab, TabPanel } from "@design-system";
import { FeedbackPanel } from "./features/FeedbackPanel.tsx";
import { ReconstructedResume } from "./features/ReconstructedResume.tsx";
import { AtsScoreReadout } from "./features/AtsScoreReadout.tsx";
import { LayoutFlagsList } from "./features/LayoutFlagsList.tsx";
import {
  SourcePdfPanel,
  ExtractedTextPanel,
} from "./features/EvidencePanel.tsx";

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
}

export function Result({
  result,
  score,
  bytes,
  sourceKind,
  onReset,
  edit,
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
}: {
  result: CascadeResult;
  score: AnonymousAtsScore;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  onReset: () => void;
  edit: EditableParse;
}) {
  const [tab, setTab] = useState("reconstructed");
  const triggerCount = result.triggers.length;
  return (
    <Card className="flex flex-col gap-6 shadow-xs">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusBadge tone="ok">Parsed</StatusBadge>
          {edit.hasEdits && <StatusBadge tone="warning">Edited</StatusBadge>}
          <span className="text-xs text-content-muted">
            {result.diagnostics.pages} page
            {result.diagnostics.pages === 1 ? "" : "s"} ·{" "}
            {result.diagnostics.elapsedMs} ms
          </span>
        </div>
        <div className="flex items-center gap-3">
          {edit.hasEdits && (
            <Button variant="link" onClick={edit.resetAll}>
              Reset to parsed
            </Button>
          )}
          <Button variant="link" onClick={onReset}>
            Try another file
          </Button>
        </div>
      </header>

      <AtsScoreReadout score={score} />
      <FeedbackPanel />

      {/* Score stays pinned above; the detail sits behind tabs so only one
          panel shows at a time and every panel is advertised by a label
          (issue #177). All panels stay mounted (hidden when inactive) so the
          reconstructed resume keeps any local UI state across tab switches —
          overrides themselves live above in App/useEditableParse. */}
      <Tabs id="result" value={tab} onValueChange={setTab}>
        <TabList aria-label="Parsed result views">
          <Tab id="reconstructed">Reconstructed resume</Tab>
          <Tab id="source">Source PDF</Tab>
          <Tab id="extracted">Extracted text</Tab>
          <Tab id="flags" count={triggerCount}>
            Layout flags
          </Tab>
        </TabList>

        <div className="pt-4">
          <TabPanel id="reconstructed">
            <ReconstructedResume result={result} score={score} edit={edit} />
          </TabPanel>
          <TabPanel id="source">
            <SourcePdfPanel bytes={bytes} sourceKind={sourceKind} />
          </TabPanel>
          <TabPanel id="extracted">
            <ExtractedTextPanel result={result} />
          </TabPanel>
          <TabPanel id="flags">
            <LayoutFlagsList
              triggers={result.triggers as readonly LayoutTrigger[]}
            />
          </TabPanel>
        </div>
      </Tabs>
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
    <Card className="flex flex-col gap-5 shadow-xs">
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
