// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * PdfPage — renders a single page of a PDF document (#1077).
 *
 * Responsibilities:
 *   - HiDPI canvas rendering with devicePixelRatio scaling (1 <= dpr <= 3).
 *   - pdfjs TextLayer overlay for native text selection and copying.
 *   - Cancellation safety: aborts in-flight render tasks on unmount or prop changes.
 *   - Semantic tokens: bg-surface-paper (white paper sheet in all themes).
 *   - Reports visibility via IntersectionObserver for page indicator tracking.
 */

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";

export interface PdfPageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale?: number;
  onVisible?: (pageNumber: number) => void;
}

export function PdfPage({
  doc,
  pageNumber,
  scale = 1.0,
  onVisible,
}: PdfPageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { promise: Promise<unknown>; cancel: () => void } | null = null;

    setRendered(false);

    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const textLayerDiv = textLayerRef.current;
        if (!canvas || !textLayerDiv) return;

        const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
        renderTask = page.render({
          canvasContext: ctx,
          viewport,
          transform,
        });

        textLayerDiv.replaceChildren();
        textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
        textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;
        textLayerDiv.style.setProperty("--scale-factor", String(viewport.scale));

        const textContent = await page.getTextContent();
        if (cancelled) return;

        const textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });

        await Promise.all([renderTask.promise, textLayer.render()]);
        if (!cancelled) {
          setRendered(true);
        }
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          err.name === "RenderingCancelledException"
        ) {
          return;
        }
        if (!cancelled) {
          console.error(`Page ${pageNumber} render error:`, err);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore error during cancellation
        }
      }
    };
  }, [doc, pageNumber, scale]);

  useEffect(() => {
    if (!onVisible) return;
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    // "In view" means the page crosses the midline of the column it scrolls
    // in. A ratio threshold cannot express that: a 1.25x Letter page is ~990px
    // tall and the export column can be 50vh, so `intersectionRatio >= 0.5`
    // is unreachable and the indicator sticks on page 1 — while threshold 0
    // flips it the moment the next page's top edge peeks in (#1091 review).
    // Collapsing the scroll parent's box to its midline gives exactly one
    // page at a time, at any page height.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onVisible(pageNumber);
        }
      },
      { root: scrollParent(el), rootMargin: "-50% 0px -50% 0px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [pageNumber, onVisible]);

  return (
    <div
      ref={containerRef}
      data-page-number={pageNumber}
      aria-label={`Page ${pageNumber}`}
      className="pdf-preview-page relative mx-auto rounded border border-border-light bg-surface-paper shadow-sm overflow-hidden"
    >
      <canvas ref={canvasRef} className="block w-full h-auto" />
      <div ref={textLayerRef} className="textLayer" />
      {!rendered && (
        <div className="absolute inset-0 aspect-[612/792] animate-pulse bg-surface-subtle" />
      )}
    </div>
  );
}

/** Nearest ancestor that scrolls vertically, or null (the viewport). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}
