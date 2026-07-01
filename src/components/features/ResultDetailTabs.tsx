// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useState } from "react";
import { Card, Tabs, TabList, Tab, TabPanel } from "@design-system";
import { ReconstructedResume } from "./ReconstructedResume.tsx";
import { ResumeQualityPanel } from "./ResumeQualityPanel.tsx";
import { SourceDiagnosticsPanel } from "./SourceDiagnosticsPanel.tsx";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { EditableParse } from "../../hooks/useEditableParse.ts";
import type { AnalysisController } from "../../hooks/useResumeAnalysisLlm.ts";

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
  triggerCount: number;
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
  triggerCount,
}: ResultDetailTabsProps) {
  // `tab` state lives here — only used within this component, not in ParsedCard.
  const [tab, setTab] = useState("reconstructed");

  return (
    /* Detail sits behind tabs in its own card so only one panel shows at a
       time and every panel is advertised by a label (issue #177). All panels
       stay mounted (hidden when inactive) so the reconstructed resume keeps
       any local UI state across tab switches — overrides themselves live in
       App/useEditableParse. */
    <Card className="flex flex-col shadow-xs">
      <Tabs id="result" value={tab} onValueChange={setTab}>
        {/* Primary tabs ordered by value: insight first, evidence last
            (#263, #273). The evidence tab is always present and always last, so
            the "Source & diagnostics" tab no longer shifts position when the
            conditional Resume Quality tab is absent. The layout-flag count badge
            is promoted to this parent tab so the warning count stays visible
            without opening it. */}
        <TabList aria-label="Parsed result views">
          <Tab id="reconstructed">Reconstructed resume</Tab>
          {analysis.isAvailable && <Tab id="quality">Resume Quality</Tab>}
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
            <TabPanel id="quality">
              {/* onGoToRewrite: switch back to reconstructed tab where the
                  per-role wand button (#3 / useSectionRewrite) already lives.
                  The quality panel links each flagged bullet to this affordance
                  instead of building a parallel rewrite UI (issue #244, #273). */}
              <ResumeQualityPanel
                controller={analysis}
                result={activeResult}
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
