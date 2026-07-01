// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useState } from "react";
import { Card, Tabs, TabList, Tab, TabPanel } from "@design-system";
import { ReconstructedResume } from "./ReconstructedResume.tsx";
import { DisagreementPanel } from "./DisagreementPanel.tsx";
import { ReportGapSection } from "./ReportGapSection.tsx";
import { CritiquePanel } from "./CritiquePanel.tsx";
import { SourceDiagnosticsPanel } from "./SourceDiagnosticsPanel.tsx";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { EditableParse } from "../../hooks/useEditableParse.ts";
import type { AnalysisController } from "../../hooks/useResumeAnalysisLlm.ts";
import type { ParseDisagreement } from "../../lib/heuristics/disagreement.ts";

type SourceKind = "pdf" | "docx";

interface ResultDetailTabsProps {
  activeResult: CascadeResult;
  activeScore: AnonymousAtsScore;
  /** Original (pre-LLM-override) result — passed to SourceDiagnosticsPanel. */
  result: CascadeResult;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  edit: EditableParse;
  jdContext?: string;
  analysis: AnalysisController;
  reportableDisagreements: readonly ParseDisagreement[] | undefined;
  triggerCount: number;
}

// Tab-visibility gate for the "Resume quality" critique tab (#262). The tab
// additionally requires something worth critiquing — a bullet description or a
// summary. Without this gate, the critique tab would render "All bullets look
// strong" for a resume that has no bullets at all, which reads as a bug.
// Extracted as a module-level helper to keep ResultDetailTabs' cyclomatic low.
// Returns true when any experience entry carries a non-empty description string.
// Extracted so that deriveIsCritiqueVisible stays below the cyclomatic threshold.
function hasDescriptiveBullets(experience: CascadeResult["parsed"]["experience"]): boolean {
  return (
    Array.isArray(experience) &&
    experience.some(
      (e) => typeof e.description === "string" && e.description.trim().length > 0,
    )
  );
}

function deriveIsCritiqueVisible(
  activeResult: CascadeResult,
  isAvailable: boolean,
): boolean {
  const hasSummary =
    typeof activeResult.parsed.summary === "string" &&
    activeResult.parsed.summary.trim().length > 0;
  return isAvailable && (hasDescriptiveBullets(activeResult.parsed.experience) || hasSummary);
}

export function ResultDetailTabs({
  activeResult,
  activeScore,
  result,
  bytes,
  sourceKind,
  edit,
  jdContext,
  analysis,
  reportableDisagreements,
  triggerCount,
}: ResultDetailTabsProps) {
  // `tab` state lives here — only used within this component, not in ParsedCard.
  const [tab, setTab] = useState("reconstructed");

  // Tab-visibility split (preserves the old per-controller availability gates
  // even though one controller now drives both tabs, #262). The
  // "What an ATS misses" tab shows whenever the analysis is available
  // (WebGPU + extractable text). The "Resume quality" tab additionally requires
  // something worth critiquing — see deriveIsCritiqueVisible above.
  const isCritiqueVisible = deriveIsCritiqueVisible(activeResult, analysis.isAvailable);

  return (
    /* Detail sits behind tabs in its own card so only one panel shows at a
       time and every panel is advertised by a label (issue #177). All panels
       stay mounted (hidden when inactive) so the reconstructed resume keeps
       any local UI state across tab switches — overrides themselves live in
       App/useEditableParse. */
    <Card className="flex flex-col shadow-xs">
      <Tabs id="result" value={tab} onValueChange={setTab}>
        {/* Primary tabs ordered by value: insight first, evidence last
            (#263). The evidence tab is always present and always last, so the
            "Source & diagnostics" tab no longer shifts position when the two
            conditional insight tabs are absent. The layout-flag count badge is
            promoted to this parent tab so the warning count stays visible
            without opening it. */}
        <TabList aria-label="Parsed result views">
          <Tab id="reconstructed">Reconstructed resume</Tab>
          {analysis.isAvailable && (
            <Tab id="disagreement">What an ATS misses</Tab>
          )}
          {isCritiqueVisible && <Tab id="critique">Resume quality</Tab>}
          <Tab id="diagnostics" count={triggerCount}>
            Source &amp; diagnostics
          </Tab>
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
          {analysis.isAvailable && (
            <TabPanel id="disagreement">
              <div className="flex flex-col gap-4">
                <DisagreementPanel controller={analysis} />
                {/* The gap report lives here (moved out of the score header):
                    it builds a structure-only repro artifact from the active
                    parse; when the comparison has run (#242), the characterized
                    disagreements ride along (kinds only, never values). */}
                <ReportGapSection
                  result={activeResult}
                  disagreements={reportableDisagreements}
                />
              </div>
            </TabPanel>
          )}
          {isCritiqueVisible && (
            <TabPanel id="critique">
              {/* onGoToRewrite: switch back to reconstructed tab where the
                  per-role wand button (#3 / useSectionRewrite) already lives.
                  The critique panel links each flagged bullet to this affordance
                  instead of building a parallel rewrite UI (issue #244). */}
              <CritiquePanel
                controller={analysis}
                onGoToRewrite={() => setTab("reconstructed")}
              />
            </TabPanel>
          )}
          <TabPanel id="diagnostics">
            <SourceDiagnosticsPanel
              result={result}
              bytes={bytes}
              sourceKind={sourceKind}
            />
          </TabPanel>
        </div>
      </Tabs>
    </Card>
  );
}
