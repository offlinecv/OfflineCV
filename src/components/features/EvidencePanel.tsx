// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * EvidencePanel — renders the "how a generic extractor read this file" section:
 * layout flags, source PDF preview, and extracted plain text.
 * Extracted from Result.tsx (issue #83). Pure display; no state.
 */

import type { CascadeResult, LayoutTrigger } from "../../lib/heuristics/types.ts";
import { PdfPreview } from "../PdfPreview.tsx";
import { LayoutFlagsList } from "./LayoutFlagsList.tsx";

type SourceKind = "pdf" | "docx";

interface EvidencePanelProps {
  result: CascadeResult;
  bytes?: ArrayBuffer;
  sourceKind: SourceKind;
}

export function EvidencePanel({ result, bytes, sourceKind }: EvidencePanelProps) {
  return (
    <section className="flex flex-col gap-4">
      <LayoutFlagsList triggers={result.triggers as readonly LayoutTrigger[]} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            {sourceKind === "pdf" ? "Source PDF" : "Source document"}
          </h2>
          {sourceKind === "pdf" && bytes != null ? (
            <div className="max-h-[600px] overflow-y-auto">
              <PdfPreview bytes={bytes} />
            </div>
          ) : (
            <p className="text-sm text-content-muted">
              No source preview available for DOCX — extracted text is shown
              to the right.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Extracted plain text
          </h2>
          <pre className="max-h-[600px] overflow-auto rounded border border-border-light bg-surface-subtle p-3 text-sm leading-relaxed">
            {result.rawText || "(no text extracted)"}
          </pre>
        </div>
      </div>
    </section>
  );
}
