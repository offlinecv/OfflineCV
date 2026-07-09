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
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import { toJsonResume } from "../lib/pdf/to-json-resume.ts";
import { renderAuditReportPdf } from "../lib/pdf/render-audit-report.ts";
import {
  serializeAuditReportJson,
  type AuditReportInput,
} from "../lib/report/serialize.ts";
import type { EditableParse } from "./useEditableParse.ts";
import { trackReportDownloaded, type ReportFormat } from "../lib/analytics.ts";

export interface DownloadReportOptions {
  format: ReportFormat;
  /** Include the candidate's identity header. Default-off at the call site. */
  includeIdentity: boolean;
}

export interface UseDownloadReport {
  download: (opts: DownloadReportOptions) => Promise<void>;
  isGenerating: boolean;
  error: string | null;
}

/** Lower-kebab slug for the report filename; empty in → generic name. */
function slugFromName(name: string | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

/** Trigger a same-document download of `bytes` as `filename`. */
function triggerDownload(bytes: BlobPart, mime: string, filename: string): void {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke: a.click() only schedules the download; revoking synchronously
  // can kill it on slower/remote contexts + Firefox/Safari (mirrors useDownloadPdf).
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function useDownloadReport(
  result: CascadeResult,
  score: AnonymousAtsScore,
  edit?: Pick<EditableParse, "contactOverrides" | "bulletOverrides">,
): UseDownloadReport {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(
    async ({ format, includeIdentity }: DownloadReportOptions) => {
      setIsGenerating(true);
      setError(null);
      try {
        // Identity is sourced ONLY when opted in — never build a basics block
        // we're about to strip (defense in depth alongside the serializer gate).
        const identity = includeIdentity
          ? toJsonResume(buildAtsResumeModel(result, score, edit)).basics
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
        const slug = includeIdentity ? slugFromName(identity?.name) : "";
        const base = slug ? `${slug}-resume-audit-report` : "resume-audit-report";

        if (format === "pdf") {
          const bytes = await renderAuditReportPdf(input);
          triggerDownload(bytes.slice(), "application/pdf", `${base}.pdf`);
        } else {
          const json = serializeAuditReportJson(input);
          triggerDownload(json, "application/json", `${base}.json`);
        }

        trackReportDownloaded({ format, includeIdentity });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not generate report.",
        );
      } finally {
        setIsGenerating(false);
      }
    },
    [result, score, edit],
  );

  return { download, isGenerating, error };
}
