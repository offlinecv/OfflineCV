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
 */

import { Button } from "@design-system";
import type { CompanyEntry } from "../../lib/job-search/company-registry.ts";
import type { CompanyTargets as CompanyTargetsState } from "../../hooks/useCompanyTargets.ts";

/** Sector slugs are kebab-case taxonomy values ("crypto-web3"); this is the
 *  only place they are shown to a human, so they get spaced out here rather
 *  than carrying a display-name column through the taxonomy. */
function sectorLabel(sector: string): string {
  return sector.replace(/-/g, " / ");
}

export function CompanyTargets({ targets }: { targets: CompanyTargetsState }) {
  const { ready, sector, runnerUp, suggested, selected } = targets;

  // Before the registry chunk resolves there is nothing truthful to say, and
  // a spinner for a lazy import that usually takes a frame would flicker.
  if (!ready) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-xs text-content-tertiary">
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

      {suggested.length === 0 ? (
        <p className="max-w-prose text-xs text-content-tertiary">
          We couldn&apos;t match your resume to a sector we have companies for,
          so this search uses the job feeds only.
        </p>
      ) : (
        <>
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
                      : "rounded-full border border-border-light px-2.5 py-1 text-content-tertiary"
                  }
                >
                  <span aria-hidden="true">{isOn ? "✓︎" : "+"}</span>
                  {entry.name}
                </Button>
              );
            })}
          </div>
          <p className="max-w-prose text-xs text-content-tertiary">
            {selected.length === 0
              ? "No companies selected — this search uses the job feeds only."
              : `We'll read ${selected.length} ${
                  selected.length === 1 ? "company's" : "companies'"
                } public job board directly. Only the company name is sent — never your resume.`}
          </p>
        </>
      )}

      {/* #542: large employers with self-hosted careers sites (Apple, Google,
       *  Meta, …) aren't on Greenhouse/Lever/Ashby, so they can never appear
       *  in this list — a structural boundary of the three-vendor design, not
       *  a curation gap. "Search external boards" above (LinkedIn / Indeed /
       *  Google Jobs) is the intended path to those. */}
      <p className="max-w-prose text-xs text-content-tertiary">
        Large employers with their own careers site (e.g. Apple, Google,
        Meta) aren&apos;t reachable here — find them via the external boards
        above.
      </p>
    </div>
  );
}
