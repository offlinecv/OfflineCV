// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Shared test helper for render-ats-pdf's test files (render-ats-pdf.test.ts,
 * render-ats-pdf.fonts.test.ts) — NOT itself a `*.test.ts` file, so it isn't
 * picked up as a test suite.
 */

/** Extract all selectable text from PDF bytes using pdfjs-dist. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items
      .map((i) => ("str" in i ? (i as { str: string }).str : ""))
      .join(" ");
    text += " ";
  }
  return text;
}
