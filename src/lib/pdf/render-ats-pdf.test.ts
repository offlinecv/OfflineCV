// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";
import { renderAtsResumePdf, toWinAnsi, parseBoldRuns } from "./render-ats-pdf.ts";
import {
  EMPHASIS_OPEN,
  EMPHASIS_CLOSE,
} from "./auto-bold-metrics.ts";
import { extractPdfText } from "./render-ats-pdf.test-utils.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";

/** Wrap `s` in the sentinel emphasis delimiters `parseBoldRuns` consumes. */
const emph = (s: string) => `${EMPHASIS_OPEN}${s}${EMPHASIS_CLOSE}`;

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

describe("renderAtsResumePdf", () => {
  it("returns a non-trivial PDF with the %PDF magic header", async () => {
    const bytes = await renderAtsResumePdf(MODEL);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(500);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("produces selectable, searchable text (AC#3) for name + headings", async () => {
    const bytes = await renderAtsResumePdf(MODEL);
    const text = await extractPdfText(bytes);
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

  // #307 — a header line packing 3+ " · "-joined segments (e.g. an
  // achievement's "keyword · statement · year") must WORD-WRAP, not wrap
  // atomically per segment. Atomic wrapping is reserved for the skills entry
  // (`AtsEntry.atomicSegments`), which needs whole-segment integrity to
  // re-parse correctly (#301) — every other header/entry line's middot is a
  // display joiner only, and atomic wrapping there strands the keyword/year
  // alone on their own line.
  it("word-wraps a 3-middot achievement header instead of stranding segments (#307)", async () => {
    const longStatement =
      "Issued Patent US0000000B1 for a distributed caching mechanism that " +
      "reduced average request latency across the platform substantially";
    const model: AtsResumeModel = {
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        {
          heading: "Achievements",
          entries: [
            {
              headerLine: `Patent · ${longStatement} · 2019`,
              bullets: [],
            },
          ],
        },
      ],
    };

    const bytes = await renderAtsResumePdf(model);
    const pdfjs = await import("pdfjs-dist");
    const doc = await pdfjs.getDocument({
      data: bytes.slice(),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    // Each `page.drawText()` call (one per wrapped line) becomes one text
    // item here, so this is a per-LINE view, unlike `extractText()` above
    // which joins everything into one flattened string.
    const lines = content.items
      .map((i) => ("str" in i ? (i as { str: string }).str : ""))
      .filter((s) => s.trim().length > 0);

    // The bug: atomic segment-wrapping stranded the bare keyword and bare
    // year on their own line when the header overflowed.
    expect(lines).not.toContain("Patent");
    expect(lines).not.toContain("2019");

    // The fix: word-wrap still renders the header across multiple lines (it
    // does not fit on one), but every line carries more than a lone segment.
    const headerLines = lines.filter((l) => /Patent|2019/.test(l));
    expect(headerLines.length).toBeGreaterThan(1);
    for (const line of headerLines) {
      expect(line.trim().split(/\s+/).length).toBeGreaterThan(1);
    }
    expect(headerLines.join(" ")).toContain("Patent");
    expect(headerLines.join(" ")).toContain("2019");
  });

  // #301 regression guard (Rohith review, PR #329) — the inverse of #307.
  // A "Company · Location  Dates" sub-line that overflows one line must wrap
  // ATOMICALLY (break only at the middot), never mid-location. Word-wrapping
  // inside a multi-word location re-parses it into fragmented location tokens.
  // Unlike the achievement header above, the sub-line middot IS a
  // re-parse-critical boundary, so `drawEntry` opts the sub-line into
  // `atomicSegments`.
  it("keeps a multi-word location intact on an overflowing sub-line (#301)", async () => {
    const model: AtsResumeModel = {
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        {
          heading: "Experience",
          entries: [
            {
              headerLine: "Principal Engineer",
              subLine:
                "Global Interdisciplinary Research and Development Consortium " +
                "International Institute Limited · " +
                "San Francisco Bay Area  2020 – 2024",
              bullets: [],
            },
          ],
        },
      ],
    };

    const bytes = await renderAtsResumePdf(model);
    const pdfjs = await import("pdfjs-dist");
    const doc = await pdfjs.getDocument({
      data: bytes.slice(),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const lines = content.items
      .map((i) => ("str" in i ? (i as { str: string }).str : ""))
      .filter((s) => s.trim().length > 0);

    // The sub-line overflows: it wraps across more than one line.
    const subLines = lines.filter((l) => /Consortium|Francisco/.test(l));
    expect(subLines.length).toBeGreaterThan(1);
    // The bug: word-wrapping breaks the location, so no single line carries the
    // whole "San Francisco Bay Area". The fix keeps that segment atomic.
    expect(subLines.some((l) => l.includes("San Francisco Bay Area"))).toBe(
      true,
    );
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

describe("parseBoldRuns (#425)", () => {
  it("returns a single regular run for text with no markers", () => {
    expect(parseBoldRuns("plain bullet text")).toEqual([
      { text: "plain bullet text", bold: false },
    ]);
  });

  it("splits a mid-string metric into regular / bold / regular runs", () => {
    expect(
      parseBoldRuns(`Grew revenue ${emph("40%")} year over year`),
    ).toEqual([
      { text: "Grew revenue ", bold: false },
      { text: "40%", bold: true },
      { text: " year over year", bold: false },
    ]);
  });

  it("handles multiple bold spans and a leading bold run", () => {
    expect(
      parseBoldRuns(`${emph("$2M")} raised and ${emph("18 engineers")} hired`),
    ).toEqual([
      { text: "$2M", bold: true },
      { text: " raised and ", bold: false },
      { text: "18 engineers", bold: true },
      { text: " hired", bold: false },
    ]);
  });

  it("strips the sentinels — the joined run text is byte-identical to the clean bullet", () => {
    const runs = parseBoldRuns(
      `Cut latency ${emph("10%")} and grew ${emph("1.5x")}`,
    );
    for (const run of runs) {
      expect(run.text).not.toContain(EMPHASIS_OPEN);
      expect(run.text).not.toContain(EMPHASIS_CLOSE);
    }
    expect(runs.map((r) => r.text).join("")).toBe(
      "Cut latency 10% and grew 1.5x",
    );
  });

  it("treats literal `**` as inert text — draws it verbatim (#284)", () => {
    // Literal asterisks are NOT the marker, so they survive as ordinary glyphs.
    const runs = parseBoldRuns("Wrote **important** design docs");
    expect(runs).toEqual([
      { text: "Wrote **important** design docs", bold: false },
    ]);
    expect(runs.map((r) => r.text).join("")).toBe(
      "Wrote **important** design docs",
    );
  });
});

describe("#425 render — headline + metric bold", () => {
  it("renders a professional headline (regular weight) under the name", async () => {
    const model: AtsResumeModel = {
      contact: {
        name: "Jane Candidate",
        headline: "Engineering Lead",
        links: [],
      },
      sections: [],
    };
    const text = await extractPdfText(await renderAtsResumePdf(model));
    expect(text).toContain("Jane Candidate");
    expect(text).toContain("Engineering Lead");
  });

  it("draws a metric bullet with NO '**' markers leaking into the text", async () => {
    const model: AtsResumeModel = {
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        {
          heading: "Experience",
          entries: [
            {
              headerLine: "Senior PM · Acme",
              subLine: "2020 – 2024",
              bullets: ["Drove 40% revenue growth and onboarded 50K users"],
            },
          ],
        },
      ],
    };
    const text = await extractPdfText(await renderAtsResumePdf(model));
    // The emphasis markers are stripped before drawing, so no `*` reaches the
    // page — the visible text is the un-emphasized bullet (round-trip guard).
    // `extractPdfText` emits each drawn run as a separate token, so assert the
    // metric words are all present (whitespace between them is util-normalized).
    expect(text).not.toContain("*");
    for (const token of ["Drove", "40%", "revenue", "50K", "users"])
      expect(text).toContain(token);
  });

  it("draws an emphasized achievement header (type bold) with no sentinel leakage", async () => {
    // A header carrying the PUA emphasis sentinels routes to the run-aware
    // draw (`drawHeaderRuns`); the sentinels are stripped, so the visible text
    // is the plain "Patent · … · 2019" header (no PUA glyphs reach the page).
    const model: AtsResumeModel = {
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        {
          heading: "Achievements",
          kind: "achievements",
          entries: [
            {
              headerLine: `${emph("Patent")} · Issued US10275736B1; bulk catalog editor · 2019`,
              headerBold: false,
              bullets: [],
            },
          ],
        },
      ],
    };
    const text = await extractPdfText(await renderAtsResumePdf(model));
    expect(text).not.toContain(EMPHASIS_OPEN);
    expect(text).not.toContain(EMPHASIS_CLOSE);
    for (const token of ["Patent", "US10275736B1", "editor", "2019"])
      expect(text).toContain(token);
  });
});
