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
 * base (same pattern as `App.tsx`'s /jd-fit cross-link).
 *
 * Nothing here fetches, and the navigation is same-origin, so no résumé data
 * leaves the browser at this step.
 */

import { useMemo } from "react";
import { Button } from "@design-system";
import { buildJobQuery } from "../../lib/job-search/query-builder.ts";
import { roleFilterForResume, seedExcludeTermsForFamilies } from "../../lib/job-search/role-keywords.ts";
import { writeJobsHandoff } from "../../lib/jobs-handoff.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

/** Terms previewed before the jump. Enough to show the derivation worked
 *  without reproducing the full editor. */
const PREVIEW_LIMIT = 6;

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
  const preview = [...query.titles, ...query.skills].slice(0, PREVIEW_LIMIT);

  const go = () => {
    writeJobsHandoff({ parsed });
    window.location.href = `${import.meta.env.BASE_URL}jobs/`;
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Find jobs
          </h2>
          <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-content-secondary">
            alpha
          </span>
        </div>
        <p className="max-w-prose text-xs text-content-tertiary">
          We built a search from your parsed resume. Open the job workbench to
          edit it, search job boards, and page through every match ranked by
          fit. Your resume text never leaves this browser — only the keywords
          are sent.
        </p>
      </header>

      {preview.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-content-tertiary">
            Starting from these terms
          </span>
          <div className="flex flex-wrap gap-1.5">
            {preview.map((term) => (
              <span
                key={term}
                className="rounded bg-surface-subtle px-2 py-0.5 text-xs text-content-secondary"
              >
                {term}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* A degenerate query does NOT gate the jump: the workbench is where
       *  titles and skills are added, so blocking here would leave the user
       *  with a dead tab and no control to fix it. The button opens the same
       *  editor, which shows its own "add a title or skills" hint. */}
      {isDegenerate && (
        <p className="text-xs text-content-tertiary">
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
