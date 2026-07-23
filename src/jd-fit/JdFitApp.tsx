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
import { useFlag } from "../lib/flags.ts";
import { extractJdTerms, computeCoverage, type JdMatchResult } from "../lib/jd-match";
import { buildJdRewriteContext } from "../lib/jd-match/rewrite-context.ts";

export default function JdFitApp() {
  const [jdText, setJdText] = useState("");
  const analyzed = useAnalyzedResume();
  // Resolve the résumé source: a one-shot handoff from `/` (rehydrated parsed
  // JSON) takes precedence; otherwise this surface's own DropZone parse. Both
  // collapse to the SAME { result, score, edit, source } shape `<Result>` and
  // JD coverage consume.
  const resume = useJdFitResume(analyzed);

  // "Save this job" (#323) — same flag as the tracker on `/`, since a saved
  // job with nowhere to manage it is a dead end. The section child owns the
  // hook, so a flag-off visit never opens IndexedDB.
  const jobTrackerEnabled = useFlag("job-tracker");

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
      headerExtra={
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            window.location.href = import.meta.env.BASE_URL;
          }}
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

      {jdMatch && jobTrackerEnabled && (
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
