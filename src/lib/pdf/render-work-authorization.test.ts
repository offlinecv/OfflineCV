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

import { describe, expect, it, beforeAll } from "vitest";
import { renderAtsResumePdf, findExportGlyphLosses } from "./render-ats-pdf.ts";
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

describe("renderAtsResumePdf — work authorization on the contact line (#792)", () => {
  let stated: PdfDrawnLine[];
  let silent: PdfDrawnLine[];
  let urls: string[];
  let glyphLossSites: string[];

  beforeAll(async () => {
    const bytes = await renderAtsResumePdf(MODEL);
    stated = await extractPdfDrawnLines(bytes);
    silent = await extractPdfDrawnLines(await renderAtsResumePdf(SILENT_MODEL));
    urls = await linkAnnotationUrls(bytes);
    glyphLossSites = (
      await findExportGlyphLosses({
        ...MODEL,
        // `✓` (U+2713) has no WinAnsi code point; an em dash does, which is why
        // the sample below is not simply punctuation-heavy.
        contact: { ...MODEL.contact, workAuthorization: "US Citizen ✓" },
      })
    ).map((l) => l.where);
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
    // REPORTED, not silently rewritten to `?`. `findExportGlyphLosses` returns
    // an empty list when the embedded font loads; under Node it does not, which
    // is the fallback path this audit exists to measure.
    expect(glyphLossSites).toContain("Work authorization");
  });
});
