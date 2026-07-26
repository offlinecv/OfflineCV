// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SearchPlanCard — the pre-flight contract of `/jobs/` (#597): the one block
 * that says, before Search is clicked, which single title and which single
 * skill leave the browser, that a company board gets only a public name, and
 * that every other chip works on the user's own device.
 *
 * Reuse analysis (CLAUDE.md's Reuse Gate). This is a new CAPABILITY, not a
 * second copy of an existing surface: no surface in the tree states the
 * outbound contract BEFORE a search. `JobQuerySummary` was the closest
 * candidate and is post-search by construction — it exists to make the FOLDED
 * state legible and renders only after the fold. `JobQueryEditor` owns the
 * fields and is already at ~286 LOC, over the ~200 guide, so the block that
 * supersedes its grey "Searching feeds for …" line is extracted here rather
 * than grown into it. The **change** picker is NOT a new mutation path — it
 * calls the same `promoteTitle` / `promoteSkill` reducers the chip rows' `★`
 * control calls (`lib/job-search/search-plan.ts`).
 *
 * Display-only. Every string comes from `buildSearchPlan`, which reads through
 * `searchPhrase` / `primaryKeyword` — this component composes no copy of its
 * own and re-derives nothing, so it cannot drift from what egresses.
 *
 * THE PICKER IS AN INLINE DISCLOSURE, not the `Dialog` primitive: a modal to
 * choose one of ~5 chips already on screen is disproportionate, and a second
 * modal picker beside the chip rows' promote control is exactly the parallel
 * surface the golden rule forbids. It is ABSENT — not disabled — when the
 * source list holds one item, because there is nothing to change to.
 */

import { useState } from "react";
import { Button } from "@design-system";
import type { JobQuery } from "../../lib/job-search/query-builder.ts";
import {
  buildSearchPlan,
  type SearchPlanRow,
  type SearchPlanSource,
} from "../../lib/job-search/search-plan.ts";

export function SearchPlanCard({
  query,
  companyCount,
  onPromoteTitle,
  onPromoteSkill,
}: {
  query: JobQuery;
  /** Selected company boards — outside `JobQuery`, same as `JobQuerySummary`. */
  companyCount: number;
  /** Make this title the one the feeds are searched for. */
  onPromoteTitle: (title: string) => void;
  /** Make this skill the one the topic tag is set to. */
  onPromoteSkill: (skill: string) => void;
}) {
  // Which row's picker is open, or null. One at a time, and purely
  // presentational, so it stays local rather than moving to a hook.
  const [openRow, setOpenRow] = useState<string | null>(null);

  const plan = buildSearchPlan(query, companyCount);
  const optionsFor = (source: SearchPlanSource): string[] =>
    source === "title" ? query.titles : query.skills;
  const promote = (source: SearchPlanSource, value: string) => {
    if (source === "title") onPromoteTitle(value);
    else onPromoteSkill(value);
    setOpenRow(null);
  };

  return (
    <div
      aria-label={plan.heading}
      // CONTRAST (#602). `bg-surface-subtle` is the wrong surface for a block
      // of explanatory prose: against it, `content-tertiary` measures 4.04:1 and
      // `accent-primary` 4.07:1 in dark mode, both under WCAG 1.4.3's 4.5:1 for
      // body text. On `bg-surface-card` the same tokens are 5.71:1 and 5.75:1
      // (13.35:1 for the heading). The card still reads as its own block via
      // the border + the accent left rule, which cost nothing in contrast.
      className="flex flex-col gap-2 rounded border border-l-4 border-border-light border-l-accent-primary bg-surface-card p-4"
    >
      <h3 className="text-base font-semibold text-content-primary">{plan.heading}</h3>

      <dl className="flex flex-col gap-2">
        {plan.rows.map((row) => (
          <PlanRow
            key={row.id}
            row={row}
            options={row.source ? optionsFor(row.source) : []}
            isOpen={openRow === row.id}
            onToggle={() => setOpenRow((v) => (v === row.id ? null : row.id))}
            onPick={(value) => row.source && promote(row.source, value)}
          />
        ))}
      </dl>

      <p className="max-w-prose text-sm text-content-secondary">{plan.localNote}</p>
      <p className="max-w-prose text-sm text-content-secondary">{plan.privacyNote}</p>
    </div>
  );
}

function PlanRow({
  row,
  options,
  isOpen,
  onToggle,
  onPick,
}: {
  row: SearchPlanRow;
  options: readonly string[];
  isOpen: boolean;
  onToggle: () => void;
  onPick: (value: string) => void;
}) {
  // A dead "change" control is worse than none: with one item there is nothing
  // to change to, and with no term there is nothing being sent to change.
  const canChange = row.term !== undefined && options.length > 1;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <dt className="text-sm text-content-secondary">{row.label}</dt>
        <dd className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm font-medium text-content-primary">
          {/* A row either sends a term or explains why it doesn't — never a
           *  bare pair of empty quotes (`search-plan.ts`). */}
          {row.term !== undefined ? (
            <span>&quot;{row.term}&quot;</span>
          ) : (
            <span className="font-normal text-content-secondary">{row.detail}</span>
          )}
          {canChange && (
            <Button
              variant="link"
              size="md"
              aria-expanded={isOpen}
              aria-label={`Change what ${row.label} is searched for`}
              onClick={onToggle}
            >
              {isOpen ? "close" : "change"}
            </Button>
          )}
        </dd>
      </div>
      {canChange && isOpen && (
        <div className="flex flex-wrap gap-1.5">
          {/* Drop index 0, not the displayed term. They are the same chip on
           *  the common path, but not on `searchPhrase`'s title-less fallback,
           *  where the row shows several skills joined — there, filtering by
           *  the displayed string matches nothing and the picker would offer
           *  the already-primary skill, whose promote reducer is a no-op. A
           *  control that does nothing when clicked is worse than an absent
           *  one. */}
          {options
            .filter((option) => option !== options[0])
            .map((option) => (
              <Button
                key={option}
                variant="ghost"
                size="md"
                className="rounded-full border border-border-light px-2.5 py-1"
                onClick={() => onPick(option)}
              >
                {option}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
