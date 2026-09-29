// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * PdfPreview — renders a multi-page PDF preview (#1077).
 *
 * Used both in ExportDialog's live export preview and EvidencePanel's source PDF view.
 * Renders every page in order (uncapped by default, or capped if maxPages is passed)
 * using React-managed canvases, Retina DPR sharpness, and selectable text layers.
 */

import { useEffect, useRef, useState } from "react";
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import { PdfPage } from "./PdfPage.tsx";
import "./pdf-preview.css";

export interface PdfPreviewProps {
  /** PDF bytes. A new ArrayBuffer or Uint8Array triggers a re-render. */
  bytes: Uint8Array | ArrayBuffer;
  /** Render only the first N pages. Defaults to all pages. */
  maxPages?: number;
  /** Callback notifying parent when a page scrolls into primary view. */
  onPageInView?: (pageNumber: number) => void;
}

export function PdfPreview({
  bytes,
  maxPages,
  onPageInView,
}: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState<number>(1.0);

  // Responsive scale based on container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    // Every page re-renders (re-fetches, rebuilds the text layer, re-paints)
    // when `scale` changes, so a raw per-tick setScale fully re-renders every
    // mounted page on each frame of a resize drag. Trailing-edge debounce via
    // rAF collapses a drag to one commit (#1091 review).
    let frame: number | null = null;
    const ro = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width;
      if (!width || width <= 0) return;
      if (frame != null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        // Standard US Letter is 612 pt wide. Fit container width with reasonable limits.
        const calculatedScale = Math.min(width / 612, 1.25);
        setScale(Math.max(calculatedScale, 0.4));
      });
    });

    ro.observe(el);
    return () => {
      ro.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let loadedDoc: PDFDocumentProxy | null = null;

    setError(null);
    setDoc(null);

    (async () => {
      try {
        // Pass a copy so pdfjs does not mutate or detach the caller's buffer
        const data =
          bytes instanceof Uint8Array
            ? new Uint8Array(bytes)
            : new Uint8Array(bytes.slice(0));

        loadingTask = getDocument({ data });
        loadedDoc = await loadingTask.promise;

        if (!cancelled) {
          setDoc(loadedDoc);
        } else {
          loadedDoc.destroy();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (loadedDoc) {
        loadedDoc.destroy();
      } else if (loadingTask) {
        loadingTask.destroy();
      }
    };
  }, [bytes]);

  const pageCount = doc
    ? maxPages != null
      ? Math.min(doc.numPages, maxPages)
      : doc.numPages
    : 0;

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-4 w-full"
      aria-label="PDF Preview"
    >
      {error && (
        <p className="text-sm text-feedback-error-text">
          Preview failed: {error}
        </p>
      )}

      {!doc && !error && (
        <div
          className="mx-auto w-full max-w-[612px] aspect-[612/792] rounded border border-border-light bg-surface-paper shadow-sm animate-pulse"
          aria-label="Loading preview"
        />
      )}

      {doc &&
        pages.map((pageNum) => (
          <PdfPage
            key={pageNum}
            doc={doc}
            pageNumber={pageNum}
            scale={scale}
            onVisible={onPageInView}
          />
        ))}
    </div>
  );
}
