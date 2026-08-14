// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobsApp — the `/jobs` root surface: the job-search workbench.
 *
 * Second entry beside `/` (parser audit). It exists so a ranked posting list
 * has a URL of its own, its own scroll, and the full page width — rather than
 * being the tail of the parser page, below the fold, capped at a screenful.
 *
 * Résumé source: the sessionStorage handoff `/` writes on its way out
 * (`lib/jobs-departure.ts` → `lib/jobs-handoff.ts`). This surface has NO
 * DropZone of its own — the job-search lane consumes a parsed résumé, and the
 * parse pipeline (with its
 * cascade, score, and edit layer) is `/`'s job. Adding a second parse entry
 * point here would be the parallel surface CLAUDE.md's Reuse Gate exists to
 * prevent. With no handoff, the Search tab still renders a pointer back to
 * `/` — but the Saved jobs tab is a passive view of records that already
 * exist, so #724 gives it a fallback: the most recently saved library résumé
 * (`useFallbackResume`), used ONLY to rate the tracker's rows, never fed to
 * `FindJobsPanel` and never overriding a real handoff.
 *
 * Because the handoff is read but not consumed, a reload of `/jobs` keeps
 * working — see the handoff module for the design.
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ErrorState, Tabs, TabList, Tab, TabPanel } from "@design-system";
import { PageShell } from "../components/features/PageShell.tsx";
import { FindJobsPanel } from "../components/features/FindJobsPanel.tsx";
import { JobTrackerSection } from "../components/features/JobTracker.tsx";
import { readJobsHandoff } from "../lib/jobs-handoff.ts";
import { returnToResumeRoot } from "../lib/nav-return.ts";
import { resolveInitialJobsTab, type JobsTabId } from "../lib/jobs-landing.ts";
import { useArrivedFromRoot } from "../hooks/useArrivedFromRoot.ts";
import { useResumeLibrary } from "../hooks/useResumeLibrary.ts";
import { useFallbackResume } from "../hooks/useFallbackResume.ts";
import {
  writeTailorHandoff,
  fingerprintParse,
} from "../lib/tailor-handoff.ts";
import { deriveJourney, type JourneyStageId } from "../lib/journey.ts";
import { useJourneyProgress } from "../hooks/useJourneyProgress.ts";

// #706: goes to `/` directly, never via history.back() — the empty state only
// shows when there is no in-progress parse to preserve, so this is a forward
// action (like the DropZone CTA it replaces), not an undo of the trip here.
function goToResume() {
  window.location.href = import.meta.env.BASE_URL;
}

export default function JobsApp() {
  // Read once, on first render (lazy initializer): the payload is inert JSON and
  // the read is non-destructive, so there is no StrictMode double-invoke hazard
  // of the kind a destructive consume would.
  const [handoff] = useState(() => readJobsHandoff());
  // #707/#715: `PageShell`'s "Saved jobs" link arrives with `?tab=library`,
  // and a direct `/jobs/#saved` link (handed out by a producer like the
  // cover-letter skill) arrives with the hash instead — either lands this
  // surface on the Saved jobs tab rather than the Search tab a plain
  // `/jobs/` visit defaults to. Lazy initializer for the FIRST render — the
  // `hashchange` effect below covers the rest.
  const [tab, setTab] = useState<JobsTabId>(() =>
    resolveInitialJobsTab(window.location.search, window.location.hash),
  );

  // #715: the mount read alone is not enough for the hash carrier. Following or
  // pasting `/jobs/#saved` while ALREADY on `/jobs/` changes only the fragment —
  // same document, no navigation, no re-render — so without this listener the
  // tab would not switch and nothing visible would happen. That is the exact
  // link an outside letter producer hands a user when it reports what it wrote
  // (`docs/cover-letter-contract.md`), and a user who already has the workbench
  // open is its likeliest reader. The query
  // param needs no equivalent: changing it IS a document navigation, which
  // remounts this component and re-runs the initializer above.
  useEffect(() => {
    const onHashChange = () =>
      setTab(resolveInitialJobsTab(window.location.search, window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
    // Deps hand-audited both ways (`exhaustive-deps` is NOT enforced here —
    // CLAUDE.md): the handler closes over nothing but `setTab`, which React
    // guarantees stable, and reads `window.location` at FIRE time rather than
    // capturing it — so there is no value that could go stale and `[]` is
    // complete. Adding any dep would only re-subscribe for no behaviour change.
  }, []);

  // #706: answered ONCE, at mount, not per click — the marker belongs to the
  // leg that landed here, and a marker still live at click time is one that
  // was written for some earlier hop. See `useArrivedFromRoot`.
  const arrivedFromRoot = useArrivedFromRoot();

  // #576: a JD-driven tailor request from a `JobResultCard` (or the paste-a-JD
  // disclosure below the results) stashes the rewrite steering in
  // sessionStorage and navigates back to `/`, where `ResultDetail` consumes
  // the handoff, sets `jdContext`, and scrolls the résumé into view (it was a
  // tab switch until #823 took `/`'s tab rail off).
  //
  // The caller hands over the BUILT steering, not the raw coverage: the
  // decision "is there anything to steer with" is `buildJdRewriteContext`
  // returning non-null, and the surface that renders the button has to make
  // that decision anyway to know whether the button leads anywhere. Taking
  // the string here means the gate and the payload can never be two different
  // predicates — the shape that let a button render for a coverage the
  // builder would then reject.
  //
  // Stamped with the fingerprint of the résumé the coverage was computed
  // against, so `/` can tell a handoff meant for the parse it still has from
  // one left over for a parse it no longer does (see `tailor-handoff.ts`).
  const handleTailor = (jdContext: string) => {
    // Unreachable while `onTailor` is only wired below on the non-null branch;
    // the guard is what keeps that a local fact rather than a load-bearing one.
    if (handoff === null) return;
    writeTailorHandoff({
      jdContext,
      parseFingerprint: fingerprintParse(handoff.parsed),
    });
    returnToResumeRoot(arrivedFromRoot);
  };

  // The library the resume-link picker offers on tracked-job rows. Independent
  // of the handoff — a saved resume can exist here even when this tab has no
  // in-progress parse to search against.
  const library = useResumeLibrary();
  const resumeName = (resumeId: string) =>
    library.entries.find((entry) => entry.id === resumeId)?.filename;

  // #724: a direct visit to `/jobs/` (bookmark, pasted link, reload) never
  // received the handoff, so the tracker would otherwise rate against nothing.
  // `active` gates the whole hook on `handoff === null` — a real handoff always
  // wins outright, the fallback never even loads. Scoped to the tracker only
  // (see the docblock); `FindJobsPanel` below still reads `handoff` directly.
  const fallback = useFallbackResume(handoff === null, library);
  const fallbackResumeName = fallback
    ? library.entries.find((entry) => entry.id === fallback.resumeId)?.filename
    : undefined;
  const trackerParsed = handoff?.parsed ?? fallback?.parsed;

  // ── The L1 journey rail (#812) ────────────────────────────────────────────
  //
  // "Is there a résumé" is answered by EITHER source, not just the handoff.
  // The rail is an orientation device about the user's journey, not a readout
  // of what this tab can search with: a saved résumé the Saved-jobs tab is
  // already rating against is a résumé this browser has, and marking Fix it
  // "not ready yet" next to it would be false.
  //
  // The rail's promise round-trips WHEN the mark came from the library:
  // `/`'s cold-mount auto-restore (#812) rehydrates that same newest record, so
  // Fix it lands on it. It does not round-trip when the mark came from a
  // handoff written by an UNSAVED parse and the return leg misses bfcache —
  // `/` then reloads with nothing in the library to restore and Fix it lands on
  // an empty drop zone. That is the pre-#812 outcome for an unsaved parse, not
  // a regression, and the honest read of this signal is "this browser has a
  // résumé somewhere", not "Fix it is guaranteed to find one".
  //
  // `jdSteering` is flatly false here, and that is not a stub: steering is
  // WRITTEN on the way out of this surface (`handleTailor` above) and consumed
  // on `/`, so it can never be active while this page is on screen. The Tailor
  // stage therefore always shows its empty state here, pointing back at the
  // Search tab — which is exactly where the "Tailor résumé to this job"
  // buttons live.
  //
  // The completion ledger (#826) is read under the key the handoff carried:
  // `/jobs/` cannot re-derive it, because what arrives here is the APPLIED
  // parse and the key is the pristine one. A session with no handoff (the
  // library fallback above) has no key and therefore no marks — fewer ✓ than
  // the truth, never a wrong one. See `JobsHandoff.journeyKey`.
  const progress = useJourneyProgress(handoff?.journeyKey ?? null);
  // One expression for both résumé signals, so this surface's rail is
  // byte-identical to its pre-#826 self: `/jobs/` has answered "is there a
  // résumé" from the library as well as the handoff since #724, which is
  // exactly what `hasStoredResume` widened `/` to do.
  const hasResume = handoff !== null || fallback !== undefined;
  const journeyState = useMemo(
    () =>
      deriveJourney({
        entry: "jobs",
        hasResume,
        hasStoredResume: hasResume,
        jdSteering: false,
        completed: progress.completed,
      }),
    [hasResume, progress.completed],
  );

  const onJourneySelect = useCallback(
    (id: JourneyStageId) => {
      // Match jobs IS this surface — the Search tab, which the user may have
      // switched away from.
      if (id === "match") {
        setTab("search");
        return;
      }
      // Every other stage lives on `/`. Through `returnToResumeRoot`, never a
      // hand-rolled `history.back()`: a real back navigation is what restores
      // `/`'s in-progress parse and inline edits from bfcache, and it is only
      // correct when this tab's own departure marker says the trip started
      // there (#706).
      returnToResumeRoot(arrivedFromRoot);
    },
    [arrivedFromRoot],
  );

  return (
    <PageShell
      subtitle="Find jobs that fit your resume"
      badge="Jobs"
      journey={{ state: journeyState, onSelect: onJourneySelect }}
      // #707: PageShell's "Saved jobs" link exists to get a user here from one
      // of the other two surfaces — rendered on `/jobs/` itself it would point
      // at the page already open, which is confusing rather than useful.
      hideSavedJobsLink
      headerExtra={
        // #706: a real back navigation when this tab arrived from `/` (either
        // route off it marks the departure — see `jobs-departure.ts`), so the
        // in-progress parse and its inline edits there survive via bfcache.
        // Falls back to a fresh `/` for a deep link, a new tab, a reload of
        // /jobs/.
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
              <FindJobsPanel
                parsed={handoff.parsed}
                onTailor={handleTailor}
                // #826: a search that came back IS the Match-jobs stage
                // completed. Recorded here rather than inside the panel so the
                // ledger key — which arrived on the handoff — stays owned by
                // the surface that read it.
                onSearchLoaded={() => progress.mark("match")}
              />
            )}
          </TabPanel>
          <TabPanel id="library">
            <JobTrackerSection
              parsed={trackerParsed}
              fallbackResumeName={fallbackResumeName}
              resumeName={resumeName}
              resumeOptions={library.entries}
            />
          </TabPanel>
        </div>
      </Tabs>
    </PageShell>
  );
}
