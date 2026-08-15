// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ExportRows — the row shell every artifact in `ExportDialog` is rendered in,
 * plus the one row with enough chrome of its own to earn a name.
 *
 * Siblings of `ExportDialog` rather than sections inside it, for the reason
 * CLAUDE.md gives: a feature component past ~200 LOC decomposes. The split runs
 * along the seam that costs nothing — these are display-only. In particular the
 * report's two choices STAY in `ExportDialog`'s state and arrive here as props:
 * the format list unmounts whenever the pre-download gate takes its place, so a
 * row that owned them would silently reset the user's format and identity
 * picks on the way back from `Download anyway`.
 *
 * Each row NAMES its artifact — #680 item 5 ("the download affordance doesn't
 * say which résumé you get") and item 7 ("users don't know the export already
 * is the ATS-safe artifact").
 */

import type { ReactNode } from "react";
import { Button, Checkbox, ErrorState } from "@design-system";
import type { ReportFormat } from "../../lib/analytics.ts";
import type { useDownloadReport } from "../../hooks/useDownloadReport.ts";

/**
 * One artifact: what it is, how to get it, and where its failure is reported.
 *
 * `tone` is the row's rank in the dialog, and it is the only thing separating
 * the two résumé rows from the audit report. All three shipped identical
 * (`rounded-lg border p-3`), which said they were three equal choices — but two
 * of them are the résumé and one is a record ABOUT the résumé, and a user who
 * came to download their CV had no visual cue which pair to read.
 *
 * `card` is the bordered box the résumé rows keep. `aside` drops the box
 * entirely and takes a rule above it instead: the row stops being a peer
 * option and becomes what follows the list, which is what the audit report
 * actually is. It deliberately does NOT take a recessed `bg-surface-subtle` —
 * a tinted row would sit directly under a `secondary` Button painted in the
 * same token and swallow it. Never a hue, per #516 — weight, rule and type
 * colour only.
 */
export function ExportRow({
  title,
  description,
  error,
  tone = "card",
  children,
}: {
  title: string;
  description: string;
  error: string | null;
  tone?: "card" | "aside";
  children: ReactNode;
}) {
  const aside = tone === "aside";
  return (
    <section
      className={[
        "flex flex-col gap-2",
        aside
          ? "border-t border-border-light pt-4"
          : "rounded-lg border border-border-light p-3",
      ].join(" ")}
    >
      <h3
        className={[
          "text-sm font-semibold",
          aside ? "text-content-secondary" : "text-content-primary",
        ].join(" ")}
      >
        {title}
      </h3>
      <p
        className={[
          "text-sm",
          aside ? "text-content-tertiary" : "text-content-secondary",
        ].join(" ")}
      >
        {description}
      </p>
      {children}
      {error && <ErrorState>{error}</ErrorState>}
    </section>
  );
}

/**
 * The audit report — the one export that is not the résumé, and the only one
 * with options.
 *
 * **The identity header is opt-in, default OFF** (#343). When off, no identity
 * block reaches either renderer and the filename falls back to a generic one,
 * so even the filename carries no PII. The default lives with the state in
 * `ExportDialog`; this only renders the control.
 */
export function ExportReportRow({
  report,
  formatName,
  format,
  onFormatChange,
  includeIdentity,
  onIncludeIdentityChange,
}: {
  report: ReturnType<typeof useDownloadReport>;
  /** Shared `name` for the radio group, from the parent's `useId`. */
  formatName: string;
  format: ReportFormat;
  onFormatChange: (format: ReportFormat) => void;
  includeIdentity: boolean;
  onIncludeIdentityChange: (include: boolean) => void;
}) {
  return (
    <ExportRow
      title="Audit report"
      description="The audit findings — verdict, score breakdown, layout flags and the recommendation. Not your résumé; a shareable record of what this page found. Generated in this browser; nothing is uploaded."
      error={report.error}
      // The one row that is not the résumé, so the one row that sits below the
      // rule rather than in the list. The sentence saying so is still in the
      // description — the separation is there to be read BEFORE the sentence,
      // not instead of it.
      tone="aside"
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">Report format</legend>
        {(
          [
            ["pdf", "PDF report — human-readable"],
            ["json", "JSON — machine-readable"],
          ] as const
        ).map(([value, label]) => (
          <label
            key={value}
            className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-content-secondary"
          >
            <input
              type="radio"
              name={formatName}
              value={value}
              checked={format === value}
              disabled={report.isGenerating}
              onChange={() => onFormatChange(value)}
              className="h-4 w-4 accent-accent-primary"
            />
            {label}
          </label>
        ))}
      </fieldset>
      <Checkbox
        checked={includeIdentity}
        onChange={onIncludeIdentityChange}
        disabled={report.isGenerating}
        label="Include my name and contact details"
      />
      {/* `secondary`, not `ghost`: this is a real download, and `ghost` has no
          resting background at all — under two rows of choices it read as a
          caption rather than as the control that produces the file. The
          dialog's ladder is primary (the résumé PDF) → secondary (the other
          two artifacts) → ghost (Close), so rank is carried by the button AND
          by which side of the rule the row sits on. */}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void report.download({ format, includeIdentity })}
        disabled={report.isGenerating}
      >
        {report.isGenerating ? "Generating…" : "Download report"}
      </Button>
    </ExportRow>
  );
}
