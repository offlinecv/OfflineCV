// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobResultCard — one ranked posting in the Find Jobs results list (#319).
 *
 * Split out of FindJobsPanel to keep that file under the ~200 LOC gate (UX spec
 * §4). The whole card is NOT a link (avoids the nested-interactive a11y trap):
 * two explicit affordances — "View match detail" toggles the reused `<JdMatch>`
 * detail inline, "Open posting" is a plain external anchor.
 *
 * Rating parity (#561): the card headline is a 0–5 STAR rating (`job.rating`),
 * not a fit percentage — raw coverage compressed into single digits on real
 * résumés and stopped discriminating (see `rating.ts`). The headline stars and
 * the reason line are read straight off the SAME `job.rating` computed once in
 * `rank.ts`, and the expanded `<JdMatch>` is fed the same `job.jdMatch`, so
 * headline and detail can never disagree.
 *
 * ONE star rating per card (#569). The card used to stack fit and pay sub-stars
 * under the overall — three identical glyph rows, three meanings, nothing
 * marking the headline, and at `sm` the fractional fill is a two-pixel sliver so
 * a 4.2 and a 4.6 looked the same. Now: the overall stars carry a NUMERAL
 * (`showValue`), and the sub-axes are words from `describeRating` on a single
 * reason line. Words fit all four axes — location and seniority were computed
 * and never displayed at all — and drop the two that were near-duplicates of the
 * overall. The coverage denominator rides that line as VISIBLE text ("12 of 18
 * terms"); it used to be a `title` tooltip, which no touch or keyboard user can
 * reach.
 *
 * Density (#569): company, source, location and compensation are all FACTS about
 * the posting, so they share one meta line instead of owning a row each — the
 * card is 4 rows, not 6, and a screenful holds more of the list. Two facts are
 * squeezed on the way in: `source` is dropped when it merely repeats `company`
 * (the company-board adapters set `source` to the company's own display name, so
 * every Greenhouse/Lever/Ashby hit read "Anthropic · Anthropic"), and a posting
 * listing many locations collapses to "San Francisco, CA +2".
 *
 * Compensation (#564): `posting.compensation` — extracted once in `rank.ts` —
 * renders as a plain-text range when present (the actual figure). Absent
 * entirely for a posting with no extractable range (silence is neutral, no
 * placeholder). The matched source text (`raw`) rides as a `title` tooltip so a
 * misparse is diagnosable. `job.belowFloor` (a SOFT signal — see `rank.ts`) adds
 * a "Below your floor" badge; the posting itself is never hidden or reordered
 * out of the list.
 */

import { useState } from "react";
import { Button, Chip, RatingStars, StatusBadge } from "@design-system";
import { JdMatch } from "./JdMatch.tsx";
import type { RankedJob } from "../../lib/job-search/rank.ts";
import { formatCompensationRange } from "../../lib/job-search/compensation.ts";
import { describeRating } from "../../lib/job-search/rating.ts";

/** Top matched terms shown on the card face before expansion. Matched only —
 *  the missing terms doubled the chip row to say what the user has not got yet,
 *  which is detail-view material; `<JdMatch>` still lists them in full. */
const CHIP_CAP = 4;

/** Separators a feed uses between several locations in one string (Greenhouse
 *  and Lever both do this). NOT the comma — that separates city from state. */
const LOCATION_SEPARATORS = /\s*[|;]\s*/;

/** Round a 0–5 star value to one decimal for an aria-label. */
function star1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** "San Francisco, CA | New York, NY | Seattle, WA" → "San Francisco, CA +2". */
function summarizeLocation(location: string): string {
  const parts = location.split(LOCATION_SEPARATORS).filter((p) => p.trim());
  if (parts.length <= 1) return location.trim();
  return `${parts[0].trim()} +${parts.length - 1}`;
}

/** The provider label, or null when it only repeats the company name. */
function distinctSource(company: string, source: string): string | null {
  const c = company.trim().toLowerCase();
  const s = source.trim().toLowerCase();
  return s && s !== c ? source : null;
}

export function JobResultCard({ job }: { job: RankedJob }) {
  const [open, setOpen] = useState(false);
  const { posting, jdMatch, rating, belowFloor, compFloorSet } = job;
  const matched = jdMatch.coverage.covered.slice(0, CHIP_CAP);
  const coveredCount = jdMatch.coverage.covered.length;
  const termCount = coveredCount + jdMatch.coverage.missing.length;

  const facts = [
    posting.company,
    posting.company ? distinctSource(posting.company, posting.source) : posting.source,
    posting.location ? summarizeLocation(posting.location) : "",
  ].filter(Boolean);

  const reasons = describeRating(rating, { hasCompFloor: compFloorSet });
  if (termCount > 0) reasons.push(`${coveredCount} of ${termCount} terms`);

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border-light p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-content-primary">
          {posting.title}
        </h3>
        <RatingStars
          value={rating.overall}
          size="md"
          showValue
          ariaLabel={`Overall match: ${star1(rating.overall)} out of 5 stars`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-content-tertiary">
        <span>{facts.join(" · ")}</span>
        {posting.compensation && (
          <>
            <span aria-hidden="true">·</span>
            <span
              className="font-medium text-content-secondary"
              title={`Parsed from: "${posting.compensation.raw}"`}
            >
              {formatCompensationRange(posting.compensation)}
            </span>
            {belowFloor && <StatusBadge tone="warning">Below your floor</StatusBadge>}
          </>
        )}
      </div>

      <p className="text-xs text-content-tertiary">{reasons.join(" · ")}</p>

      {matched.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {matched.map((term) => (
            <Chip key={`m:${term.source}:${term.id}`} tone="success">
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
          className="text-xs font-medium text-content-secondary transition-colors hover:text-content-primary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          Open posting <span aria-hidden="true">↗</span>
        </a>
      </div>

      {open && <JdMatch result={jdMatch} />}
    </div>
  );
}
