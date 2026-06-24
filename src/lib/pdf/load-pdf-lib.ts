// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * load-pdf-lib — dynamic-import-and-cache for `pdf-lib`.
 *
 * pdf-lib is only needed when the user clicks "Download PDF", so we keep it out
 * of the entry chunk by dynamic-importing it on first use (mirroring the
 * dynamic-import convention the heuristics cascade uses for its tiers). The
 * import promise is cached at module scope so repeated downloads reuse the same
 * loaded module.
 *
 * We deliberately load ONLY the parts we use — `PDFDocument`, `StandardFonts`,
 * `rgb` — and NO fontkit / custom-font machinery, so the exporter can only ever
 * use the 14 built-in PDF fonts. That is what guarantees zero network egress
 * (no font fetch) and the most ATS-safe output.
 */

type PdfLib = typeof import("pdf-lib");

export interface PdfLibParts {
  PDFDocument: PdfLib["PDFDocument"];
  StandardFonts: PdfLib["StandardFonts"];
  rgb: PdfLib["rgb"];
}

let cached: Promise<PdfLibParts> | null = null;

/** Load pdf-lib once and return the small subset the exporter needs. */
export function loadPdfLibOnce(): Promise<PdfLibParts> {
  if (!cached) {
    cached = import("pdf-lib").then(({ PDFDocument, StandardFonts, rgb }) => ({
      PDFDocument,
      StandardFonts,
      rgb,
    }));
  }
  return cached;
}
