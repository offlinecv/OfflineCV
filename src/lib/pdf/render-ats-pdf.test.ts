// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";

const MODEL: AtsResumeModel = {
  contact: {
    name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    links: ["linkedin.com/in/jane"],
  },
  summary: "Product leader with a decade of B2B SaaS experience.",
  sections: [
    {
      heading: "Experience",
      entries: [
        {
          headerLine: "Senior PM · Acme",
          subLine: "2020 – 2024",
          bullets: [
            "Led migration of the legacy auth system to OAuth, cutting login latency by 40 percent across the platform",
            "Drove 30% revenue growth across the platform over four quarters",
          ],
        },
      ],
    },
    {
      heading: "Skills",
      entries: [{ headerLine: "TypeScript · Product Strategy · SQL", bullets: [] }],
    },
  ],
};

/** Extract all text from PDF bytes using pdfjs-dist (proves selectable text). */
async function extractText(bytes: Uint8Array): Promise<string> {
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

describe("renderAtsResumePdf", () => {
  it("returns a non-trivial PDF with the %PDF magic header", async () => {
    const bytes = await renderAtsResumePdf(MODEL);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(500);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("produces selectable, searchable text (AC#3) for name + headings", async () => {
    const bytes = await renderAtsResumePdf(MODEL);
    const text = await extractText(bytes);
    expect(text).toContain("Jane Candidate");
    expect(text).toMatch(/EXPERIENCE/i);
    expect(text).toMatch(/SKILLS/i);
    expect(text).toContain("Senior PM");
    expect(text).toContain("OAuth");
  });

  it("paginates: a long résumé spans more than one page", async () => {
    const manyEntries = Array.from({ length: 40 }, (_, i) => ({
      headerLine: `Role ${i} · Company ${i}`,
      subLine: "2018 – 2020",
      bullets: [
        "Built and shipped a substantial feature that materially moved a key business metric for the team",
        "Partnered cross-functionally to deliver an initiative that improved customer outcomes meaningfully",
      ],
    }));
    const bigModel: AtsResumeModel = {
      contact: { name: "Jane Candidate", links: [] },
      sections: [{ heading: "Experience", entries: manyEntries }],
    };
    const bytes = await renderAtsResumePdf(bigModel);
    const pdfjs = await import("pdfjs-dist");
    const doc = await pdfjs.getDocument({
      data: bytes.slice(),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;
    expect(doc.numPages).toBeGreaterThan(1);
  });
});
