// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useDownloadMarkdown — drives the "Download as Markdown" action on the
 * reconstructed-resume surface (#552), a sibling of `useDownloadPdf.ts`.
 *
 * Flow: build the flat ATS model from the surface's own props → lazily load
 * the pure `toCareerOpsMarkdown` adapter → encode to UTF-8 bytes → trigger a
 * same-document download. Everything is client-side; no network request is
 * made, satisfying the zero-egress AC. `to-markdown.ts` is dynamic-imported so
 * it stays out of the entry chunk, matching every other heavy/optional lane.
 */

import { useCallback, useState } from "react";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import { slugifyName, triggerBlobDownload } from "../lib/download/blob-download.ts";
import type { EditableParse } from "./useEditableParse.ts";
import { trackDownloadCompleted, type DownloadSource } from "../lib/analytics.ts";

export interface UseDownloadMarkdown {
  download: () => Promise<void>;
  isGenerating: boolean;
  error: string | null;
}

/** Turn a candidate name into a safe, lower-kebab markdown filename. */
function filenameFromName(name: string | undefined): string {
  const slug = slugifyName(name);
  return slug ? `${slug}-cv.md` : "cv.md";
}

export function useDownloadMarkdown(
  result: CascadeResult,
  score: AnonymousAtsScore,
  edit?: Pick<EditableParse, "contactOverrides" | "bulletOverrides">,
): UseDownloadMarkdown {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const model = buildAtsResumeModel(result, score, edit);
      const { toCareerOpsMarkdown } = await import("../lib/pdf/to-markdown.ts");
      const bytes = new TextEncoder().encode(toCareerOpsMarkdown(model));
      triggerBlobDownload(
        bytes,
        "text/markdown;charset=utf-8",
        filenameFromName(model.contact.name),
      );

      // Same source-derivation as `useDownloadPdf.ts` (#313): `tiers` is empty
      // ONLY for `buildBlankResult()`'s output.
      const source: DownloadSource =
        result.tiers.length === 0 ? "blank" : "upload";
      trackDownloadCompleted({ source, format: "markdown" });
      // Deliberately does NOT clear the blank draft (unlike `useDownloadPdf.ts`):
      // markdown is a plain-text interchange artifact, not the final ATS export,
      // so a user may download it mid-authoring and keep editing — wiping the
      // durable from-scratch draft here would be a data-loss surprise.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the markdown file.");
    } finally {
      setIsGenerating(false);
    }
  }, [result, score, edit]);

  return { download, isGenerating, error };
}
