// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Evidence panel bodies — "how a generic extractor read this file".
 *
 * These were a single stacked 2-up grid (issue #83); #177 splits them into
 * separate tab-panel bodies so Result's Tabs consume each one directly:
 *   – SourcePdfPanel     — the source PDF preview (or DOCX no-preview fallback),
 *                          under the "Original PDF" segment
 *   – ExtractedTextPanel — the extracted plain-text <pre>, under "Plain text"
 *     (both segment names per #680 item 4; renamed from "PDF" / "Extracted
 *     text")
 * Layout warnings reuse the standalone <LayoutFlagsList> directly. Pure display.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { PdfPreview } from "../PdfPreview.tsx";

type SourceKind = "pdf" | "docx" | "markdown";

interface SourcePdfPanelProps {
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
}

/** Names what cannot be previewed, so the "Original DOCX" / "Original
 *  Markdown" segment label reads as a promise the fallback explains rather
 *  than one it breaks (#680): the segment is about the original file, and
 *  this says why it is not drawn. A `pdf` lands here only without bytes (a
 *  restored record), hence "this PDF" rather than the format. */
const NO_PREVIEW_SUBJECT: Record<SourceKind, string> = {
  pdf: "this PDF",
  docx: "DOCX files",
  markdown: "Markdown files",
};

export function SourcePdfPanel({ bytes, sourceKind }: SourcePdfPanelProps) {
  if (sourceKind === "pdf" && bytes != null) {
    return (
      <div className="max-h-[600px] overflow-y-auto">
        <PdfPreview bytes={bytes} />
      </div>
    );
  }
  return (
    <p className="text-sm text-content-muted">
      No source preview available for {NO_PREVIEW_SUBJECT[sourceKind]} — see
      the Plain text view.
    </p>
  );
}

interface ExtractedTextPanelProps {
  result: CascadeResult;
}

export function ExtractedTextPanel({ result }: ExtractedTextPanelProps) {
  return (
    <pre className="max-h-[600px] overflow-auto rounded border border-border-light bg-surface-subtle p-3 text-sm leading-relaxed">
      {result.rawText || "(no text extracted)"}
    </pre>
  );
}
