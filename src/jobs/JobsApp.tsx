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
 * Two peer views on `Tabs` (#690, replacing the `job-tracker` flag): Search
 * (`FindJobsPanel`) and Library (the tracked-jobs surface, formerly gated
 * behind that flag on `/`). `Tabs` keeps both panels mounted and toggles only
 * the `hidden` attribute (see its docblock), which is what makes switching
 * lossless — an in-flight query, a loaded result set, and library scroll/edit
 * state all survive either direction. A conditional-render switch here would
 * remount whichever panel just went inactive on every toggle.
 *
 * Shares chrome with the other surfaces via <PageShell>; no PDF bytes and no
 * résumé text reach this page's network calls (only query keywords do, on an
 * explicit Search — see `lib/job-search/providers/keywords.ts`).
 */

import { useState } from "react";
import { Button, ErrorState, Tabs, TabList, Tab, TabPanel } from "@design-system";
import { PageShell } from "../components/features/PageShell.tsx";
import { FindJobsPanel } from "../components/features/FindJobsPanel.tsx";
import { JobTrackerSection } from "../components/features/JobTracker.tsx";
import { readJobsHandoff } from "../lib/jobs-handoff.ts";
import { returnToResumeRoot } from "../lib/nav-return.ts";
import { resolveInitialJobsTab, type JobsTabId } from "../lib/jobs-landing.ts";
import { useArrivedFromRoot } from "../hooks/useArrivedFromRoot.ts";
import { useResumeLibrary } from "../hooks/useResumeLibrary.ts";

// #706: goes to `/` directly, never via history.back() — the empty state only
// shows when there is no in-progress parse to preserve, so this is a forward
// action (like the DropZone CTA it replaces), not an undo of the trip here.
function goToResume() {
  window.location.href = import.meta.env.BASE_URL;
}

export default function JobsApp() {
  // Read once, on first render (lazy initializer): the payload is inert JSON and
  // the read is non-destructive, so there is no StrictMode double-invoke hazard
  // of the kind `useJdFitResume` needs a ref for.
  const [handoff] = useState(() => readJobsHandoff());
  // #707: `PageShell`'s "Saved jobs" link arrives with `?tab=library` so this
  // surface lands there directly instead of the Search tab a plain `/jobs/`
  // visit defaults to. Lazy initializer (not an effect) — same read-once-on-
  // mount shape as the handoff above; `window.location.search` is inert at
  // mount and never needs to be re-read.
  const [tab, setTab] = useState<JobsTabId>(() =>
    resolveInitialJobsTab(window.location.search),
  );

  // #706: answered ONCE, at mount, not per click — the marker belongs to the
  // leg that landed here, and a marker still live at click time is one that
  // was written for some earlier hop. See `useArrivedFromRoot`.
  const arrivedFromRoot = useArrivedFromRoot();

  // The library the resume-link picker offers on tracked-job rows. Independent
  // of the handoff — a saved resume can exist here even when this tab has no
  // in-progress parse to search against.
  const library = useResumeLibrary();
  const resumeName = (resumeId: string) =>
    library.entries.find((entry) => entry.id === resumeId)?.filename;

  return (
    <PageShell
      subtitle="Find jobs that fit your resume"
      badge="Jobs"
      // #707: PageShell's "Saved jobs" link exists to get a user here from one
      // of the other two surfaces — rendered on `/jobs/` itself it would point
      // at the page already open, which is confusing rather than useful.
      hideSavedJobsLink
      headerExtra={
        // #706: a real back navigation when this tab arrived from `/` (either
        // route off it marks the departure — see `jobs-departure.ts`), so the
        // in-progress parse and its inline edits there survive via bfcache.
        // Falls back to a fresh `/` for a deep link, a new tab, a reload of
        // /jobs/, or an arrival from `/jd-fit/` — whose "Saved jobs" link marks
        // nothing, and whose own mount already absorbed any marker `/` wrote
        // for the earlier leg, so this control never lands on a page the label
        // doesn't name.
        <Button
          variant="link"
          size="sm"
          onClick={() => returnToResumeRoot(arrivedFromRoot)}
        >
          <span aria-hidden="true">‹</span> Back to your resume
        </Button>
      }
    >
      <Tabs id="jobs" value={tab} onValueChange={(next) => setTab(next as JobsTabId)}>
        <TabList aria-label="Job workbench views">
          <Tab id="search" description="rank postings against your résumé">
            Search
          </Tab>
          <Tab id="library" description="jobs you've saved, by status">
            Saved jobs
          </Tab>
        </TabList>

        <div className="pt-4">
          <TabPanel id="search">
            {handoff === null ? (
              <div className="flex flex-col items-start gap-3">
                <ErrorState tone="warning">
                  No resume loaded in this tab. The job search ranks postings
                  against your parsed resume, so start on the main page — drop
                  your PDF there, then open the job workbench from the Find
                  jobs tab.
                </ErrorState>
                <Button variant="primary" size="md" onClick={goToResume}>
                  Go to your resume
                </Button>
              </div>
            ) : (
              <FindJobsPanel parsed={handoff.parsed} />
            )}
          </TabPanel>
          <TabPanel id="library">
            <JobTrackerSection
              parsed={handoff?.parsed}
              resumeName={resumeName}
              resumeOptions={library.entries}
            />
          </TabPanel>
        </div>
      </Tabs>
    </PageShell>
  );
}
