// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { useEffect, useRef, useState } from "react";
import { getDocument } from "pdfjs-dist";

interface PdfPreviewProps {
  /** PDF bytes. A new ArrayBuffer triggers a re-render. */
  bytes: ArrayBuffer;
  /** Render only the first N pages. Defaults to 2. */
  maxPages?: number;
}

export function PdfPreview({ bytes, maxPages = 2 }: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    container.replaceChildren();
    setError(null);

    (async () => {
      try {
        // pdfjs mutates the input buffer; pass a copy so the parent's
        // ArrayBuffer remains usable for the heuristics extract pass.
        const doc = await getDocument({
          data: new Uint8Array(bytes.slice(0)),
        }).promise;
        const pageCount = Math.min(doc.numPages, maxPages);
        for (let n = 1; n <= pageCount; n++) {
          if (cancelled) return;
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: 1.25 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className =
            "w-full rounded border border-border-light";
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          container.appendChild(canvas);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bytes, maxPages]);

  return (
    <div className="flex flex-col gap-2" ref={containerRef}>
      {error && (
        <p className="text-xs text-feedback-error-text">
          Preview failed: {error}
        </p>
      )}
    </div>
  );
}
