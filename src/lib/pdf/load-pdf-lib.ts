// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * load-pdf-lib — dynamic-import-and-cache for `pdf-lib` (+ `@pdf-lib/fontkit`).
 *
 * pdf-lib is only needed when the user clicks "Download PDF", so we keep it out
 * of the entry chunk by dynamic-importing it on first use (mirroring the
 * dynamic-import convention the heuristics cascade uses for its tiers). The
 * import promise is cached at module scope so repeated downloads reuse the same
 * loaded module.
 *
 * We load `PDFDocument`, `StandardFonts`, `rgb` — the pdf-lib core the
 * exporter always needs — plus `fontkit`, the custom-font engine pdf-lib
 * requires to embed a TrueType font (Poppins, #314) instead of relying solely
 * on the 14 built-in Helvetica-family fonts. `fontkit` ships no usable `.d.ts`
 * default-export shape (`export as namespace fontkit`), so it's typed
 * `unknown` here and cast at the one call site that hands it to
 * `doc.registerFontkit()` (render-ats-pdf.ts) — this keeps the untyped surface
 * to a single line rather than threading `any` through this module. Both
 * fontkit and the Poppins TTF bytes it embeds are dynamic-imported / fetched
 * lazily (see render-ats-pdf.ts), so the entry chunk does not grow.
 */

type PdfLib = typeof import("pdf-lib");

export interface PdfLibParts {
  PDFDocument: PdfLib["PDFDocument"];
  StandardFonts: PdfLib["StandardFonts"];
  rgb: PdfLib["rgb"];
  /** Literal-string constructor — needed to build the `/URI` value of a Link
   *  annotation's action (`context.obj` coerces a JS string to a `/Name`, not a
   *  string, so the URI must be an explicit `PDFString`). See #425 (clickable
   *  link annotations in render-ats-pdf.ts). */
  PDFString: PdfLib["PDFString"];
  fontkit: unknown;
}

let cached: Promise<PdfLibParts> | null = null;

/** Load pdf-lib (+ fontkit) once and return the subset the exporter needs. */
export function loadPdfLibOnce(): Promise<PdfLibParts> {
  if (!cached) {
    cached = Promise.all([
      import("pdf-lib"),
      import("@pdf-lib/fontkit"),
    ]).then(([{ PDFDocument, StandardFonts, rgb, PDFString }, fontkitModule]) => ({
      PDFDocument,
      StandardFonts,
      rgb,
      PDFString,
      fontkit: fontkitModule.default,
    }));
  }
  return cached;
}
