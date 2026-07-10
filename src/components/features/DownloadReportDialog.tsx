// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ReportDownloadControl — the "Download report" affordance (#343).
 *
 * A SECONDARY control that sits next to the primary "Download PDF" button on
 * the reconstructed-résumé surface. Clicking it opens a small dialog offering a
 * format choice (PDF report / JSON) and an "include identity" checkbox that is
 * DEFAULT-OFF, so the default export is anonymous and safe to share publicly.
 * On confirm it generates + downloads the chosen artifact via
 * `useDownloadReport`.
 *
 * Reuse analysis (CLAUDE.md 3-tier rule), mirroring DownloadGateDialog:
 *   - Primitive: `Dialog` from `@design-system` owns the modal chrome / focus
 *     trap / Esc / ARIA. No raw `<dialog>`.
 *   - Primitive: `Button` for the trigger and both actions. No raw `<button>`.
 *   - The download/generation logic lives entirely in `useDownloadReport`
 *     (a lib-backed hook); this component only owns the pick-format-and-confirm
 *     interaction state.
 *
 * This is a self-contained control so `ReconstructedResume` adds a single
 * element next to its Download-PDF button and stays under ~200 LOC.
 */

import { useId, useState } from "react";
import { Button, Dialog } from "@design-system";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { EditableParse } from "../../hooks/useEditableParse.ts";
import type { ReportFormat } from "../../lib/analytics.ts";
import { useDownloadReport } from "../../hooks/useDownloadReport.ts";

export function ReportDownloadControl({
  result,
  score,
  edit,
}: {
  result: CascadeResult;
  score: AnonymousAtsScore;
  edit?: Pick<EditableParse, "contactOverrides" | "bulletOverrides">;
}) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ReportFormat>("pdf");
  const [includeIdentity, setIncludeIdentity] = useState(false);
  const identityId = useId();
  const formatName = useId();
  const { download, isGenerating, error } = useDownloadReport(
    result,
    score,
    edit,
  );

  async function handleConfirm() {
    // Close ONLY on success — a failed generation sets `error`, and closing
    // here would unmount the dialog before the error line renders, leaving the
    // user with no artifact and no message (#421 Blocking #4).
    const ok = await download({ format, includeIdentity });
    if (ok) setOpen(false);
  }

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label="Download the audit report as a shareable file"
      >
        Download report
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Download report"
        className="max-w-sm"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-content-secondary">
            Export the audit findings — verdict, score breakdown, layout flags,
            and the recommendation — as a shareable file. Generated in this
            browser; nothing is uploaded.
          </p>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-content-muted">
              Format
            </legend>
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
                  disabled={isGenerating}
                  onChange={() => setFormat(value)}
                  className="h-4 w-4 accent-brand-amber"
                />
                {label}
              </label>
            ))}
          </fieldset>

          <label
            htmlFor={identityId}
            className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-content-secondary"
          >
            <input
              id={identityId}
              type="checkbox"
              checked={includeIdentity}
              disabled={isGenerating}
              onChange={(e) => setIncludeIdentity(e.target.checked)}
              className="h-4 w-4 accent-brand-amber"
            />
            Include my name and contact details
          </label>

          {error && <p className="text-sm text-feedback-warning-text">{error}</p>}

          <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={isGenerating}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleConfirm()}
              disabled={isGenerating}
            >
              {isGenerating ? "Generating…" : "Download"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
