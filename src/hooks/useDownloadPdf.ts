// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
import type { EditableParse } from "./useEditableParse.ts";

export interface UseDownloadPdf {
  download: () => Promise<void>;
  isGenerating: boolean;
  error: string | null;
}

/** Turn a candidate name into a safe, lower-kebab PDF filename. */
function filenameFromName(name: string | undefined): string {
  const slug = (name ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
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
    let url: string | null = null;
    try {
      const model = buildAtsResumeModel(result, score, edit);
      const bytes = await renderAtsResumePdf(model);
      // Copy into a fresh ArrayBuffer-backed view so Blob gets a clean buffer.
      const blob = new Blob([bytes.slice()], { type: "application/pdf" });
      url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFromName(model.contact.name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer the revoke: a.click() only SCHEDULES the download — the browser
      // reads the object URL asynchronously afterward. Revoking synchronously
      // (e.g. in finally) invalidates the URL before the fetch starts, which
      // silently kills the download on slower/remote contexts and on
      // Firefox/Safari. Hand the URL off, then revoke on a later task.
      const settledUrl = url;
      url = null;
      setTimeout(() => URL.revokeObjectURL(settledUrl), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate PDF.");
    } finally {
      if (url) URL.revokeObjectURL(url);
      setIsGenerating(false);
    }
  }, [result, score, edit]);

  return { download, isGenerating, error };
}
