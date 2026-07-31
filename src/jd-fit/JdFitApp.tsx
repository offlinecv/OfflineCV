// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JdFitApp — the `/jd-fit` root surface (issue #226).
 *
 * Candidate-side counterpart to `/` (parser audit): paste a job description,
 * see coverage/missing-term match against the résumé, and get a JD-DRIVEN
 * rewrite (the same shared engine as `/`, parameterized with JD context — never
 * forked). The résumé source is either the one-shot handoff from `/` (parsed
 * JSON in sessionStorage) or this surface's own DropZone.
 *
 * Shares chrome (header/footer/update banner) with `/` via <PageShell> and the
 * parse pipeline via useAnalyzedResume, so the two products stay one codebase.
 */

import { useMemo, useState } from "react";
import { ErrorState, ErrorBoundary, Button } from "@design-system";
import { DropZone } from "../components/DropZone.tsx";
import { Result } from "../components/Result.tsx";
import { PageShell } from "../components/features/PageShell.tsx";
import { JdInput } from "../components/features/JdInput.tsx";
import { JdMatch } from "../components/features/JdMatch.tsx";
import { SaveJobFromMatchSection } from "../components/features/SaveJobFromMatch.tsx";
import { useAnalyzedResume } from "../hooks/useAnalyzedResume.ts";
import { useJdFitResume } from "./useJdFitResume.ts";
import { extractJdTerms, computeCoverage, type JdMatchResult } from "../lib/jd-match";
import { buildJdRewriteContext } from "../lib/jd-match/rewrite-context.ts";
import { returnToResumeRoot } from "../lib/nav-return.ts";
import { useArrivedFromRoot } from "../hooks/useArrivedFromRoot.ts";

export default function JdFitApp() {
  const [jdText, setJdText] = useState("");
  // #706: answered ONCE, at mount. Consuming the marker here — even though this
  // surface's back control may never be clicked — is what stops `/`'s marker
  // from following the user on to `/jobs/` via the header link and answering
  // THAT surface's back control. See `useArrivedFromRoot`.
  const arrivedFromRoot = useArrivedFromRoot();
  const analyzed = useAnalyzedResume();
  // Resolve the résumé source: a one-shot handoff from `/` (rehydrated parsed
  // JSON) takes precedence; otherwise this surface's own DropZone parse. Both
  // collapse to the SAME { result, score, edit, source } shape `<Result>` and
  // JD coverage consume.
  const resume = useJdFitResume(analyzed);

  // JD coverage memo — moved verbatim from App (#226). Runs only when there's
  // both JD text and a parsed résumé.
  const jdMatch = useMemo<JdMatchResult | null>(() => {
    const trimmed = jdText.trim();
    if (trimmed.length === 0) return null;
    if (!resume) return null;
    const extracted = extractJdTerms(trimmed);
    if (extracted.all.length === 0) return null;
    const coverage = computeCoverage(resume.parsed, extracted.all);
    return {
      path: "keyword",
      coverage,
      terms: extracted.all,
      nounsDropped: extracted.nounsDropped,
    };
  }, [jdText, resume]);

  // JD-driven rewrite steering — the missing-terms instruction folded into the
  // shared rewrite engine. Null when no JD / nothing missing → generic rewrite.
  const jdContext = useMemo(
    () =>
      jdMatch?.path === "keyword"
        ? buildJdRewriteContext(jdMatch.coverage)
        : null,
    [jdMatch],
  );

  return (
    <PageShell
      subtitle="Tailor your resume to a job description"
      badge="JD Fit"
      // No `onSavedJobsNavigate`: this surface is not the app root, so it has
      // no jobs handoff to write and must NOT mark a departure — a marker from
      // here would travel with the user to `/jobs/` and send its "Back to your
      // resume" control to `/jd-fit/`, a real page but not the one the label
      // names. (The marker `/` wrote for the leg INTO this page is already
      // gone: `useArrivedFromRoot` retired it at mount.) See `nav-return.ts`.
      headerExtra={
        // #706: a real back navigation when this tab arrived from `/` (a
        // trip `App.tsx`'s `goToJdFit` marks via `markDeparture`), so the
        // in-progress parse there survives via bfcache. Falls back to a
        // fresh `/` for a deep link, a new tab, or a reload of /jd-fit/.
        <Button
          variant="link"
          size="sm"
          onClick={() => returnToResumeRoot(arrivedFromRoot)}
        >
          ← Parser audit
        </Button>
      }
    >
      <section className="flex flex-col gap-2">
        <p className="max-w-prose text-sm text-content-secondary">
          Paste a job description and a resume to see which of the JD's skills
          and key phrases your resume already covers — then rewrite it toward
          the role. Everything runs in your browser.
        </p>
      </section>

      <JdInput value={jdText} onChange={setJdText} resumeParsed={!!resume} />

      {/* Résumé source: only show the DropZone when there's no résumé yet
          (no handoff and no local parse). */}
      {!resume && (
        <section className="flex flex-col gap-3">
          <DropZone
            onFile={analyzed.handleFile}
            disabled={analyzed.state.phase === "parsing"}
            status={
              analyzed.state.phase === "parsing"
                ? `Parsing ${analyzed.state.fileName} (${analyzed.formatBytes(
                    analyzed.state.fileSize,
                  )})…`
                : undefined
            }
          />
        </section>
      )}

      {analyzed.state.phase === "error" && (
        <ErrorState>
          Couldn't parse that PDF: {analyzed.state.message}
        </ErrorState>
      )}

      {jdMatch && <JdMatch result={jdMatch} />}

      {jdMatch && (
        <SaveJobFromMatchSection
          jdText={jdText}
          matchResult={jdMatch}
        />
      )}

      <ErrorBoundary onReset={resume?.reset ?? analyzed.reset}>
        {resume && (
          <Result
            result={resume.result}
            score={resume.score}
            bytes={resume.bytes}
            sourceKind={resume.sourceKind}
            onReset={resume.reset}
            edit={resume.edit}
            jdContext={jdContext ?? undefined}
          />
        )}
      </ErrorBoundary>
    </PageShell>
  );
}
