// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FindJobsLauncher — what the Find Jobs tab on `/` shows now that the search
 * itself lives on `/jobs/`.
 *
 * Deliberately thin: a preview of the query terms we derived plus one button.
 * The whole point of the move is that a ranked posting list is a destination
 * with its own URL and its own scroll, so duplicating the editable query here
 * would recreate the "two places to edit one search" problem the split removed.
 * Anything editable belongs on `/jobs/`.
 *
 * The button writes the parse to sessionStorage and then navigates — a full
 * document navigation, base-aware via `import.meta.env.BASE_URL` so it works
 * under both the custom-domain "/" base and the "/OfflineCV/" Pages-fallback
 * base (same pattern the other same-origin cross-links use).
 *
 * The stash, the departure marker (#706, so `/jobs/`'s "Back to your resume"
 * control knows this trip actually started at `/` and can use a real
 * `history.back()` instead of pushing a fresh, blank `/`) and that base-aware
 * navigation all come from `departToJobsAndNavigate` — shared with the journey
 * rail's Match-jobs stage (#812), and a sibling of the `departToJobs` the
 * header's parse-independent "Saved jobs" link (#707) calls. What that unifies
 * is the MECHANICS of leaving: the marker and the URL, the two things a new
 * route forgets.
 *
 * It does not unify the PAYLOAD, and that axis is still open. This launcher is
 * handed `activeResult.canonical.fields` — the LLM-escape-hatch-merged parse —
 * because it renders inside `ParsedCard`, where `llmOverride` is local
 * `useState` (`Result.tsx`). The rail's Match-jobs stage and the header link
 * both run in `App`, which cannot see that state and passes
 * `displayResult.canonical.fields` instead, so a user who recovered a
 * degenerate parse and then left via the rail ships the PRE-recovery fields.
 * Closing it means lifting `llmOverride` out of `ParsedCard`; #812 did not,
 * and the pre-existing `goToSavedJobs` has the same gap.
 *
 * Nothing here fetches, and the navigation is same-origin, so no résumé data
 * leaves the browser at this step.
 */

import { useMemo } from "react";
import { Button, Chip } from "@design-system";
import { buildJobQuery } from "../../lib/job-search/query-builder.ts";
import { roleFilterForResume, seedExcludeTermsForFamilies } from "../../lib/job-search/role-keywords.ts";
import { departToJobsAndNavigate } from "../../lib/jobs-departure.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import { JobQuerySummary } from "./JobQuerySummary.tsx";

export function FindJobsLauncher({ parsed }: { parsed: HeuristicParsedResume }) {
  // Same seed `/jobs/` will compute from the same parse — this is a preview of
  // that query, not a second source of truth. Recomputed there on arrival.
  const query = useMemo(() => {
    const roleFilter = roleFilterForResume(parsed);
    return buildJobQuery(
      parsed,
      seedExcludeTermsForFamilies(roleFilter.families),
      roleFilter.families,
    );
  }, [parsed]);

  const isDegenerate = query.titles.length === 0 && query.skills.length === 0;

  const go = () => departToJobsAndNavigate(parsed);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
            Find jobs
          </h2>
          <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-4xs font-semibold uppercase tracking-wider text-content-secondary">
            alpha
          </span>
        </div>
        <p className="max-w-prose text-sm text-content-tertiary">
          We built a search from your parsed resume. Open the job workbench to
          edit it, search job boards, and page through every match ranked by
          fit. Your resume text never leaves this browser — only the keywords
          are sent.
        </p>
      </header>

      {!isDegenerate && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-content-tertiary">
            Starting from these terms
          </span>
          {/* #581: `JobQuerySummary` is the Reuse Gate answer — same
           *  `summarizeQuery` `/jobs/` uses once folded, no second
           *  summarizer. `companyCount` is omitted (not 0): `useCompanyTargets`
           *  has not run here, so there is nothing to report yet. */}
          <JobQuerySummary query={query} />
          {/* Every title shown (#581 fixes the old 6-slice silent cut) —
           *  there are at most `MAX_TITLES` of these, few enough to list in
           *  full without an expand control. */}
          {query.titles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {query.titles.map((title) => (
                <Chip key={title}>{title}</Chip>
              ))}
            </div>
          )}
          {/* Skills are named as one exemplar + an honest count rather than a
           *  bare number or a silent cut — "Cloud Infrastructure +8", never
           *  "+9" alone. */}
          {query.skills.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <Chip>
                {query.skills[0]}
                {query.skills.length > 1 ? ` +${query.skills.length - 1}` : ""}
              </Chip>
            </div>
          )}
        </div>
      )}

      {/* A degenerate query does NOT gate the jump: the workbench is where
       *  titles and skills are added, so blocking here would leave the user
       *  with a dead tab and no control to fix it. The button opens the same
       *  editor, which shows its own "add a title or skills" hint. */}
      {isDegenerate && (
        <p className="text-sm text-content-tertiary">
          We couldn&apos;t derive a search from this resume — add a title or
          skills in the workbench and search from there.
        </p>
      )}
      <div>
        <Button variant="primary" size="md" onClick={go}>
          Open job workbench <span aria-hidden="true">▸</span>
        </Button>
      </div>
    </div>
  );
}
