// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobsApp — the `/jobs` root surface: the job-search workbench.
 *
 * Third entry beside `/` (parser audit) and `/jd-fit` (JD match). It exists so
 * a ranked posting list has a URL of its own, its own scroll, and the full page
 * width — rather than being the tail of the parser page, below the fold, capped
 * at a screenful.
 *
 * Résumé source: the sessionStorage handoff written by `FindJobsLauncher` on `/`
 * (`lib/jobs-handoff.ts`). Unlike `/jd-fit`, this surface has NO DropZone of its
 * own — the job-search lane consumes a parsed résumé, and the parse pipeline
 * (with its cascade, score, and edit layer) is `/`'s job. Adding a second parse
 * entry point here would be the parallel surface CLAUDE.md's Reuse Gate exists
 * to prevent. With no handoff, this renders a pointer back to `/`.
 *
 * Because the handoff is read but not consumed, a reload of `/jobs` keeps
 * working — see the handoff module for why that differs from `/jd-fit`.
 *
 * Shares chrome with the other surfaces via <PageShell>; no PDF bytes and no
 * résumé text reach this page's network calls (only query keywords do, on an
 * explicit Search — see `lib/job-search/providers/keywords.ts`).
 */

import { useState } from "react";
import { Button, ErrorState } from "@design-system";
import { PageShell } from "../components/features/PageShell.tsx";
import { FindJobsPanel } from "../components/features/FindJobsPanel.tsx";
import { readJobsHandoff } from "../lib/jobs-handoff.ts";

function backToResume() {
  window.location.href = import.meta.env.BASE_URL;
}

export default function JobsApp() {
  // Read once, on first render (lazy initializer): the payload is inert JSON and
  // the read is non-destructive, so there is no StrictMode double-invoke hazard
  // of the kind `useJdFitResume` needs a ref for.
  const [handoff] = useState(() => readJobsHandoff());

  return (
    <PageShell
      subtitle="Find jobs that fit your resume"
      badge="Jobs"
      headerExtra={
        <Button variant="link" size="sm" onClick={backToResume}>
          <span aria-hidden="true">‹</span> Back to your resume
        </Button>
      }
    >
      {handoff === null ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorState tone="warning">
            No resume loaded in this tab. The job search ranks postings against
            your parsed resume, so start on the main page — drop your PDF there,
            then open the job workbench from the Find jobs tab.
          </ErrorState>
          <Button variant="primary" size="md" onClick={backToResume}>
            Go to your resume
          </Button>
        </div>
      ) : (
        <FindJobsPanel parsed={handoff.parsed} />
      )}
    </PageShell>
  );
}
