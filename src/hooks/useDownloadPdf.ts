// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useDownloadPdf — drives the "Download PDF" action on the reconstructed-resume
 * surface (#171).
 *
 * Flow: build the flat ATS model from the surface's own props → render bytes
 * with the pdf-lib draw engine → wrap in a Blob → trigger a same-document
 * download via a temporary object URL. Everything is client-side; no network
 * request is made (no font fetch, no upload), satisfying the zero-egress AC.
 */

import { useCallback, useState } from "react";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import { renderAtsResumePdf } from "../lib/pdf/render-ats-pdf.ts";
import { slugifyName, triggerBlobDownload } from "../lib/download/blob-download.ts";
import type { EditableParse } from "./useEditableParse.ts";
import { trackDownloadCompleted, type DownloadSource } from "../lib/analytics.ts";
import { clearBlankDraft } from "./useResumeAnalysis.ts";

export interface UseDownloadPdf {
  download: () => Promise<void>;
  isGenerating: boolean;
  error: string | null;
}

/** Turn a candidate name into a safe, lower-kebab PDF filename. */
function filenameFromName(name: string | undefined): string {
  const slug = slugifyName(name);
  return slug ? `${slug}-resume-ats.pdf` : "resume-ats.pdf";
}

export function useDownloadPdf(
  result: CascadeResult,
  score: AnonymousAtsScore,
  edit?: Pick<EditableParse, "contactOverrides" | "bulletOverrides">,
): UseDownloadPdf {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const model = buildAtsResumeModel(result, score, edit);
      const bytes = await renderAtsResumePdf(model);
      // `bytes.slice()` copies into a fresh ArrayBuffer-backed view so Blob gets
      // a clean buffer.
      triggerBlobDownload(
        bytes.slice(),
        "application/pdf",
        filenameFromName(model.contact.name),
      );

      // Distinguish a from-scratch authored download from an uploaded one
      // (#313). `tiers` is empty ONLY for `buildBlankResult()`'s output —
      // every real cascade path (PDF or DOCX) always pushes at least one
      // tier — so this is a reliable structural signal without threading an
      // extra prop through `ReconstructedResume` (out of scope here).
      const source: DownloadSource =
        result.tiers.length === 0 ? "blank" : "upload";
      trackDownloadCompleted({ source });
      // A successful blank-authored export is one of the explicit
      // draft-clearing triggers (#313) — the user has what they came for.
      if (source === "blank") clearBlankDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate PDF.");
    } finally {
      setIsGenerating(false);
    }
  }, [result, score, edit]);

  return { download, isGenerating, error };
}
