// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared test helpers for render-ats-pdf's test files (render-ats-pdf.test.ts,
 * render-ats-pdf.fonts.test.ts, export-layout-contract.test.ts) — NOT itself a
 * `*.test.ts` file, so it isn't picked up as a test suite.
 */

/** One drawn text line: the page it landed on (1-based) and its joined text. */
export interface PdfDrawnLine {
  page: number;
  text: string;
}

/**
 * Extract the drawn text LINE by LINE, top-to-bottom within each page and pages
 * in order, each line tagged with its 1-based page number. Lines are recovered by
 * grouping text items on a shared baseline `y` (the renderer draws every item of
 * one line at the same `y`) and joining them left-to-right.
 *
 * Unlike {@link extractPdfText}, this preserves the two things a pagination
 * contract is about: which page a line landed on, and which line follows which
 * (#629).
 */
export async function extractPdfDrawnLines(
  bytes: Uint8Array,
): Promise<PdfDrawnLine[]> {
  const pdfjs = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const out: PdfDrawnLine[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<string, Array<{ x: number; y: number; str: string }>>();
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const item = raw as { str: string; transform: number[] };
      if (item.str.trim() === "") continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const key = y.toFixed(1);
      const row = rows.get(key);
      if (row) row.push({ x, y, str: item.str });
      else rows.set(key, [{ x, y, str: item.str }]);
    }
    const ordered = [...rows.values()].sort((a, b) => b[0].y - a[0].y);
    for (const row of ordered) {
      out.push({
        page: p,
        text: row
          .sort((a, b) => a.x - b.x)
          .map((i) => i.str)
          .join(" "),
      });
    }
  }
  return out;
}

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
