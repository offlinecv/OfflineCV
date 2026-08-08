// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * PasteJdPanel — arbitrary-JD paste/URL fetch affordance on `/jobs/` (#576).
 *
 * A user with a JD in hand from email, a referral, or a board we don't index
 * needs a way to check fit against it — `FindJobsPanel` can only match against
 * postings it discovered itself. This disclosure below the results region
 * provides that path inside the Find Jobs surface: same `<JdInput>` (paste +
 * URL fetch), same `computeCoverage` three-liner, same `<JdMatch>` renderer,
 * same "Tailor résumé to this job" button feeding the same `onTailor` a
 * `JobResultCard` uses — so the paste lane and the discover lane can never
 * disagree about what steers a rewrite.
 *
 * Collapsed by default so it does not compete with the primary discovery
 * flow — the ranked posting list is what a user arrives here for; pasting a
 * JD is a second-order path. Follows the same open/close pattern the query
 * section above uses (`aria-expanded` on a ghost `<Button>`).
 *
 * `onTailor` is optional so this component is self-contained and testable
 * without a router; on `/jobs/` the parent (`JobsApp` → `FindJobsPanel`) is
 * what turns a coverage handoff into a navigation back to `/`.
 */

import { useMemo, useState } from "react";
import { Button } from "@design-system";
import { JdInput } from "./JdInput.tsx";
import { JdMatch } from "./JdMatch.tsx";
import { extractJdTerms, computeCoverage } from "../../lib/jd-match";
import type { CoverageResult } from "../../lib/jd-match/coverage.ts";
import type { JdMatchResult } from "../../lib/jd-match";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

interface PasteJdPanelProps {
  /** The parsed résumé the coverage check runs against — same shape
   *  `FindJobsPanel` and `JobResultCard` consume for their own coverage. */
  parsed: HeuristicParsedResume;
  /** Steer the rewrite on `/` with this JD. Optional so the panel renders
   *  its coverage view even outside `/jobs/`'s handoff-back-to-`/` context. */
  onTailor?: (coverage: CoverageResult) => void;
}

export function PasteJdPanel({ parsed, onTailor }: PasteJdPanelProps) {
  const [open, setOpen] = useState(false);
  const [jdText, setJdText] = useState("");

  // The same three-line extract → coverage composition `rank.ts` runs per
  // posting — the coverage computation has no second implementation. `parsed`
  // is stable per Find Jobs session (a new search does not re-parse), and
  // `extractJdTerms` is pure text work.
  const jdMatch = useMemo<JdMatchResult | null>(() => {
    const trimmed = jdText.trim();
    if (trimmed.length === 0) return null;
    const extracted = extractJdTerms(trimmed);
    if (extracted.all.length === 0) return null;
    const coverage = computeCoverage(parsed, extracted.all);
    return {
      path: "keyword",
      coverage,
      terms: extracted.all,
      nounsDropped: extracted.nounsDropped,
    };
  }, [jdText, parsed]);

  return (
    <section
      aria-label="Paste a job description"
      className="flex flex-col gap-3 border-t border-border-light pt-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="ghost"
          size="md"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide paste-a-JD" : "Have a JD in hand? Paste it"}
        </Button>
        {!open && (
          <span className="text-sm text-content-tertiary">
            Check fit against a job posting we didn't find here.
          </span>
        )}
      </div>

      {open && (
        <>
          <JdInput
            value={jdText}
            onChange={setJdText}
            resumeParsed={true}
          />
          {jdMatch && <JdMatch result={jdMatch} />}
          {jdMatch?.path === "keyword" && onTailor && (
            <div>
              <Button
                variant="link"
                size="sm"
                onClick={() => onTailor(jdMatch.coverage)}
              >
                Tailor résumé to this job
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
