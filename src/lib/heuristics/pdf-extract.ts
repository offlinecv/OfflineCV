// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Tier 0 — PDF extraction with positional data.
 *
 * Thin adapter over `pdfjs-dist` (declared as a peer dep so consumers can
 * dynamic-import the shared copy). The dashboard already has `pdfjs-dist`
 * installed for `PdfPreview.tsx`, so the package does not ship its own.
 *
 * Output is normalized to top-origin coordinates (y grows downward) — the
 * opposite of pdfjs's bottom-origin convention — so line grouping reads
 * left-to-right, top-to-bottom without surprises.
 */

import { groupIntoLines } from "./sections.ts";
import { detectColumnBoundaries } from "./pdf-layout.ts";
import type {
  PdfExtractResult,
  PdfLinkAnnotation,
  PdfPageInfo,
  PdfTextItem,
} from "./types.ts";

/**
 * Re-assemble extraction text from positional line clusters. The raw
 * per-item concatenation produced inside the page loop relied on pdfjs's
 * `hasEOL` flag, which many PDF generators set inconsistently — bullets and
 * line breaks vanish on LaTeX/Word/macOS-Preview exports. Walking the same
 * items through `groupIntoLines` (the helper Tier 1 already uses) preserves
 * one `\n` per visual line and keeps bullet glyphs at line start so the
 * downstream bullet detector (score.ts:extractBulletsFromText) can see them.
 */
export function assembleTextFromLines(
  items: PdfTextItem[],
  boundaries?: Map<number, number>,
): string {
  if (items.length === 0) return "";
  const lines = groupIntoLines(items, boundaries);
  if (lines.length === 0) return "";
  const parts: string[] = [];
  let prevPage = lines[0].page;
  for (const line of lines) {
    if (line.page !== prevPage) {
      parts.push("");
      prevPage = line.page;
    }
    parts.push(line.text);
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * pdfjs-dist TextItem shape. We intentionally avoid a direct type import so
 * the package is consumable even when consumers haven't installed pdfjs-dist
 * yet — the dynamic import below throws at call time if it's missing.
 */
interface PdfjsTextItem {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

/**
 * Subset of pdfjs's annotation shape we care about. The full union is large;
 * we only ever read `subtype === "Link"` entries with a URL.
 */
interface PdfjsAnnotation {
  subtype?: string;
  url?: string;
  unsafeUrl?: string;
  rect?: number[];
  // Some link annotations carry their target inside an `action` object
  // rather than top-level `url` (e.g. older PDF generators).
  action?: { url?: string };
}

interface PdfjsPage {
  getTextContent(): Promise<{ items: Array<PdfjsTextItem | { type: string }> }>;
  getAnnotations(): Promise<PdfjsAnnotation[]>;
  getViewport(params: { scale: number }): { width: number; height: number };
}

interface PdfjsDocument {
  numPages: number;
  getPage(n: number): Promise<PdfjsPage>;
}

interface PdfjsLib {
  getDocument(params: {
    data: Uint8Array | ArrayBuffer;
    useSystemFonts?: boolean;
  }): { promise: Promise<PdfjsDocument> };
  GlobalWorkerOptions: { workerSrc: string };
  version: string;
}

let cached: Promise<PdfjsLib> | null = null;

async function loadPdfjs(): Promise<PdfjsLib> {
  if (cached) return cached;
  cached = (async () => {
    // Dynamic-imported so the kernel itself ships as a small chunk and the
    // ~300KB pdfjs payload only loads on first parse. Callers are expected
    // to configure `GlobalWorkerOptions.workerSrc` once at app boot (the
    // browser bundle uses Vite's `?url` import for the worker asset). If
    // unset, pdfjs falls back to fetching from its CDN.
    const mod = (await import("pdfjs-dist")) as unknown as
      | PdfjsLib
      | { default: PdfjsLib };
    return "default" in mod ? mod.default : mod;
  })();
  return cached;
}

/** Extract positioned text items + per-page info from a PDF byte buffer. */
export async function extractFromPdfBytes(
  bytes: Uint8Array | ArrayBuffer,
): Promise<PdfExtractResult> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    useSystemFonts: true,
  }).promise;

  const items: PdfTextItem[] = [];
  const pages: PdfPageInfo[] = [];
  const linkAnnotations: PdfLinkAnnotation[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    let pageCharCount = 0;
    for (const raw of content.items) {
      if (!("str" in raw)) continue; // TextMarkedContent — skip
      const t = raw as PdfjsTextItem;
      if (!t.str) continue;
      const [a, , , d, x, yBottom] = t.transform as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      // Flip y to top-origin. Font size ≈ |d| (y-scale of the text matrix).
      const fontSize = Math.abs(d || a || t.height);
      const yTop = viewport.height - yBottom;
      items.push({
        page: pageNum,
        str: t.str,
        x,
        y: yTop,
        width: t.width,
        height: t.height,
        fontSize,
        fontName: t.fontName,
        hasEOL: !!t.hasEOL,
      });
      pageCharCount += t.str.length;
    }

    // Lift Link annotations off the page. These are the only signal that
    // recovers URLs hyperlinked behind visible words ("LinkedIn" in
    // LaTeX/Jake's-Resume templates) and the only credible signal we get
    // back from `fonts_unmappable` PDFs (Framer exports — no text but
    // valid annotations). Failures are non-fatal — annotations are a
    // bonus, never required.
    try {
      const annotations = await page.getAnnotations();
      for (const a of annotations) {
        if (a.subtype !== "Link") continue;
        const url = a.url ?? a.unsafeUrl ?? a.action?.url;
        if (!url) continue;
        const r = a.rect;
        if (!r || r.length < 4) continue;
        const rect: PdfLinkAnnotation["rect"] = [r[0], r[1], r[2], r[3]];
        // pdfjs annotation rects are bottom-origin like the text matrix.
        // Top of the annotation == viewport.height - max(y1, y2).
        const yTop = viewport.height - Math.max(r[1], r[3]);
        linkAnnotations.push({ page: pageNum, url, rect, yTop });
      }
    } catch {
      // Some malformed PDFs throw here; don't block extraction.
    }

    pages.push({
      page: pageNum,
      width: viewport.width,
      height: viewport.height,
      charCount: pageCharCount,
    });
  }

  // Detect two-column layout once, here, then thread the per-page split-x map
  // through every downstream line-grouping path (rawText below, plus markdown
  // emission and the Tier-1 parser via the cascade) so the columns are read in
  // column order instead of interleaved by a global (y, x) sort.
  const columnBoundaries = detectColumnBoundaries(items, pages);
  const text = assembleTextFromLines(items, columnBoundaries);
  const rawCharCount = pages.reduce((s, p) => s + p.charCount, 0);

  // Distinguish "no text in the source" (true scan) from "text exists but
  // pdfjs can't decode the fonts" (Framer / Affinity / some InDesign
  // exports). Real scans render to image-only PDFs with no link
  // annotations; fonts-unmappable PDFs typically retain at least the
  // portfolio/website link. This heuristic is intentionally narrow — false
  // positives are bounded to PDFs that are scanned AND happen to carry a
  // link annotation, which is rare enough that the better message is the
  // right tradeoff.
  const extractionFailureReason =
    items.length === 0 && pages.length > 0 && linkAnnotations.length > 0
      ? ("fonts_unmappable" as const)
      : undefined;

  return {
    items,
    pages,
    text,
    rawCharCount,
    linkAnnotations,
    ...(extractionFailureReason ? { extractionFailureReason } : {}),
    ...(columnBoundaries.size > 0 ? { columnBoundaries } : {}),
  };
}
