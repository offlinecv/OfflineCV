// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useDownloadReport — drives the "Download report" action on the reconstructed-
 * resume surface (#343).
 *
 * The shareable audit report is the diagnostic OUTPUT (verdict + score
 * breakdown + layout triggers + recommendation), exported in the user's chosen
 * format:
 *   - PDF  → `render-audit-report.ts` (human-readable, lazy pdf-lib).
 *   - JSON → `report/serialize.ts` (machine-readable, pure).
 *
 * Everything is client-side; no network request is made — same zero-egress
 * contract as `useDownloadPdf`.
 *
 * PRIVACY GATE (the load-bearing rule, #343): the identity header is included
 * ONLY when the user opts in (`includeIdentity`). When off — the default — we
 * pass NO identity block to either renderer, and the download filename falls
 * back to a generic name so even the filename carries no PII. Identity, when
 * on, is sourced from #334's pure `toJsonResume(...).basics` so the header is
 * lossless and consistent with the résumé export.
 */

import { useCallback, useState } from "react";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { LayoutTrigger } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { getScoreRecommendation } from "../lib/score/recommendation.ts";
import { buildContact } from "../lib/pdf/ats-resume-model.ts";
import { basicsFromContact } from "../lib/pdf/to-json-resume.ts";
import { slugifyName, triggerBlobDownload } from "../lib/download/blob-download.ts";
import type { AuditReportInput } from "../lib/report/serialize.ts";
import type { EditableParse } from "./useEditableParse.ts";
import { trackReportDownloaded, type ReportFormat } from "../lib/analytics.ts";

export interface DownloadReportOptions {
  format: ReportFormat;
  /** Include the candidate's identity header. Default-off at the call site. */
  includeIdentity: boolean;
}

export interface UseDownloadReport {
  /** Generate + download the report. Resolves `true` on success, `false` when
   *  generation failed (the error is surfaced via `error`) — the caller gates
   *  closing the dialog on this so a failure doesn't unmount the error UI
   *  (#421 Blocking #4). */
  download: (opts: DownloadReportOptions) => Promise<boolean>;
  isGenerating: boolean;
  error: string | null;
}

export function useDownloadReport(
  result: CascadeResult,
  score: AnonymousAtsScore,
  edit?: Pick<EditableParse, "contactOverrides" | "bulletOverrides">,
): UseDownloadReport {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(
    async ({ format, includeIdentity }: DownloadReportOptions): Promise<boolean> => {
      setIsGenerating(true);
      setError(null);
      try {
        // Identity is sourced ONLY when opted in — never build a basics block
        // we're about to strip (defense in depth alongside the serializer gate).
        // Build it from the contact block directly (no full resume-model walk
        // just to read `.basics`, #421 Secondary #6).
        const identity = includeIdentity
          ? basicsFromContact(buildContact(result, edit?.contactOverrides ?? {}))
          : undefined;

        const input: AuditReportInput = {
          score,
          triggers: score.layout.triggers as readonly LayoutTrigger[],
          recommendation: getScoreRecommendation(score),
          generatedAt: new Date().toISOString(),
          includeIdentity,
          identity,
        };

        // Filename carries the name ONLY when identity is included — otherwise a
        // generic name so the download itself leaks nothing.
        const slug = includeIdentity ? slugifyName(identity?.name) : "";
        const base = slug ? `${slug}-resume-audit-report` : "resume-audit-report";

        // Lazy-load the renderer/serializer so the ~470 LOC audit-report path
        // stays out of the entry chunk for the sessions that never click
        // "Download report" (#421 Secondary #7, mirroring load-pdf-lib.ts).
        if (format === "pdf") {
          const { renderAuditReportPdf } = await import(
            "../lib/pdf/render-audit-report.ts"
          );
          const bytes = await renderAuditReportPdf(input);
          triggerBlobDownload(bytes.slice(), "application/pdf", `${base}.pdf`);
        } else {
          const { serializeAuditReportJson } = await import(
            "../lib/report/serialize.ts"
          );
          const json = serializeAuditReportJson(input);
          triggerBlobDownload(json, "application/json", `${base}.json`);
        }

        trackReportDownloaded({ format, includeIdentity });
        return true;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not generate report.",
        );
        return false;
      } finally {
        setIsGenerating(false);
      }
    },
    [result, score, edit],
  );

  return { download, isGenerating, error };
}
