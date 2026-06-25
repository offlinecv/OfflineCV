// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Evidence panel bodies — "how a generic extractor read this file".
 *
 * These were a single stacked 2-up grid (issue #83); #177 splits them into
 * separate tab-panel bodies so Result's Tabs consume each one directly:
 *   – SourcePdfPanel     — the source PDF preview (or DOCX no-preview fallback)
 *   – ExtractedTextPanel — the extracted plain-text <pre>
 * Layout flags reuse the standalone <LayoutFlagsList> directly. Pure display.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { PdfPreview } from "../PdfPreview.tsx";

type SourceKind = "pdf" | "docx";

interface SourcePdfPanelProps {
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
}

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
      No source preview available for DOCX — see the Extracted text tab.
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
