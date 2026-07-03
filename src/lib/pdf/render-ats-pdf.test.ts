// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";
import { renderAtsResumePdf, toWinAnsi } from "./render-ats-pdf.ts";
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

  // #295 — drawText must never throw on non-WinAnsi glyphs parsed résumé text
  // routinely contains (arrows, unicode hyphens/dashes, smart quotes, bullets,
  // NBSP, ligatures, emoji, CJK).
  describe("non-WinAnsi glyph safety (#295)", () => {
    const glyphModel = (text: string): AtsResumeModel => ({
      contact: { name: "Jane Candidate", links: [] },
      summary: text,
      sections: [
        {
          heading: "Experience",
          entries: [
            {
              headerLine: text,
              subLine: text,
              bullets: [text],
            },
          ],
        },
      ],
    });

    const crashingGlyphs: Array<[string, string]> = [
      ["rightwards arrow (U+2192)", "Migrated auth → OAuth"],
      ["Unicode hyphen (U+2010)", "co‐founder of the initiative"],
      ["leftwards arrow (U+2190)", "Rolled back v2 ← v1"],
      ["smart quotes", "Shipped the “v2” engine, called it ‘Atlas’"],
      ["NBSP", "Chicago, IL"],
      ["ligatures", "ﬁnance ﬂow efﬁciency"],
      ["ellipsis", "Led a team of engineers…"],
      ["emoji / astral plane", "Shipped it 🚀 on time"],
      ["CJK", "领导团队完成项目"],
    ];

    it.each(crashingGlyphs)("does not throw on %s", async (_label, text) => {
      await expect(renderAtsResumePdf(glyphModel(text))).resolves.toBeInstanceOf(
        Uint8Array,
      );
    });

    // #298 review — a section heading is drawn with `uppercase: true`, and
    // `.toUpperCase()` can map a WinAnsi-native lowercase glyph to one with NO
    // WinAnsi representation (µ U+00B5 → Μ U+039C Greek Capital Mu). Sanitizing
    // BEFORE the case transform let that Μ reach pdf-lib and throw "WinAnsi cannot
    // encode Μ". Headings come from verbatim résumé section-heading text, so this
    // must never throw. Sanitize is now the LAST step (after toUpperCase).
    const headingModel = (heading: string): AtsResumeModel => ({
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        { heading, entries: [{ headerLine: "Role", subLine: "Co", bullets: ["x"] }] },
      ],
    });

    const caseExpandingHeadings: Array<[string, string]> = [
      ["µ MICRO SIGN → Greek Μ", "µ-services architecture"],
      ["ß sharp-s → SS", "Groß­projekte & Straße"],
      ["ﬁ ligature → FI", "ﬁnance ﬂow"],
      ["Turkish dotless-i expander", "i̇stanbul ﬁeld work"],
    ];

    it.each(caseExpandingHeadings)(
      "does not throw on an uppercased heading with %s",
      async (_label, heading) => {
        await expect(
          renderAtsResumePdf(headingModel(heading)),
        ).resolves.toBeInstanceOf(Uint8Array);
      },
    );

    it("sanitizes AFTER uppercasing so a case-expanded glyph can't reach the encoder", () => {
      // µ → Μ (Greek, no WinAnsi) must degrade to "?", never survive to drawText.
      expect(toWinAnsi("µ".toUpperCase())).toBe("?");
      // ß → SS and ﬁ → FI are both encodable once uppercased-then-sanitized.
      expect(toWinAnsi("straße".toUpperCase())).toBe("STRASSE");
      expect(toWinAnsi("ﬁnance".toUpperCase())).toBe("FINANCE");
    });

    it("fuzzes a wide range of code points without throwing", async () => {
      // Sample code points across many Unicode blocks (Latin-1, general
      // punctuation, arrows, CJK, emoji, control chars) to make sure no
      // single glyph anywhere reaches pdf-lib's encoder unsanitized.
      const codePoints = [
        0x09, 0x0a, 0x20, 0x7e, 0x7f, 0x9f, 0xa0, 0xff, 0x100, 0x2010, 0x2013,
        0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x2190, 0x2192,
        0x2600, 0x4e2d, 0xfb01, 0x1f680,
      ];
      const text = codePoints.map((cp) => String.fromCodePoint(cp)).join(" X ");
      await expect(renderAtsResumePdf(glyphModel(text))).resolves.toBeInstanceOf(
        Uint8Array,
      );
    });
  });

  describe("toWinAnsi", () => {
    it("transliterates glyphs with no WinAnsi representation", () => {
      expect(toWinAnsi("a → b")).toBe("a -> b");
      expect(toWinAnsi("co‐founder")).toBe("co-founder");
      expect(toWinAnsi("a b")).toBe("a b");
      expect(toWinAnsi("ﬁnance")).toBe("finance");
    });

    it("passes ASCII, Latin-1, and native WinAnsi-upper-range glyphs through unchanged", () => {
      expect(toWinAnsi("Jane Candidate")).toBe("Jane Candidate");
      expect(toWinAnsi("café")).toBe("café");
      // en dash, em dash, curly quotes, bullet, ellipsis are all valid
      // WinAnsi (cp1252 0x80-0x9F) -- must round-trip unchanged (#284).
      expect(toWinAnsi("2020 – 2024")).toBe("2020 – 2024");
      expect(toWinAnsi("scaling — infra")).toBe("scaling — infra");
      expect(toWinAnsi("“quoted”")).toBe("“quoted”");
      expect(toWinAnsi("‘quoted’")).toBe("‘quoted’");
      expect(toWinAnsi("• item")).toBe("• item");
      expect(toWinAnsi("done…")).toBe("done…");
    });

    it("replaces unmappable code points with '?' instead of throwing", () => {
      expect(toWinAnsi("🚀")).toBe("?");
      expect(toWinAnsi("中文")).toBe("??");
    });

    it("handles empty and whitespace-only input", () => {
      expect(toWinAnsi("")).toBe("");
      expect(toWinAnsi("   ")).toBe("   ");
    });
  });
});
