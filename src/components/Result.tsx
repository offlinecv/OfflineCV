// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useCallback, useMemo, useState } from "react";
import type { CascadeResult, LayoutTrigger } from "../lib/heuristics/types.ts";
import { computeAnonymousAtsScore, type AnonymousAtsScore } from "../lib/score/score.ts";
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
import { DisagreementPanel } from "./features/DisagreementPanel.tsx";
import { CritiquePanel } from "./features/CritiquePanel.tsx";
import { useParseDisagreement } from "../hooks/useParseDisagreement.ts";
import { useLlmEscapeHatch } from "../hooks/useLlmEscapeHatch.ts";
import { useResumeCritique } from "../hooks/useResumeCritique.ts";
import { LlmEscapeHatchBanner } from "./features/LlmEscapeHatchBanner.tsx";
import type { LlmParsedResume } from "../lib/webllm/parse-resume.ts";

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
  const [tab, setTab] = useState("reconstructed");
  const triggerCount = result.triggers.length;

  // Opt-in WebLLM "what an ATS misses" comparison (#242). The controller is
  // lifted here so the tab is only advertised on WebGPU-capable browsers with
  // extractable text; on everything else the tab (and panel) are silently
  // absent. The panel itself drives the opt-in run + diff.
  const disagreement = useParseDisagreement(result);

  // Characterized gaps to fold into a "Report a parsing gap" download (#245) —
  // available only once the opt-in WebLLM comparison has completed. Kinds/fields
  // only enter the artifact (never the recovered values); see repro-artifact.ts.
  const reportableDisagreements =
    disagreement.status.kind === "done"
      ? disagreement.status.disagreements
      : undefined;

  // Degenerate-case LLM escape hatch (#243). Only available when
  // `result.suggestedEscalation === "llm"` AND WebGPU is available AND there is
  // text. When the user opts in and the pass completes, `llmOverride` is set and
  // the entire result surface re-renders from the LLM-parsed fields.
  const escapeHatch = useLlmEscapeHatch(result);
  const [llmOverride, setLlmOverride] = useState<LlmParsedResume | null>(null);
  const handleRecovered = useCallback((llmParsed: LlmParsedResume) => {
    setLlmOverride(llmParsed);
  }, []);

  // When `llmOverride` is set, build a synthetic CascadeResult that merges the
  // LLM-parsed fields into the original result. `rawText` / `markdown` / layout
  // fields stay original — the override is parse-field only. `suggestedEscalation`
  // is cleared to "none" since we've recovered. Score is re-derived from the
  // overridden parse so the readout reflects the LLM result.
  const activeResult: CascadeResult = useMemo(() => {
    if (llmOverride === null) return result;
    return {
      ...result,
      suggestedEscalation: "none",
      parsed: {
        ...result.parsed,
        full_name: llmOverride.full_name ?? result.parsed.full_name,
        email: llmOverride.email ?? result.parsed.email,
        phone: llmOverride.phone ?? result.parsed.phone,
        location: llmOverride.location ?? result.parsed.location,
        summary: llmOverride.summary ?? result.parsed.summary,
        skills: llmOverride.skills.length > 0 ? llmOverride.skills : result.parsed.skills,
        experience: llmOverride.experience.length > 0
          ? llmOverride.experience.map((e) => ({
              company: e.company,
              title: e.title,
              description: e.description,
              is_current: false,
            }))
          : result.parsed.experience,
        education: llmOverride.education.length > 0
          ? llmOverride.education.map((e) => ({
              institution: e.institution,
              degree: e.degree,
            }))
          : result.parsed.education,
      },
    };
  }, [result, llmOverride]);

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

  // Opt-in WebLLM content-quality critique (#244). Runs on the active parsed
  // result so that when the #243 escape hatch has recovered the parse, the
  // critique judges the improved fields rather than the raw heuristic output.
  // Must be called AFTER activeResult is computed (hooks ordering is stable
  // because activeResult is a useMemo, not a conditional render path).
  const critique = useResumeCritique(activeResult.parsed, activeResult.rawText);

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
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <StatusBadge tone="ok">Parsed</StatusBadge>
            {isLlmRecovered && (
              <StatusBadge tone="info">Recovered with on-device AI</StatusBadge>
            )}
            {!isLlmRecovered && edit.hasEdits && (
              <StatusBadge tone="warning">Edited</StatusBadge>
            )}
            <span className="text-xs text-content-muted">
              {result.diagnostics.pages} page
              {result.diagnostics.pages === 1 ? "" : "s"} ·{" "}
              {result.diagnostics.elapsedMs} ms
            </span>
          </div>
          <div className="flex items-center gap-3">
            {!isLlmRecovered && edit.hasEdits && (
              <Button variant="link" onClick={edit.resetAll}>
                Reset to parsed
              </Button>
            )}
            <Button variant="link" onClick={onReset}>
              Try another file
            </Button>
          </div>
        </header>

        <AtsScoreReadout score={activeScore} />
        {/* Feedback surface (#51) + "Report a parsing gap" (#245). The gap
            report builds a structure-only repro artifact from the active parse;
            when the user ran the opt-in WebLLM comparison (#242), the
            characterized disagreements ride along (kinds only, never values). */}
        <FeedbackPanel
          result={activeResult}
          disagreements={reportableDisagreements}
        />
      </Card>

      {/* Detail sits behind tabs in its own card so only one panel shows at a
          time and every panel is advertised by a label (issue #177). All panels
          stay mounted (hidden when inactive) so the reconstructed resume keeps
          any local UI state across tab switches — overrides themselves live in
          App/useEditableParse. */}
      <Card className="flex flex-col shadow-xs">
        <Tabs id="result" value={tab} onValueChange={setTab}>
          <TabList aria-label="Parsed result views">
            <Tab id="reconstructed">Reconstructed resume</Tab>
            <Tab id="source">Source PDF</Tab>
            <Tab id="extracted">Extracted text</Tab>
            <Tab id="flags" count={triggerCount}>
              Layout flags
            </Tab>
            {disagreement.isAvailable && (
              <Tab id="disagreement">What an ATS misses</Tab>
            )}
            {critique.isAvailable && (
              <Tab id="critique">Resume quality</Tab>
            )}
          </TabList>

          <div className="pt-4">
            <TabPanel id="reconstructed">
              <ReconstructedResume
                result={activeResult}
                score={activeScore}
                edit={edit}
                jdContext={jdContext}
              />
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
            {disagreement.isAvailable && (
              <TabPanel id="disagreement">
                <DisagreementPanel controller={disagreement} />
              </TabPanel>
            )}
            {critique.isAvailable && (
              <TabPanel id="critique">
                {/* onGoToRewrite: switch back to reconstructed tab where the
                    per-role wand button (#3 / useSectionRewrite) already lives.
                    The critique panel links each flagged bullet to this affordance
                    instead of building a parallel rewrite UI (issue #244). */}
                <CritiquePanel
                  controller={critique}
                  onGoToRewrite={() => setTab("reconstructed")}
                />
              </TabPanel>
            )}
          </div>
        </Tabs>
      </Card>
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
