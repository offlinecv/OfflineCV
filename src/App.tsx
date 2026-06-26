// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useEffect, useMemo, useState } from "react";
import { Chip, ErrorState, ErrorBoundary, UpdateBanner, GitHubStarCta } from "@design-system";
import { useGitHubStars } from "./hooks/useGitHubStars.ts";
import { DropZone } from "./components/DropZone";
import { Result } from "./components/Result";
import { JdMatch } from "./components/features/JdMatch.tsx";
import { JdInput } from "./components/features/JdInput.tsx";
import { useResumeAnalysis } from "./hooks/useResumeAnalysis.ts";
import { useEditableParse } from "./hooks/useEditableParse.ts";
import { useUpdateChecker } from "./hooks/useUpdateChecker.ts";
import { applyOverrides } from "./lib/edit/apply-overrides.ts";
import { computeAnonymousAtsScore } from "./lib/score/score.ts";
import { extractJdTerms, computeCoverage } from "./lib/jd-match";

export default function App() {
  const { state, handleFile, reset, formatBytes } = useResumeAnalysis();
  const { count: starCount } = useGitHubStars();
  const [jdText, setJdText] = useState("");

  // Proactive stale-deploy notice (see useUpdateChecker). Dismissable so a user
  // mid-analysis can defer; the vite:preloadError backstop still catches a hard
  // chunk failure if they ignore it.
  const { updateAvailable, reload } = useUpdateChecker();
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Lifted edit state (#82): overrides live ABOVE the scorer so a corrected
  // name/title/company/bullet re-grades the ATS score + JD coverage, not just
  // the display. Cleared on a new file via the effect below.
  const edit = useEditableParse();
  const { resetAll } = edit;

  // Fold overrides back into a fresh { parsed, rawText } and re-grade live.
  // When `state` isn't "done" there's nothing to apply — the memo returns null
  // and the original score is used as-is.
  const edited = useMemo(() => {
    if (state.phase !== "done") return null;
    const observations = state.score.bullets ?? [];
    const { parsed, rawText, sections } = applyOverrides(
      state.result.parsed,
      state.result.rawText,
      state.result.sections,
      edit.contactOverrides,
      edit.experienceOverrides,
      edit.bulletOverrides,
      observations,
      edit.educationOverrides,
      edit.skillsOverride,
      edit.addedEntries,
      edit.addedBullets,
    );
    // The anonymous scorer pools its bullet set from `sections` (#133), so the
    // edited section view — not the original — must feed re-grading or a live
    // bullet edit would not move Specificity / Structure.
    const score = computeAnonymousAtsScore({
      parsed,
      fieldConfidence: state.result.fieldConfidence,
      triggers: state.result.triggers,
      rawText,
      sections,
    });
    return { parsed, rawText, score };
  }, [
    state,
    edit.contactOverrides,
    edit.experienceOverrides,
    edit.bulletOverrides,
    edit.educationOverrides,
    edit.skillsOverride,
    edit.addedEntries,
    edit.addedBullets,
  ]);

  // Clear edits whenever a fresh parse lands (new file or reset).
  useEffect(() => {
    resetAll();
    // Keying on the parsed object identity: a new parse → new reference.
  }, [state.phase === "done" ? state.result : null, resetAll]);

  const jdMatch = useMemo(() => {
    const trimmed = jdText.trim();
    if (trimmed.length === 0) return null;
    if (state.phase !== "done" || !edited) return null;
    const extracted = extractJdTerms(trimmed);
    if (extracted.all.length === 0) return null;
    const coverage = computeCoverage(edited.parsed, extracted.all);
    return { extracted, coverage };
  }, [jdText, state, edited]);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-10">
      {updateAvailable && !updateDismissed && (
        <UpdateBanner
          onReload={reload}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}

      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-grid h-8 w-8 place-items-center rounded-md bg-brand-amber text-base font-bold text-content-inverse">
              R
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">resumelint</h1>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-content-muted">
              alpha
            </span>
          </div>
          <div className="flex items-center gap-4">
            <p className="hidden text-xs text-content-muted sm:block">
              PDF parser stress test for resumes
            </p>
            <GitHubStarCta variant="inline" count={starCount} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip icon="⚡">A few seconds</Chip>
          <Chip icon="🔒">Runs in your browser</Chip>
          <Chip icon="✓">No signup required</Chip>
        </div>
      </header>

      {state.phase !== "done" && (
        <section className="flex flex-col gap-3">
          <p className="max-w-prose text-sm text-content-secondary">
            Drop a resume PDF below to see what a generic text extractor reads
            back. This is a diagnostic — not a verdict from any specific
            applicant tracking system.
          </p>
          <DropZone
            onFile={handleFile}
            disabled={state.phase === "parsing"}
            status={
              state.phase === "parsing"
                ? `Parsing ${state.fileName} (${formatBytes(state.fileSize)})…`
                : undefined
            }
          />
        </section>
      )}

      {state.phase === "error" && (
        <ErrorState>Couldn't parse that PDF: {state.message}</ErrorState>
      )}

      <ErrorBoundary onReset={reset}>
        {state.phase === "done" && edited && (
          <Result
            // `parsed` carries the edited experience descriptions so
            // `groupBulletsByExperience` (in ReconstructedResume) attributes
            // edited bullets to the SAME role they came from. Without this,
            // an edit displaces the bullet into the trailing "Other bullets"
            // group because the original description no longer substring-
            // matches the edited bullet text. `rawText` stays original on
            // purpose — EvidencePanel shows "what the PDF extracted", not
            // "what the user typed."
            result={{ ...state.result, parsed: edited.parsed }}
            score={edited.score}
            bytes={state.bytes}
            sourceKind={state.sourceKind}
            onReset={reset}
            edit={edit}
          />
        )}
      </ErrorBoundary>

      <JdInput
        value={jdText}
        onChange={setJdText}
        resumeParsed={state.phase === "done"}
      />

      {jdMatch && (
        <JdMatch
          coverage={jdMatch.coverage}
          terms={jdMatch.extracted.all}
          nounsDropped={jdMatch.extracted.nounsDropped}
        />
      )}

      <footer className="mt-auto flex flex-col gap-2 border-t border-border-light pt-6 text-xs text-content-tertiary">
        <p>Your PDF stays in this browser tab.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <a
            href="https://github.com/resumelint-org/resumelint/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            License
          </a>
          <a
            href="https://www.hbs.edu/managing-the-future-of-work/research/Pages/hidden-workers-untapped-talent.aspx"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            Further reading: HBS Hidden Workers
          </a>
          <a
            href="https://github.com/resumelint-org/resumelint/blob/main/README.md#telemetry"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            Privacy &amp; data
          </a>
        </div>
      </footer>
    </main>
  );
}
