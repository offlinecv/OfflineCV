// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ResultDetail — everything on `/` below the score card. Was
 * `ResultDetailTabs` until #823 took the tab rail off it.
 *
 * The rail went because #812 put an L1 journey rail in the header and two of
 * its stages meant the same thing as two of these tabs: `Fix it` landed on
 * `Your resume`, and `Match jobs` and `Find jobs` ran the SAME
 * `departToJobsAndNavigate`. A page with two navigation rails, two of whose
 * entries are synonyms, is worse than either alone — the reader has to work out
 * whether they are the same place. So L1 owns navigation now and this surface
 * is a single scrolling column:
 *
 *   the reconstructed résumé            ← the page body, no click to reach it
 *   ▸ Raw text & flags                  ← collapsed
 *
 * It is two surfaces shorter than it was. `TargetingSection` used to open the
 * résumé card, between the contact block and the document; the recovery offer
 * was a card above it and "Local AI feedback" a disclosure below. #955 moved
 * all three UP into the score card's details region (`ScoreDetails`, mounted
 * by `Result`), so the score and the reasons it is not 100 sit in one surface
 * and dock together. `useSkillsReorder` went with the targeting section — it
 * was owned here only to feed it, and there must stay EXACTLY ONE instance of
 * it (see `SkillTermGuidance`'s docblock), so it moved rather than being
 * copied. Only "Raw text & flags" stayed: it is evidence about the file, not a
 * reason the score is what it is, and it belongs under the document it
 * describes.
 *
 * Two things a future edit must not undo:
 *
 *  1. **The disclosure keeps its children MOUNTED.** That is why it is
 *     `Disclosure` (native `<details>`) and not an overflow menu: unmounting
 *     `SourceDiagnosticsPanel` would discard its panel state and re-rasterize
 *     the PDF on every reopen. Never gate its children on an open flag. The
 *     same rule now also governs the region the other two moved into — see
 *     `ScoreDetails`, which docks them with `hidden` rather than unmounting.
 *
 *  2. **The two former tab-switch call sites are anchor scrolls now, not
 *     no-ops.** `ResumeQualityPanel`'s "go to rewrite" and a consumed tailor
 *     handoff both used `setTab("reconstructed")`; both now scroll to
 *     `SECTION_IDS.reconstructed`. The reason is unchanged and still
 *     load-bearing: JD steering is worthless if the rewrite affordance is off
 *     screen. The first of those call sites lives in `Result` now, with the
 *     panel; the second is still here.
 *
 * Labels are byte-identical to the tabs they replace — renaming "Raw text &
 * flags" belongs to #680 item 4, and doing it here would collide with it.
 */

import { useEffect, useRef } from "react";
import { Card, Disclosure } from "@design-system";
import { ReconstructedResume } from "./ReconstructedResume.tsx";
import { SourceDiagnosticsPanel } from "./SourceDiagnosticsPanel.tsx";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { EditableParse } from "../../hooks/useEditableParse.ts";
import type { AnalysisController } from "../../hooks/useResumeAnalysisLlm.ts";
import { useTailorHandoff } from "../../hooks/useTailorHandoff.ts";
import { SECTION_IDS, scrollToSection } from "../../lib/anchors.ts";

type SourceKind = "pdf" | "docx" | "markdown";

interface ResultDetailProps {
  activeResult: CascadeResult;
  /**
   * Opaque identity of the parse behind `activeResult` — see
   * `useLlmRecovery`'s `parseIdentity`. Changes when the résumé is genuinely
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
  /** Still threaded here after #955 moved the panel out: a completed critique
   *  is what `ReconstructedResume`'s rewrite acts on (#608), so this component
   *  reads `analysis.status` for that one prop and renders none of it. */
  analysis: AnalysisController;
  triggerCount: number;
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
  /**
   * A whole-résumé rewrite completed WHILE a JD was steering it — the journey's
   * `Tailor` stage, done (#826).
   *
   * The two halves of that sentence live in two different places and this
   * component is where they meet: the applied transition is
   * `useResumeRewrite`'s `confirmApplied`, four levels down inside
   * `ReconstructedResume`, and the steering is `jdContext` below, which this
   * component consumes and nobody underneath it can distinguish from a
   * user-typed instruction. Reported up rather than recorded here for the same
   * reason `onJdContextChange` is: the ledger key belongs to `App`, which is
   * the only surface that holds the PRISTINE parse it is derived from.
   */
  onTailorApplied?: () => void;
}

export function ResultDetail({
  activeResult,
  parseIdentity,
  activeScore,
  result,
  bytes,
  sourceKind,
  edit,
  analysis,
  triggerCount,
  onJdContextChange,
  onTailorApplied,
}: ResultDetailProps) {
  // JD-driven rewrite steering (#576): the instruction a tailor-back handoff
  // from `/jobs/` (a `JobResultCard`'s "Tailor résumé to this job" button, or
  // the paste-a-JD panel below the results) left for this page, forwarded to
  // the whole-résumé rewrite hook inside `ReconstructedResume`. Null → generic
  // rewrite prompt (byte-identical pre-#576).
  //
  // The lifecycle — a return leg that is a bfcache restore rather than a
  // remount, a payload that must be matched to THIS parse, and a reset that
  // must survive edits — lives in the hook, which is the only place all three
  // are visible at once. Bringing the résumé on screen is this component's
  // half: the steering is worthless if the rewrite affordance is off screen.
  // The résumé is always mounted now, so that is a scroll rather than the tab
  // switch it used to be — and it fires from a `ResultDetail` effect, which
  // React runs after its children have committed, so the target id is already
  // in the document.
  const jdContext = useTailorHandoff({
    fields: activeResult.canonical.fields,
    parseIdentity,
    onConsumed: () => scrollToSection(SECTION_IDS.reconstructed),
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

  return (
    <>
      <Card className="shadow-xs">
        <ReconstructedResume
          result={activeResult}
          score={activeScore}
          edit={edit}
          jdContext={jdContext ?? undefined}
          // The `Tailor` stage is "a rewrite completed while a JD steered it",
          // so the gate is read at the moment of the event rather than
          // threaded down as a second prop the layers below would have to keep
          // in step with the first (#826).
          onRewriteApplied={() => {
            if (jdContext !== null) onTailorApplied?.();
          }}
          // #608: the critique the on-device-AI section is already showing
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
      </Card>

      {/* Always present and always last — evidence after insight (#263, #273).
          The layout-flag count rides the summary row so the warning count stays
          visible without opening the section, exactly as it did on the tab. */}
      <Disclosure summary="Raw text & flags" count={triggerCount}>
        <SourceDiagnosticsPanel
          result={result}
          bytes={bytes}
          sourceKind={sourceKind}
        />
      </Disclosure>
    </>
  );
}
