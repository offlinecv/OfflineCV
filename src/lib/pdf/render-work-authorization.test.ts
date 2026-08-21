// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * #792 — the work-authorization statement on the exported contact line.
 *
 * Three properties, each of which would be a silent defect if it broke:
 *   1. It rides the EXISTING contact line, after location and before the links,
 *      costing the header no extra row. That is the whole reason the field is
 *      viable on a dense one-page résumé.
 *   2. It receives no clickable link annotation. It is a sentence, not a URL,
 *      and an overlay pointing at `https://US Citizen` would ship a broken link
 *      in a document the user sends to employers.
 *   3. It is covered by the export's glyph-loss audit, so a statement that
 *      degrades under the Helvetica/WinAnsi fallback is reported rather than
 *      silently rewritten.
 *
 * Every render + pdfjs read happens ONCE, in `beforeAll` with its own timeout:
 * a first `getDocument` pays the pdfjs cold start, which overruns the 5s
 * per-test default when the suite runs under load.
 */

import { describe, expect, it, beforeAll, vi } from "vitest";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";
import {
  extractPdfDrawnLines,
  type PdfDrawnLine,
} from "./render-ats-pdf.test-utils.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";

const MODEL: AtsResumeModel = {
  contact: {
    name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    workAuthorization: "US Citizen",
    links: ["linkedin.com/in/jane"],
    linkHrefs: ["https://linkedin.com/in/jane"],
  },
  sections: [
    {
      heading: "Experience",
      entries: [
        { headerLine: "Senior PM", subLine: "Acme · Chicago, IL", bullets: ["Shipped it"] },
      ],
    },
  ],
};

/** The same model with nothing to state — the control for "adds no new line". */
const SILENT_MODEL: AtsResumeModel = {
  ...MODEL,
  contact: { ...MODEL.contact, workAuthorization: undefined },
};

async function linkAnnotationUrls(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const urls: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    for (const a of await (await doc.getPage(p)).getAnnotations()) {
      const ann = a as { subtype?: string; url?: string; unsafeUrl?: string };
      if (ann.subtype === "Link") urls.push(ann.url ?? ann.unsafeUrl ?? "");
    }
  }
  return urls;
}

/**
 * The `where` labels {@link findExportGlyphLosses} reports for a work-authorization
 * statement carrying a non-WinAnsi code point, measured ON THE FALLBACK PATH.
 *
 * The audit answers "what would the Helvetica/WinAnsi fallback cost this user",
 * and returns an empty list whenever the embedded font loads — so it can only be
 * exercised with the font load FAILING. This used to come for free: Node could
 * not resolve the renderer's Vite `?url` font specifier, so every test run took
 * the fallback by accident. The suite now serves the real Liberation Sans bytes (see
 * `src/test-setup.ts`), which is what makes the layout assertions above true of
 * the actual download — and which means this audit has to ask for the fallback
 * explicitly rather than inherit it.
 *
 * A fresh module registry is required, not just a failing `fetch`: `loadBodyFontBytes`
 * memoizes SUCCESS for the life of the module, and the renders above have already
 * populated that memo, so a stub installed afterwards would never be consulted.
 */
async function workAuthGlyphLossSites(): Promise<string[]> {
  vi.resetModules();
  vi.stubGlobal("fetch", async () => {
    throw new Error("network unavailable (simulated)");
  });
  try {
    const { findExportGlyphLosses: audit } = await import("./render-ats-pdf.ts");
    const losses = await audit({
      ...MODEL,
      // `✓` (U+2713) has no WinAnsi code point; an em dash does, which is why
      // the sample is not simply punctuation-heavy.
      contact: { ...MODEL.contact, workAuthorization: "US Citizen ✓" },
    });
    return losses.map((l) => l.where);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("renderAtsResumePdf — work authorization on the contact line (#792)", () => {
  let stated: PdfDrawnLine[];
  let silent: PdfDrawnLine[];
  let urls: string[];
  let glyphLossSites: string[];

  beforeAll(async () => {
    const { bytes } = await renderAtsResumePdf(MODEL);
    stated = await extractPdfDrawnLines(bytes);
    silent = await extractPdfDrawnLines((await renderAtsResumePdf(SILENT_MODEL)).bytes);
    urls = await linkAnnotationUrls(bytes);
    glyphLossSites = await workAuthGlyphLossSites();
  }, 60_000);

  const contactLine = (): string => {
    const line = stated.find((l) => l.text.includes("jane@example.com"));
    expect(line, "no contact line was drawn").toBeDefined();
    return line!.text;
  };

  it("draws it after location and before the links, on the same line", () => {
    const text = contactLine();
    expect(text).toContain("US Citizen");
    expect(text.indexOf("Chicago, IL")).toBeLessThan(text.indexOf("US Citizen"));
    expect(text.indexOf("US Citizen")).toBeLessThan(
      text.indexOf("linkedin.com/in/jane"),
    );
  });

  it("adds no new header line", () => {
    expect(stated.length).toBe(silent.length);
  });

  it("gets no link annotation and no scheme-stripping", () => {
    // The real links are still clickable — this is not a "nothing is linked" pass.
    expect(urls).toContain("mailto:jane@example.com");
    expect(urls).toContain("https://linkedin.com/in/jane");
    // …and nothing points at the statement.
    for (const url of urls) expect(url).not.toMatch(/citizen/i);
    // Drawn verbatim, not put through the link display formatter.
    expect(contactLine()).toContain("US Citizen");
  });

  it("is covered by the export glyph-loss audit", () => {
    // A statement carrying a code point the WinAnsi fallback cannot draw must be
    // REPORTED, not silently rewritten to `?`. Measured with the font load forced
    // to fail — see `workAuthGlyphLossSites` for why that has to be explicit.
    expect(glyphLossSites).toContain("Work authorization");
  });
});
