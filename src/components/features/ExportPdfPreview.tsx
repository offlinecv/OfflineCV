// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ExportPdfPreview — the live preview pane displayed inside ExportDialog (#1077).
 *
 * Responsibilities:
 *   - Renders the header caption: "Preview · N page(s)" and "Page X of Y" for multi-page exports.
 *   - Houses the independently scrollable column containing all rendered PDF pages.
 *   - Accessible label: aria-label="Preview of the PDF you will download".
 *   - Shows a page-sized placeholder during initial generation.
 */

import { useEffect, useState } from "react";
import { PdfPreview } from "../PdfPreview.tsx";

export interface ExportPdfPreviewProps {
  preview: { bytes: Uint8Array; pages: number } | null;
  isRendering: boolean;
  error: string | null;
}

export function ExportPdfPreview({
  preview,
  isRendering,
  error,
}: ExportPdfPreviewProps) {
  const [activePage, setActivePage] = useState(1);

  // A shrinking edit can leave activePage pointing past the new page count
  // until the IntersectionObserver next fires (#1091 review).
  useEffect(() => {
    setActivePage(1);
  }, [preview]);

  const pageCount = preview?.pages ?? 0;

  return (
    <aside
      aria-label="Preview of the PDF you will download"
      className="order-last md:order-first flex flex-col gap-2 w-full md:w-[48%] shrink-0"
    >
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-content-secondary">
          {preview
            ? `Preview · ${pageCount} ${pageCount === 1 ? "page" : "pages"}`
            : isRendering
              ? "Preview · Rendering…"
              : "Preview"}
        </span>
        {pageCount > 1 && (
          <span className="text-2xs text-content-muted">
            Page {activePage} of {pageCount}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto max-h-[50vh] md:max-h-[75vh] p-3 rounded-lg border border-border-light bg-surface-subtle/50">
        {error && !preview && (
          <p className="text-sm text-feedback-error-text py-4 text-center">
            {error}
          </p>
        )}

        {isRendering && !preview && !error && (
          <div
            className="w-full aspect-[612/792] rounded border border-border-light bg-surface-paper shadow-sm animate-pulse"
            aria-label="Loading preview"
          />
        )}

        {preview && (
          <PdfPreview bytes={preview.bytes} onPageInView={setActivePage} />
        )}
      </div>
    </aside>
  );
}
