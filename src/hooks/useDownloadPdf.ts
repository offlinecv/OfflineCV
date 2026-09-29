// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useDownloadPdf — drives the "Download PDF" action on the reconstructed-resume
 * surface (#171) and powers the export preview (#1077).
 *
 * Flow:
 *   - `render()`: builds the flat ATS model from surface props → checks font
 *     support (#664 refusal) → renders PDF bytes with pdf-lib → caches the
 *     preview `{ bytes, pages }`.
 *   - `download()`: saves the cached bytes (or triggers an on-demand render if
 *     not yet previewed) → wraps in a Blob → triggers same-document download.
 *
 * Zero-egress holds: Liberation Sans font fetches target the app's own bundled
 * origin, never a CDN. Data custody remains strictly client-side.
 *
 * Findings (#621): advisory reports on what could not be drawn cleanly.
 * Populated post-download so findings describe the delivered file rather than
 * acting as an unearned warning before the user downloads.
 *
 * Refusal for #664: if Liberation Sans is missing and fallback to Helvetica
 * would mangle characters (e.g. Polish diacritics), the hook probes first and
 * sets `error`, leaving `preview` null and refusing the download.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import { buildAtsResumeModel } from "../lib/pdf/ats-resume-model.ts";
import {
  findExportGlyphLosses,
  renderAtsResumePdf,
  type ExportGlyphLoss,
} from "../lib/pdf/render-ats-pdf.ts";
import type { RenderFinding } from "../lib/pdf/render-findings.ts";
import { slugifyName, triggerBlobDownload } from "../lib/download/blob-download.ts";
import { trackDownloadCompleted, type DownloadSource } from "../lib/analytics.ts";
import { clearBlankDraft } from "./useResumeAnalysis.ts";

export interface UseDownloadPdf {
  render: () => Promise<void>;
  download: () => Promise<void>;
  /** Bytes of the last successful render for the CURRENT result/score; null while rendering or after an input change. */
  preview: { bytes: Uint8Array; pages: number } | null;
  isRendering: boolean;
  isGenerating: boolean;
  error: string | null;
  /**
   * What the LAST completed export could not draw cleanly (#621) — empty until a
   * download has run, and empty again the moment the next one starts, so the
   * surface can never show findings that belong to a résumé the user has since
   * edited. Advisory only: the download already happened.
   */
  findings: RenderFinding[];
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

function isMatchingRender(
  cached: { result: CascadeResult; score: AnonymousAtsScore } | null,
  currResult: CascadeResult,
  currScore: AnonymousAtsScore,
): boolean {
  if (!cached) return false;
  if (cached.result !== currResult) return false;
  return (
    cached.score === currScore ||
    (cached.score.overall === currScore.overall &&
      cached.score.preLayoutOverall === currScore.preLayoutOverall)
  );
}

export function useDownloadPdf(
  result: CascadeResult,
  score: AnonymousAtsScore,
  /** Fired once the bytes have actually reached the user, so the caller can
   *  record the journey's `Download` stage (#826). The success point is the
   *  same one `trackDownloadCompleted` sits on — a refused export (#664) or a
   *  render failure must not earn the mark. */
  onDownloaded?: () => void,
): UseDownloadPdf {
  const [preview, setPreview] = useState<{ bytes: Uint8Array; pages: number } | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [findings, setFindings] = useState<RenderFinding[]>([]);

  const lastRenderRef = useRef<{
    result: CascadeResult;
    score: AnonymousAtsScore;
    bytes: Uint8Array;
    pages: number;
    findings: RenderFinding[];
  } | null>(null);

  const prevResultRef = useRef(result);
  const prevScoreOverallRef = useRef(score.overall);
  const prevScorePreLayoutRef = useRef(score.preLayoutOverall);

  // Bumped on unmount and on every input change, so an in-flight render's
  // completion can tell whether it is still the one that should be allowed to
  // touch state — an older render finishing after a newer one (or after
  // unmount) must not overwrite the current preview/error/isRendering (#1091
  // review: stale-completion race + unmount crash).
  const renderSeqRef = useRef(0);

  // Invalidate cached preview whenever result or score changes (#1077).
  useEffect(() => {
    if (
      prevResultRef.current !== result ||
      prevScoreOverallRef.current !== score.overall ||
      prevScorePreLayoutRef.current !== score.preLayoutOverall
    ) {
      prevResultRef.current = result;
      prevScoreOverallRef.current = score.overall;
      prevScorePreLayoutRef.current = score.preLayoutOverall;
      renderSeqRef.current++;
      setPreview(null);
      lastRenderRef.current = null;
    }
  }, [result, score.overall, score.preLayoutOverall]);

  useEffect(() => {
    return () => {
      renderSeqRef.current++;
    };
  }, []);

  const render = useCallback(async () => {
    if (isMatchingRender(lastRenderRef.current, result, score)) {
      return;
    }

    const seq = ++renderSeqRef.current;
    setIsRendering(true);
    setError(null);
    try {
      const model = buildAtsResumeModel(result, score);
      const losses = await findExportGlyphLosses(model);
      if (seq !== renderSeqRef.current) return;
      if (losses.length > 0) {
        setError(glyphLossMessage(losses));
        setPreview(null);
        lastRenderRef.current = null;
        return;
      }

      const rendered = await renderAtsResumePdf(model);
      if (seq !== renderSeqRef.current) return;
      lastRenderRef.current = {
        result,
        score,
        bytes: rendered.bytes,
        pages: rendered.pages,
        findings: rendered.findings,
      };
      setPreview({ bytes: rendered.bytes, pages: rendered.pages });
    } catch (err) {
      if (seq !== renderSeqRef.current) return;
      setError(err instanceof Error ? err.message : "Could not generate PDF.");
      setPreview(null);
      lastRenderRef.current = null;
    } finally {
      if (seq === renderSeqRef.current) setIsRendering(false);
    }
  }, [result, score]);

  const download = useCallback(async () => {
    // Not bumped: a download must not cancel an in-flight render. Only read,
    // so an input change (or unmount) mid-export keeps this completion from
    // writing the previous résumé's bytes into the current preview. The file
    // itself and its analytics still land — they belong to the click that
    // started them (#1091 review).
    const seq = renderSeqRef.current;
    const isCurrent = () => seq === renderSeqRef.current;
    setIsGenerating(true);
    setError(null);
    // Cleared up front, alongside `error`, for the same reason: a stale report
    // about the PREVIOUS export would read as a verdict on this one.
    setFindings([]);
    try {
      const model = buildAtsResumeModel(result, score);
      let bytes: Uint8Array;
      let renderedFindings: RenderFinding[];

      if (isMatchingRender(lastRenderRef.current, result, score)) {
        bytes = lastRenderRef.current!.bytes;
        renderedFindings = lastRenderRef.current!.findings;
      } else {
        // #664: refuse rather than silently substituting "?" in the user's own
        // fields.
        const losses = await findExportGlyphLosses(model);
        if (losses.length > 0) {
          if (isCurrent()) {
            setError(glyphLossMessage(losses));
            setPreview(null);
            lastRenderRef.current = null;
          }
          return;
        }

        const rendered = await renderAtsResumePdf(model);
        bytes = rendered.bytes;
        renderedFindings = rendered.findings;
        if (isCurrent()) {
          lastRenderRef.current = {
            result,
            score,
            bytes: rendered.bytes,
            pages: rendered.pages,
            findings: rendered.findings,
          };
          setPreview({ bytes: rendered.bytes, pages: rendered.pages });
        }
      }

      // `bytes.slice()` copies into a fresh ArrayBuffer-backed view so Blob gets
      // a clean buffer.
      triggerBlobDownload(
        bytes.slice(),
        "application/pdf",
        filenameFromName(model.contact.name),
      );
      // AFTER the download, never before: a finding is a report on the file the
      // user now has, not a gate in front of it (#621).
      if (isCurrent()) setFindings(renderedFindings);

      // Distinguish a from-scratch authored download from an uploaded one
      // (#313). `tiers` is empty ONLY for `buildBlankResult()`'s output —
      // every real cascade path (PDF or DOCX) always pushes at least one
      // tier — so this is a reliable structural signal without threading an
      // extra prop through `ReconstructedResume` (out of scope here).
      const source: DownloadSource =
        result.tiers.length === 0 ? "blank" : "upload";
      trackDownloadCompleted({ source, format: "pdf" });
      onDownloaded?.();
      // A successful blank-authored export is one of the explicit
      // draft-clearing triggers (#313) — the user has what they came for.
      if (source === "blank") clearBlankDraft();
    } catch (err) {
      if (isCurrent()) {
        setError(err instanceof Error ? err.message : "Could not generate PDF.");
      }
    } finally {
      setIsGenerating(false);
    }
  }, [result, score, onDownloaded]);

  return { render, download, preview, isRendering, isGenerating, error, findings };
}
