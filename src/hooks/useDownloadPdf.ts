// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useDownloadPdf — drives the "Download PDF" action on the reconstructed-resume
 * surface (#171).
 *
 * Flow: build the flat ATS model from the surface's own props → check that the
 * export font can draw every character (#664) → render bytes with the pdf-lib
 * draw engine → wrap in a Blob → trigger a same-document download via a
 * temporary object URL.
 *
 * Zero-egress holds, but not because nothing is fetched: the renderer DOES issue
 * a `fetch` for the vendored Poppins TTFs, and this docblock previously claimed
 * "no network request is made (no font fetch, no upload)", which was false. The
 * fetch targets the app's own bundled-asset origin — never a font CDN — so no
 * résumé bytes leave the browser, which is the actual guarantee. Say custody,
 * not runtime.
 *
 * This hook owns the refusal for #664. When the Poppins fetch fails, the
 * renderer falls back to Helvetica, whose WinAnsi codec replaces anything
 * outside it with `?` — including a candidate's own name. Rather than hand back
 * a PDF reading `ANNA WI?NIEWSKA`, the hook probes first and refuses, because
 * the trigger is the network rather than the user's data and a retry usually
 * clears it. The refusal lives here and not in `renderAtsResumePdf` so that the
 * renderer's ~35 other call sites — every round-trip and export test, plus the
 * corpus oracle, which must keep rendering the degraded value to measure it —
 * are unaffected.
 */

import { useCallback, useState } from "react";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import {
  findExportGlyphLosses,
  renderAtsResumePdf,
  type ExportGlyphLoss,
} from "../lib/pdf/render-ats-pdf.ts";
import { slugifyName, triggerBlobDownload } from "../lib/download/blob-download.ts";
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

/**
 * The message shown when the export font is unavailable and the fallback would
 * mangle real characters (#664).
 *
 * Exported for its own test: the field list is the part a user acts on, and it
 * has to name the fields WITHOUT echoing their values — a résumé's own text does
 * not belong in an error banner. `where` labels are already user-facing (a
 * contact field name or the section's own heading), and duplicates collapse so a
 * résumé with forty arrow bullets does not produce a forty-item sentence.
 */
export function glyphLossMessage(losses: readonly ExportGlyphLoss[]): string {
  const fields = [...new Set(losses.map((l) => l.where))];
  const list =
    fields.length === 1
      ? fields[0]
      : `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
  return (
    `Could not load the résumé font, so this export would fall back to a font ` +
    `that cannot draw every character in your ${list}. Downloading now would ` +
    `replace those characters with "?". Check your connection and try again.`
  );
}

export function useDownloadPdf(
  result: CascadeResult,
  score: AnonymousAtsScore,
): UseDownloadPdf {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const model = buildAtsResumeModel(result, score);

      // #664: refuse rather than silently substituting "?" in the user's own
      // fields. Returns [] whenever the embedded font loaded OR nothing would
      // actually be lost, so a pure-ASCII résumé downloads exactly as before
      // even when the font fetch fails. Returning early skips the download and
      // the analytics event; `finally` still clears `isGenerating`.
      const losses = await findExportGlyphLosses(model);
      if (losses.length > 0) {
        setError(glyphLossMessage(losses));
        return;
      }

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
      trackDownloadCompleted({ source, format: "pdf" });
      // A successful blank-authored export is one of the explicit
      // draft-clearing triggers (#313) — the user has what they came for.
      if (source === "blank") clearBlankDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate PDF.");
    } finally {
      setIsGenerating(false);
    }
  }, [result, score]);

  return { download, isGenerating, error };
}
