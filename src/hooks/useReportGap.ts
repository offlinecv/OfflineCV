// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * useReportGap — drives the "Report a parsing gap" download (issue #245).
 *
 * Builds the structure-only repro artifact (`buildReproArtifact`), serializes it
 * to JSON, and triggers a LOCAL, same-document download via a temporary object
 * URL — exactly the zero-egress pattern `useDownloadPdf` uses. NOTHING is
 * uploaded; the user attaches the file to a GitHub issue by hand.
 *
 * PII safety lives one layer down, in `buildReproArtifact`: the artifact is
 * structure-only BY CONSTRUCTION (no name/email/phone/bullet text). This hook is
 * just the React/Blob glue and must never reach past the artifact into
 * `result.rawText`, `result.markdown`, or any value-bearing field to "enrich"
 * the download — doing so would defeat the artifact's PII guarantee.
 *
 * Telemetry is COUNT ONLY (`trackGapReported`) and env-gated — the artifact
 * contents never cross the analytics path.
 */

import { useCallback, useState } from "react";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { ParseDisagreement } from "../lib/heuristics/disagreement.ts";
import { buildReproArtifact } from "../lib/heuristics/repro-artifact.ts";
import { triggerBlobDownload } from "../lib/download/blob-download.ts";
import { trackGapReported } from "../lib/analytics.ts";

export interface UseReportGap {
  /** Build + download the structure-only repro artifact. */
  report: () => void;
  /** True for a moment after a successful download (drives the thank-you copy). */
  reported: boolean;
  error: string | null;
}

/** Timestamped, PII-free filename for the repro artifact download. */
function artifactFilename(): string {
  // YYYYMMDD-HHMMSS from the local clock — no résumé-derived text.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `resumelint-repro-${stamp}.json`;
}

export function useReportGap(
  result: CascadeResult,
  disagreements: readonly ParseDisagreement[] = [],
): UseReportGap {
  const [reported, setReported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback(() => {
    setError(null);
    try {
      const artifact = buildReproArtifact(result, disagreements);
      const json = JSON.stringify(artifact, null, 2);
      triggerBlobDownload(json, "application/json", artifactFilename());
      // Count-only, env-gated telemetry — never the artifact contents.
      trackGapReported({
        disagreementCount: disagreements.length,
        triggers: result.triggers,
      });
      setReported(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not generate the report.",
      );
    }
  }, [result, disagreements]);

  return { report, reported, error };
}
