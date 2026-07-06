// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * JobResultCard — one ranked posting in the Find Jobs results list (#319).
 *
 * Split out of FindJobsPanel to keep that file under the ~200 LOC gate (UX spec
 * §4). The whole card is NOT a link (avoids the nested-interactive a11y trap):
 * two explicit affordances — "View match detail" toggles the reused `<JdMatch>`
 * detail inline, "Open posting" is a plain external anchor.
 *
 * Ranking parity: the card's fit % (`job.score`) and the expanded `<JdMatch>`
 * are fed from the SAME `job.jdMatch` object computed once in `rank.ts`, so the
 * headline number can never disagree with the detail view.
 */

import { useState } from "react";
import { Button, Chip } from "@design-system";
import { JdMatch } from "./JdMatch.tsx";
import type { RankedJob } from "../../lib/job-search/rank.ts";

/** Top matched/missing terms shown on the card face before expansion. */
const CHIP_CAP = 4;

export function JobResultCard({ job }: { job: RankedJob }) {
  const [open, setOpen] = useState(false);
  const { posting, jdMatch, score } = job;
  const matched = jdMatch.coverage.covered.slice(0, CHIP_CAP);
  const missing = jdMatch.coverage.missing.slice(0, CHIP_CAP);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-light p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-content-primary">
          {posting.title}
        </h3>
        <span className="shrink-0 whitespace-nowrap text-xs text-content-tertiary">
          <span className="font-mono text-content-secondary">{score}/100</span> fit
        </span>
      </div>

      <p className="text-xs text-content-tertiary">
        {[posting.company, posting.source].filter(Boolean).join(" · ")}
        {posting.location ? ` · ${posting.location}` : ""}
      </p>

      {(matched.length > 0 || missing.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {matched.map((term) => (
            <Chip key={`m:${term.source}:${term.id}`} tone="success">
              {term.display}
            </Chip>
          ))}
          {missing.map((term) => (
            <Chip key={`x:${term.source}:${term.id}`} tone="neutral">
              {term.display}
            </Chip>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Button
          variant="link"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide match detail" : "View match detail"}
        </Button>
        <a
          href={posting.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-content-secondary transition-colors hover:text-content-primary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-amber"
        >
          Open posting <span aria-hidden="true">↗</span>
        </a>
      </div>

      {open && <JdMatch result={jdMatch} />}
    </div>
  );
}
