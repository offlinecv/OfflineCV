// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { EditableParse } from "../hooks/useEditableParse.ts";
import { Card, StatusBadge, Button, ErrorState } from "@design-system";
import { AtsScoreReadout } from "./features/AtsScoreReadout.tsx";
import { isScoreRevealed } from "../lib/contact.ts";
import { useResumeAnalysisLlm } from "../hooks/useResumeAnalysisLlm.ts";
import { useLlmEscapeHatch } from "../hooks/useLlmEscapeHatch.ts";
import type { LlmRecovery } from "../hooks/useLlmRecovery.ts";
import type { AutosaveResume } from "../hooks/useAutosaveResume.ts";
import { ParsedHeader } from "./features/ParsedHeader.tsx";
import { ResultDetail } from "./features/ResultDetail.tsx";

// LAYOUT_TRIGGER_BLURBS for fonts_unmappable is still needed by LimitedParsingCard.
const FONTS_UNMAPPABLE_BLURB =
  "Text is present in the source but uses custom font encodings that don't decode to characters. Common with Framer, Affinity, and some InDesign exports.";

// Two-column layout warning (#356) — inline, non-blocking. Unlike
// fonts_unmappable, two-column output is still usable, so this renders as a
// warning banner alongside the score rather than replacing the whole card.
const TWO_COLUMN_BLURB =
  "This resume uses a two-column layout. Text extractors often read the columns out of order — merging or interleaving them. The reconstructed text below is what a generic parser actually pulled out; if it looks scrambled, that's the ATS risk. A single-column layout parses most reliably.";

type SourceKind = "pdf" | "docx" | "markdown";

interface ResultProps {
  /** The edit-folded HEURISTIC parse — pre-LLM-override. `recovery` carries the
   *  parse everything downstream actually renders. */
  result: CascadeResult;
  /** PDF bytes for the source preview pane. Absent for DOCX uploads. */
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  onReset: () => void;
  /** Lifted edit state (#82) — threaded to ReconstructedResume for inline edits. */
  edit: EditableParse;
  /** The degenerate-parse recovery result, owned by `App` since #823 so the two
   *  routes into `/jobs/` hand over the RECOVERED fields — see
   *  `useLlmRecovery`. Carries the active parse, its score, its identity token
   *  and the callback the recovery panel reports through. */
  recovery: LlmRecovery;
  /** The PRISTINE-parse identity behind `result` (`useAnalyzedResume.parseKey`).
   *  `result` is edit-folded and re-memoized on every keystroke, so anything
   *  that must reset "when the résumé changed" — here, the recovery pass's own
   *  status — has to key on this instead. */
  parseKey: unknown;
  /** Library persistence for this parse, owned by `App` (#824) and stated by
   *  `ParsedHeader`. Travels whole, like `recovery`, rather than as two props.
   *  Deliberately unused on the `fonts_unmappable` branch below: that parse has
   *  no header and no editor, so it can never accrue an edit to save. */
  autosave: AutosaveResume;
  /** JD steering reported back up so `/`'s rail can mark the Tailor stage
   *  (#812) — see `ResultDetail` for why it travels this way. */
  onJdContextChange?: (jdContext: string | null) => void;
  /** A JD-steered whole-résumé rewrite was applied (#826) — see `ResultDetail`,
   *  which pairs the rewrite event with the steering it owns. */
  onTailorApplied?: () => void;
  /** Opens `FeedbackDialog` (#900) — threaded down to `ParsedHeader`'s
   *  ambient `[★ Feedback]` trigger. `App` owns the dialog itself, since the
   *  automatic export-milestone trigger fires from page level too. */
  onOpenFeedback?: () => void;
}

export function Result({
  result,
  bytes,
  sourceKind,
  onReset,
  edit,
  recovery,
  parseKey,
  autosave,
  onJdContextChange,
  onTailorApplied,
  onOpenFeedback,
}: ResultProps) {
  const isFontsUnmappable = result.triggers.includes("fonts_unmappable");
  if (isFontsUnmappable) {
    // No résumé body on this branch — the rail's stages still resolve to `/`,
    // they just have nothing to scroll to, which is correct: there is nothing
    // parsed to show behind them.
    return <LimitedParsingCard result={result} onReset={onReset} />;
  }
  return (
    <ParsedCard
      result={result}
      bytes={bytes}
      sourceKind={sourceKind}
      onReset={onReset}
      edit={edit}
      recovery={recovery}
      parseKey={parseKey}
      autosave={autosave}
      onJdContextChange={onJdContextChange}
      onTailorApplied={onTailorApplied}
      onOpenFeedback={onOpenFeedback}
    />
  );
}

// ── ParsedCard ────────────────────────────────────────────────────────────────

function ParsedCard({
  result,
  bytes,
  sourceKind,
  onReset,
  edit,
  recovery,
  parseKey,
  autosave,
  onJdContextChange,
  onTailorApplied,
  onOpenFeedback,
}: {
  result: CascadeResult;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
  onReset: () => void;
  edit: EditableParse;
  recovery: LlmRecovery;
  parseKey: unknown;
  autosave: AutosaveResume;
  onJdContextChange?: (jdContext: string | null) => void;
  onTailorApplied?: () => void;
  onOpenFeedback?: () => void;
}) {
  const triggerCount = result.triggers.length;
  const { activeResult, activeScore, parseIdentity, isLlmRecovered } = recovery;

  // Opt-in combined WebLLM analysis (#262, #273). One controller feeds the
  // single on-device-AI surface (the LLM critique plus "What an ATS misses" as
  // a bottom section) from one inference. Lifted here so the section is only
  // advertised on WebGPU-capable browsers with extractable text; on everything
  // else it is silently absent. The panel's single CTA triggers the combined
  // run; status (loading/running/done/error) is owned by the panel.
  const analysis = useResumeAnalysisLlm(result);

  // Degenerate-case LLM escape hatch (#243). Only available when
  // `result.suggestedEscalation === "llm"` AND WebGPU is available AND there is
  // text. Running the pass produces an LLM parse that replaces the heuristic
  // fields across the whole surface.
  //
  // The CONTROLLER is created here — it belongs to the surface showing the
  // offer — while what the pass produces is owned by `App` (`useLlmRecovery`,
  // reaching this component as `recovery`), because two routes into `/jobs/`
  // that `App` owns have to hand over the recovered fields (#823). The panel
  // itself renders inside `ResultDetail`, as its own card between this score
  // card and the résumé: it used to be a full-width banner above the score, so
  // the page opened on our suggestion instead of the user's own result (user
  // testing, Jul 2026: "we should not have 'Try a local AI pass' so prominently
  // at the top"), and between #243 and #823 it lived in the on-device-AI tab —
  // a slot that stopped existing when the tab rail went.
  const escapeHatch = useLlmEscapeHatch(result, parseKey);

  // Score ring/verdict reveal (#313) — the threshold gate is BLANK-AUTHORING
  // ONLY. `ParsedCard` is also the primary "drop a PDF → see your score" view
  // for every ordinary upload, where a missing phone/email or zero experience
  // is a common failure this app exists to FLAG — gating the score there would
  // kill the diagnostic. So on the normal upload path (a real parsed result,
  // `tiers.length > 0`) the score renders unconditionally; the reveal threshold
  // applies only to a blank/authored result (`tiers.length === 0`), mirroring
  // the same blank test `useDownloadPdf` uses. Re-evaluates every render so it
  // live-updates as the user edits.
  const isBlankAuthored = result.tiers.length === 0;
  const scoreRevealed =
    !isBlankAuthored ||
    isScoreRevealed(activeResult.canonical, edit.contactOverrides);

  // Two-column layout warning (#356) — detected but previously never
  // surfaced to the user. Inline, not a full-page takeover: two-column
  // output is still usable, unlike the fonts_unmappable case above.
  const isTwoColumn = result.triggers.includes("two_column");

  return (
    // One scrolling column of stacked surfaces: the score "summary" card, then
    // whatever `ResultDetail` puts under it (the recovery offer when there is
    // one, the résumé, and the two collapsed sections). The gap + each
    // surface's own border draws the separators; nothing here is a tab.
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-6 shadow-xs">
        <ParsedHeader
          isLlmRecovered={isLlmRecovered}
          hasEdits={edit.hasEdits}
          pages={result.diagnostics.pages}
          elapsedMs={result.diagnostics.elapsedMs}
          onResetAll={edit.resetAll}
          onReset={onReset}
          saveState={autosave.state}
          onSave={autosave.save}
          onOpenFeedback={onOpenFeedback}
        />

        {isTwoColumn && (
          <ErrorState tone="warning">{TWO_COLUMN_BLURB}</ErrorState>
        )}

        {scoreRevealed ? (
          <AtsScoreReadout score={activeScore} />
        ) : (
          // No half-populated/near-zero score flashed while contact/experience
          // are still incomplete (#313) — a quiet placeholder instead of the
          // ring, so the section doesn't just silently vanish.
          <p className="text-sm text-content-tertiary">
            Your score will appear once your contact info and at least one
            role are filled in below.
          </p>
        )}
      </Card>

      <ResultDetail
        activeResult={activeResult}
        parseIdentity={parseIdentity}
        activeScore={activeScore}
        result={result}
        bytes={bytes}
        sourceKind={sourceKind}
        edit={edit}
        analysis={analysis}
        escapeHatch={escapeHatch}
        onRecovered={recovery.onRecovered}
        triggerCount={triggerCount}
        onJdContextChange={onJdContextChange}
        onTailorApplied={onTailorApplied}
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
          <span className="text-sm text-content-muted">
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
        <h3 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
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
                  className="font-mono text-sm text-content-secondary underline decoration-dotted hover:decoration-solid"
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
