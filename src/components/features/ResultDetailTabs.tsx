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
import { useTailorHandoff } from "../../hooks/useTailorHandoff.ts";

type SourceKind = "pdf" | "docx" | "markdown";

interface ResultDetailTabsProps {
  activeResult: CascadeResult;
  /**
   * Opaque identity of the parse behind `activeResult` — see
   * `Result.tsx`'s `parseIdentity`. Changes when the résumé is genuinely
   * replaced (a library load, an escape-hatch re-parse) and NOT when the user
   * edits one, which `activeResult`'s own identity cannot distinguish.
   */
  parseIdentity: unknown;
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
  /**
   * A tab this surface's journey rail (#812) wants opened. Three of the five
   * L1 stages — Fix it, Tailor, Download — all live behind the `reconstructed`
   * tab, so picking one has to land there even when the user is on another.
   *
   * Carries a `nonce` because the ID alone is not an event: asking for the tab
   * you are already on is a legitimate, repeatable click (it also scrolls the
   * page back to the top), and an id-keyed effect would fire once and then go
   * quiet.
   */
  requestedTab?: { id: string; nonce: number };
  /**
   * Reports the JD steering this component consumed, so `/` can mark the
   * Tailor stage on the rail.
   *
   * Deliberately a callback UP rather than a lift of `useTailorHandoff` into
   * `App`: `consumeTailorHandoff` clears the sessionStorage key
   * unconditionally, INCLUDING on a fingerprint mismatch, so a copy of that
   * hook mounted at `App` — where the résumé is absent in `idle`/`parsing` and
   * only arrives later, via auto-restore or a drop — would drain the payload
   * against the wrong parse before the real consumer ever sees it. Keeping the
   * hook here preserves all three invariants its docblock documents; only the
   * resulting value travels.
   */
  onJdContextChange?: (jdContext: string | null) => void;
}

export function ResultDetailTabs({
  activeResult,
  parseIdentity,
  activeScore,
  result,
  bytes,
  sourceKind,
  edit,
  analysis,
  escapeHatch,
  onRecovered,
  triggerCount,
  requestedTab,
  onJdContextChange,
}: ResultDetailTabsProps) {
  // `tab` state lives here — only used within this component, not in ParsedCard.
  const [tab, setTab] = useState("reconstructed");

  // JD-driven rewrite steering (#576): the instruction a tailor-back handoff
  // from `/jobs/` (a `JobResultCard`'s "Tailor résumé to this job" button, or
  // the paste-a-JD panel below the results) left for this page, forwarded to
  // the whole-résumé rewrite hook in the Reconstructed tab. Null → generic
  // rewrite prompt (byte-identical pre-#576).
  //
  // The lifecycle — a return leg that is a bfcache restore rather than a
  // remount, a payload that must be matched to THIS parse, and a reset that
  // must survive edits — lives in the hook, which is the only place all three
  // are visible at once. Landing on the Reconstructed tab is this component's
  // half: the steering is worthless if the rewrite affordance is off screen.
  const jdContext = useTailorHandoff({
    fields: activeResult.canonical.fields,
    parseIdentity,
    onConsumed: () => setTab("reconstructed"),
  });

  // Latest-value ref so the report effect below can depend on `jdContext`
  // ALONE. Depending on the callback too would re-fire on every render of a
  // caller that passes an inline closure, which is every caller.
  const onJdContextChangeRef = useRef(onJdContextChange);
  useEffect(() => {
    onJdContextChangeRef.current = onJdContextChange;
  });
  useEffect(() => {
    onJdContextChangeRef.current?.(jdContext);
    // Deps hand-audited both directions (`exhaustive-deps` is NOT enforced —
    // CLAUDE.md): `jdContext` is the whole payload and the only thing whose
    // change the parent cares about; the callback is read through the ref
    // above precisely so it cannot add a re-fire of its own. The initial run
    // (reporting `null`) is wanted — it is what clears a stale mark when this
    // component remounts onto a résumé with no steering.
  }, [jdContext]);

  // The rail's landing request (#812). Keyed on the NONCE, with `id` listed
  // because the body reads it — the two always move together, so `id` adds no
  // fire of its own. Cannot fight `onConsumed` above: that fires when a tailor
  // handoff is absorbed (an arrival from `/jobs/`), this fires on a rail click
  // in THIS document, and neither can happen inside the other's commit. Both
  // would in any case be asking for the same tab.
  const requestedNonce = requestedTab?.nonce;
  const requestedId = requestedTab?.id;
  useEffect(() => {
    if (requestedId === undefined) return;
    setTab(requestedId);
  }, [requestedNonce, requestedId]);

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
