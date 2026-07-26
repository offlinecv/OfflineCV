// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * CompanyTargets — the suggested-companies block of the Find Jobs panel (#533).
 *
 * Display-only: every piece of state (the sector guess, which companies are
 * selected) is owned by `useCompanyTargets`, and the fan-out is owned by
 * `FindJobsPanel`. Split into its own sibling rather than appended to the panel
 * because `FindJobsPanel` is already past the ~200 LOC guide in CLAUDE.md.
 *
 * Each company is a toggle `Button` with `aria-pressed`, not a chip with a
 * remove "×". Two reasons: the `Chip` primitive is non-interactive by design,
 * and a company that is off is still a suggestion the user can turn back on —
 * "×" would imply it's gone. `aria-pressed` carries the state to a screen
 * reader, and a "✓" text mark carries it visually, so selection is never
 * signalled by colour alone.
 *
 * COLLAPSED BY DEFAULT (#597). This block sits above the query form and used to
 * open as three wrapped rows of chips plus two paragraphs — the first thing on
 * `/jobs/` and the last thing a user came to read. Collapsed it is one line
 * that still makes the whole claim (how many boards, and that only the company
 * name is sent), so nothing load-bearing is hidden behind the disclosure; what
 * expands is the per-company retuning, which is a deliberate act. The
 * disclosure is a `Button` with `aria-expanded` + local state — the house
 * pattern (`FindJobsPanel`'s own fold); there is no Disclosure primitive in the
 * `@design-system` barrel and this is not the reason to add one.
 */

import { useState } from "react";
import { Button } from "@design-system";
import type { CompanyEntry } from "../../lib/job-search/company-registry.ts";
import type { CompanyTargets as CompanyTargetsState } from "../../hooks/useCompanyTargets.ts";

/** Sector slugs are kebab-case taxonomy values ("crypto-web3"); this is the
 *  only place they are shown to a human, so they get spaced out here rather
 *  than carrying a display-name column through the taxonomy. */
function sectorLabel(sector: string): string {
  return sector.replace(/-/g, " / ");
}

/** The one line that survives the collapse — it must carry the whole claim on
 *  its own, since it is all most users will read.
 *
 *  `hasSuggestions` separates two states a bare count cannot tell apart: a user
 *  who reviewed the suggested boards and kept none, versus a résumé we could
 *  match to no sector at all. Both end at "the job feeds only", but only the
 *  first is a choice, and calling the second "no companies selected" would
 *  blame the user for a gap in our registry. */
function summaryLine(selectedCount: number, hasSuggestions: boolean): string {
  if (!hasSuggestions) {
    return "We couldn't match your resume to a sector we have companies for, so this search uses the job feeds only.";
  }
  if (selectedCount === 0) {
    return "No companies selected — this search uses the job feeds only.";
  }
  return `We'll check ${selectedCount} ${
    selectedCount === 1 ? "company's" : "companies'"
  } public job ${selectedCount === 1 ? "board" : "boards"} — only the company name is sent, never your resume.`;
}

export function CompanyTargets({ targets }: { targets: CompanyTargetsState }) {
  const { ready, sector, runnerUp, suggested, selected } = targets;
  // Purely presentational, so it stays local — same as `FindJobsPanel`'s fold.
  // Declared above the `ready` guard: a hook may not sit behind a return.
  const [expanded, setExpanded] = useState(false);

  // Before the registry chunk resolves there is nothing truthful to say, and
  // a spinner for a lazy import that usually takes a frame would flicker.
  if (!ready) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="max-w-prose text-sm text-content-secondary">
          {summaryLine(selected.length, suggested.length > 0)}
        </p>
        {/* No disclosure when there is nothing to disclose: "Choose companies"
         *  over an empty registry match is a control that opens onto its own
         *  apology. The summary line above already says the whole truth in
         *  that state. */}
        {suggested.length > 0 && (
          <Button
            variant="link"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide companies" : "Choose companies"}
          </Button>
        )}
      </div>

      {expanded && suggested.length > 0 && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm text-content-secondary">
              {suggested.length > 0 && sector
                ? `Companies we matched to your background (${sectorLabel(sector)})`
                : "Companies"}
            </span>
            {runnerUp && (
              <Button
                variant="link"
                size="sm"
                onClick={targets.switchToRunnerUp}
              >
                Not right? Try {sectorLabel(runnerUp)}
              </Button>
            )}
          </div>

          {/* The selection state itself is the collapsed summary line above —
           *  repeating it here would be the same sentence twice on one screen.
           *  The empty case never reaches this branch: with no suggestions
           *  there is no disclosure to open. */}
          <div className="flex flex-wrap gap-1.5">
            {suggested.map((entry: CompanyEntry) => {
              const isOn = targets.isSelected(entry);
              return (
                <Button
                  key={`${entry.ats}:${entry.slug}`}
                  variant="ghost"
                  size="sm"
                  aria-pressed={isOn}
                  onClick={() => targets.toggle(entry)}
                  className={
                    isOn
                      ? "rounded-full border border-accent-primary px-2.5 py-1"
                      : "rounded-full border border-border-light px-2.5 py-1 text-content-secondary"
                  }
                >
                  <span aria-hidden="true">{isOn ? "✓︎" : "+"}</span>
                  {entry.name}
                </Button>
              );
            })}
          </div>

          {/* #542: large employers with self-hosted careers sites (Apple,
           *  Google, Meta, …) aren't on Greenhouse/Lever/Ashby, so they can
           *  never appear in this list — a structural boundary of the
           *  three-vendor design, not a curation gap. "Search external boards"
           *  (LinkedIn / Indeed / Google Jobs) is the intended path to those.
           *  No "above"/"below" here: this block is pinned to the top of
           *  `/jobs/` while the board links live in the foldable search
           *  details, so any direction word would be wrong half the time. */}
          <p className="max-w-prose text-sm text-content-secondary">
            Large employers with their own careers site (e.g. Apple, Google,
            Meta) aren&apos;t reachable here — find them via the external board
            links in the search details.
          </p>
        </>
      )}
    </div>
  );
}
