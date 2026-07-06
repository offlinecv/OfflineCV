// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * render-ats-pdf.fonts.test.ts — Poppins font-embed behavior (#314).
 *
 * Split from render-ats-pdf.test.ts because these tests need to control
 * `global.fetch` (the mechanism `loadPoppinsBytes()` uses to read the
 * bundled Poppins TTFs) and reset the module registry between cases — the
 * module-scoped `poppinsBytesPromise` cache means a rejected fetch would
 * otherwise "stick" for the rest of the file. Each case stubs `fetch`, then
 * `vi.resetModules()` + a fresh dynamic `import()` so it starts from a clean
 * cache.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPdfText } from "./render-ats-pdf.test-utils.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";

const FONTS_DIR = fileURLToPath(
  new URL("../../assets/fonts/", import.meta.url),
);
const REGULAR_BYTES = readFileSync(`${FONTS_DIR}Poppins-Regular.ttf`);
const BOLD_BYTES = readFileSync(`${FONTS_DIR}Poppins-Bold.ttf`);

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Stub `fetch` to serve the real vendored TTF bytes for any local asset URL. */
function stubFetchSucceeds() {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    // Zero-egress guard (#314 AC): the URL loadPoppinsBytes() fetches must be
    // a local/bundled asset path, never an external host or font CDN.
    expect(url).not.toMatch(/^https?:\/\//);
    expect(url.toLowerCase()).not.toContain("fonts.gstatic.com");
    const bytes = url.includes("Bold") ? BOLD_BYTES : REGULAR_BYTES;
    return { arrayBuffer: async () => toArrayBuffer(bytes) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Stub `fetch` to fail, forcing the Helvetica-fallback path. */
function stubFetchFails() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network unavailable (simulated)");
    }),
  );
}

/**
 * Inspect the produced PDF's own object graph (via pdf-lib, already a
 * dependency) for a `/FontFile2` key — the PDF-spec entry for an embedded
 * TrueType font program, which StandardFonts (Helvetica) never emit. Newer
 * pdf-lib output uses compressed cross-reference/object streams, so a raw
 * text search over the bytes is unreliable; re-parsing with `PDFDocument` and
 * walking every indirect object is the robust check.
 */
async function hasEmbeddedFontFile2(bytes: Uint8Array): Promise<boolean> {
  const { PDFDocument, PDFDict, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of("FontFile2"))) {
      return true;
    }
  }
  return false;
}

const model = (text: string): AtsResumeModel => ({
  contact: { name: "Jane Candidate", links: [] },
  summary: text,
  sections: [],
});

describe("Poppins font embed (#314)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("embeds Poppins (a /FontFile2 TrueType program is present) when the local asset fetch succeeds", async () => {
    const fetchMock = stubFetchSucceeds();
    vi.resetModules();
    const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

    const bytes = await renderAtsResumePdf(model("Poppins embed check"));
    expect(fetchMock).toHaveBeenCalled();
    await expect(hasEmbeddedFontFile2(bytes)).resolves.toBe(true);
  });

  it("falls back to Helvetica (no /FontFile2, no throw) when the font fetch fails", async () => {
    stubFetchFails();
    vi.resetModules();
    const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

    const bytes = await renderAtsResumePdf(model("fallback check"));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(500);
    await expect(hasEmbeddedFontFile2(bytes)).resolves.toBe(false);
  });

  it("renders a Latin-Extended glyph (ł) under embedded Poppins that the Helvetica fallback degrades to '?'", async () => {
    // Embedded path: Poppins' cmap covers "ł" (verified via fontkit).
    stubFetchSucceeds();
    vi.resetModules();
    const { renderAtsResumePdf: renderEmbedded } = await import(
      "./render-ats-pdf.ts"
    );
    const embeddedBytes = await renderEmbedded(model("Łukasz, Wrocław"));
    const embeddedText = await extractPdfText(embeddedBytes);
    expect(embeddedText).toContain("ł");

    // Fallback path: StandardFonts can only encode WinAnsi, so toWinAnsi()
    // degrades "ł" (no WinAnsi representation) to "?".
    stubFetchFails();
    vi.resetModules();
    const { renderAtsResumePdf: renderFallback } = await import(
      "./render-ats-pdf.ts"
    );
    const fallbackBytes = await renderFallback(model("Łukasz, Wrocław"));
    const fallbackText = await extractPdfText(fallbackBytes);
    expect(fallbackText).not.toContain("ł");
    expect(fallbackText).toContain("?");
  });
});
