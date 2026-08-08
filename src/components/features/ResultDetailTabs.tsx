// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { useEffect, useRef, useState } from "react";
import { Card, Tabs, TabList, Tab, TabPanel } from "@design-system";
import { ReconstructedResume } from "./ReconstructedResume.tsx";
import { FindJobsLauncher } from "./FindJobsLauncher.tsx";
import { ResumeQualityPanel } from "./ResumeQualityPanel.tsx";
import { SourceDiagnosticsPanel } from "./SourceDiagnosticsPanel.tsx";
import { WebGpuUnavailableNotice } from "./WebGpuUnavailableNotice.tsx";
import { LlmEscapeHatchPanel } from "./LlmEscapeHatchPanel.tsx";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { EditableParse } from "../../hooks/useEditableParse.ts";
import type { AnalysisController } from "../../hooks/useResumeAnalysisLlm.ts";
import type { EscapeHatchController } from "../../hooks/useLlmEscapeHatch.ts";
import type { LlmParsedResume } from "../../lib/webllm/parse-resume.ts";
import { consumeTailorHandoff } from "../../lib/tailor-handoff.ts";

type SourceKind = "pdf" | "docx" | "markdown";

interface ResultDetailTabsProps {
  activeResult: CascadeResult;
  activeScore: AnonymousAtsScore;
  /** Original (pre-LLM-override) result — passed to SourceDiagnosticsPanel. */
  result: CascadeResult;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  edit: EditableParse;
  analysis: AnalysisController;
  /**
   * Degenerate-parse recovery pass (#243), owned by `ParsedCard` because its
   * result re-grades the score card above this one. Rendered inside the
   * on-device-AI tab rather than as its own banner — see the label logic below.
   */
  escapeHatch: EscapeHatchController;
  /** Forwarded to the recovery banner; `ParsedCard` swaps in the LLM parse. */
  onRecovered: (llmParsed: LlmParsedResume) => void;
  triggerCount: number;
}

export function ResultDetailTabs({
  activeResult,
  activeScore,
  result,
  bytes,
  sourceKind,
  edit,
  analysis,
  escapeHatch,
  onRecovered,
  triggerCount,
}: ResultDetailTabsProps) {
  // `tab` state lives here — only used within this component, not in ParsedCard.
  const [tab, setTab] = useState("reconstructed");

  // JD-driven rewrite steering (#576). Set by a
  // tailor-back handoff from `/jobs/` (a `JobResultCard`'s "Tailor résumé to
  // this job" button, or the paste-a-JD panel below the results) and
  // consumed by the whole-résumé rewrite hook in the Reconstructed tab.
  // Null → generic rewrite prompt (byte-identical pre-#576).
  const [jdContext, setJdContext] = useState<string | null>(null);

  // Consume the one-shot handoff on mount. When present, also switch to the
  // Reconstructed tab — the rewrite affordance lives there, and landing on
  // any other tab would hide the change the user just asked for. The read
  // clears the key, so a manual reload of `/` falls back to a generic
  // rewrite prompt rather than silently keep steering toward a stale JD.
  useEffect(() => {
    const handoff = consumeTailorHandoff();
    if (handoff === null) return;
    setJdContext(handoff.jdContext);
    setTab("reconstructed");
  }, []);

  // Reset when the parse identity changes (LLM escape hatch recovers, a new
  // file). A tailoring instruction derived from one parse must not survive
  // into another — the missing-terms list is grounded in the coverage
  // computed against a specific résumé, and re-using it against a different
  // parse would steer the rewrite toward gaps that may no longer exist.
  //
  // The `mountedRef` guard is what makes the mount-time handoff win against
  // this effect: both effects fire on the first commit, in declaration order,
  // so without the skip the reset would immediately null out the jdContext
  // the handoff just set. After the first firing the guard flips and every
  // real identity change (LLM override applied here, a fresh file remounts
  // the whole tree so nothing to reset) is honoured. Dep is hand-audited
  // (`exhaustive-deps` is NOT enforced in this repo — see CLAUDE.md → Data
  // & hooks): only `activeResult` identity matters here.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setJdContext(null);
  }, [activeResult]);

  // The on-device-AI tab (id `quality`) is the canonical on-device-AI surface
  // (#276). It shows whenever there's résumé text to analyze — either running the live
  // analysis (WebGPU available) OR, when WebGPU can't run here, explaining that
  // in place instead of silently vanishing. `capability === null` (still
  // detecting) and "no text" both leave the tab absent, as before.
  const unavailableCapability =
    analysis.hasText &&
    analysis.capability !== null &&
    analysis.capability !== "available"
      ? analysis.capability
      : null;
  // `escapeHatch.isAvailable` already IMPLIES `analysis.isAvailable` — both gate
  // on `capability === "available"` and on the identical `hasText` expression
  // over the same `result`, and the hatch adds `suggestedEscalation === "llm"`
  // on top. The `||` is therefore redundant today and deliberate anyway: the two
  // gates live in two hooks that can drift, and the failure mode if they do is
  // an unreachable recovery offer — the exact thing this tab now owns.
  const showQualityTab =
    analysis.isAvailable ||
    unavailableCapability !== null ||
    escapeHatch.isAvailable;

  // The recovery offer is what this tab LEADS with while it stands, so the tab
  // label is the offer (user request, Jul 2026: replace the label "when
  // applicable, and use 'Local AI feedback' when it is not"). That buys the
  // offer a permanent slot the layout was already paying for, instead of a
  // banner above the score — but it also means the label is the only pre-click
  // signal that the parse was degenerate, which is why it takes the warn mark
  // too.
  //
  // Gated on `!== "done"`: the hatch stays `isAvailable` after a successful
  // recovery (it is keyed on the ORIGINAL result so the pass can be re-run), so
  // without this the tab would keep inviting a pass the user has already taken.
  const recoveryOffered =
    escapeHatch.isAvailable && escapeHatch.status.kind !== "done";

  // "Local AI feedback", not "AI feedback": in the tab strip the word that
  // matters is the one saying the model runs here. The panel's own heading and
  // the `description` below carry the rest.
  const qualityLabel = recoveryOffered
    ? "Try a local AI pass"
    : "Local AI feedback";

  const qualityDescription = recoveryOffered
    ? "some of your file didn't parse cleanly — a local model can re-read it"
    : analysis.isAvailable
      ? "on-device AI review of your wording"
      : "on-device AI review — needs browser support";

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
            the "Raw text & flags" tab no longer shifts position when the
            conditional on-device-AI tab is absent. The layout-flag count badge
            is promoted to this parent tab so the warning count stays visible
            without opening it.

            Labels name what the user GETS, in words they arrive with. The
            previous set — "Reconstructed resume", "Resume quality", "Source &
            diagnostics" — was our internal vocabulary: in user testing (Jul
            2026) a reader who knows the product still had to open each tab to
            learn what it was ("what is a reconstructed resume? what is a
            parser?"). The `description` subtitle (#519) carries the precise
            meaning; the label only has to be decodable without clicking. Keep
            the ids — they are the tab-switch contract with CritiquePanel and
            ResumeQualityPanel's `onGoToRewrite`. */}
        <TabList aria-label="Parsed result views">
          <Tab
            id="reconstructed"
            description="what a parser read from your file — edit it here"
          >
            Your resume
          </Tab>
          <Tab
            id="find-jobs"
            description="search job boards, ranked by fit to this résumé"
          >
            Find jobs
          </Tab>
          {showQualityTab && (
            <Tab
              id="quality"
              warn={recoveryOffered || !analysis.isAvailable}
              // Same dot, two meanings — so it says which. "setup needed" is
              // right for the WebGPU case and wrong for the recovery one,
              // where nothing is broken in the browser.
              warnLabel={
                recoveryOffered ? "parse needs attention" : "setup needed"
              }
              description={qualityDescription}
            >
              {qualityLabel}
            </Tab>
          )}
          <Tab
            id="diagnostics"
            count={triggerCount}
            description="raw text, layout flags, what went wrong"
          >
            Raw text &amp; flags
          </Tab>
        </TabList>

        <div className="pt-4">
          <TabPanel id="reconstructed">
            <ReconstructedResume
              result={activeResult}
              score={activeScore}
              edit={edit}
              jdContext={jdContext ?? undefined}
              // #608: the critique the on-device-AI tab is already showing
              // feeds the rewrite, so clicking Rewrite acts on the findings the
              // user just read instead of discarding them. Only available once
              // the analysis has completed; every other status contributes
              // nothing and leaves the prompt at its pre-#608 form.
              critique={
                analysis.status.kind === "done"
                  ? analysis.status.critique
                  : undefined
              }
            />
          </TabPanel>
          <TabPanel id="find-jobs">
            {/* The search itself lives on `/jobs/` now; this tab hands the
                parse over and navigates (see FindJobsLauncher). The launcher
                derives its preview query from `parsed` on every change, so the
                PR #337 remount key is no longer needed — a recovered parse
                cannot leave a stale query behind here. */}
            <FindJobsLauncher parsed={activeResult.canonical.fields} />
          </TabPanel>
          {showQualityTab && (
            <TabPanel id="quality">
              {/* One offer at a time. While recovery is on the table this tab
                  shows ONLY the recovery panel: a wording critique of a parse
                  the parser itself flagged as degenerate is close to
                  worthless, and stacking both put two model-loading CTAs on
                  one screen. Once the pass has run (or if it was never
                  offered), the quality panel takes the tab back — with the
                  recovery panel collapsed to its one-line confirmation above,
                  because unmounting it on `done` would kill the effect that
                  reports the recovered parse upward. */}
              {/* The wrapper is unconditional on purpose, even though it is
                  bare when `recoveryOffered`. Only the className varies, so
                  React keeps the same element at this position and the panel
                  stays mounted across the `done` transition. Gating the
                  wrapper itself — rendering the panel bare in one branch and
                  inside a div in the other — changes the element TYPE at this
                  position at the moment recovery completes, which unmounts and
                  remounts the panel in the render that fires `onRecovered`
                  (see LlmEscapeHatchPanel's docblock). Not worth trading a
                  documented mount invariant for one empty div. */}
              {escapeHatch.isAvailable && (
                <div className={recoveryOffered ? undefined : "mb-4"}>
                  <LlmEscapeHatchPanel
                    controller={escapeHatch}
                    onRecovered={onRecovered}
                  />
                </div>
              )}
              {!recoveryOffered &&
                (analysis.isAvailable ? (
                /* onGoToRewrite: switch back to reconstructed tab where the
                   per-role wand button (#3 / useSectionRewrite) already lives.
                   The quality panel links each flagged bullet to this affordance
                   instead of building a parallel rewrite UI (issue #244, #273). */
                <ResumeQualityPanel
                  controller={analysis}
                  result={activeResult}
                  onGoToRewrite={() => setTab("reconstructed")}
                />
              ) : (
                /* WebGPU can't run here — explain in place instead of hiding
                   the tab (#276). Still guarded: `showQualityTab` now has a
                   third opener (`escapeHatch.isAvailable`), and while that one
                   implies `analysis.isAvailable` — so it takes the branch above,
                   never this one — the guard is what makes that reasoning
                   non-load-bearing. */
                  unavailableCapability && (
                    <WebGpuUnavailableNotice capability={unavailableCapability} />
                  )
                ))}
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
