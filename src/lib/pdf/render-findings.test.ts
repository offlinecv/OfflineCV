// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Export findings — the pre-download validation pass (#621).
 *
 * Two families, exercised through the REAL renderer rather than the finding
 * helpers alone, because both are claims about the render: the glyph pass is
 * only meaningful against the font that was actually embedded, and a page break
 * only exists once something has been paginated.
 *
 * The font path is chosen the same way `render-ats-pdf.fonts.test.ts` chooses
 * it — by stubbing `fetch` and re-importing the module — so the embedded-Poppins
 * case (this issue's target: a character the embedded font has no glyph for) is
 * tested on the embedded path and not by accident on the Helvetica fallback.
 *
 * PII-free: every model here is synthetic.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtsEntry, AtsResumeModel } from "./ats-resume-model.ts";
import { findGlyphFindings, type RenderFinding } from "./render-findings.ts";
import { EMPHASIS_OPEN, EMPHASIS_CLOSE } from "./auto-bold-metrics.ts";

const FONTS_DIR = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
const REGULAR_BYTES = readFileSync(`${FONTS_DIR}Poppins-Regular.ttf`);
const BOLD_BYTES = readFileSync(`${FONTS_DIR}Poppins-Bold.ttf`);

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Serve the real vendored TTFs, so the render takes the EMBEDDED path. */
function stubFetchSucceeds() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () =>
        toArrayBuffer(String(input).includes("Bold") ? BOLD_BYTES : REGULAR_BYTES),
    })) as unknown as typeof fetch,
  );
}

/** Load the renderer with a clean module registry, so the memoized font promise
 *  from a previous case cannot leak the wrong font path into this one. */
async function loadRenderer() {
  vi.resetModules();
  return import("./render-ats-pdf.ts");
}

async function renderFindings(model: AtsResumeModel): Promise<RenderFinding[]> {
  const { renderAtsResumePdf } = await loadRenderer();
  return (await renderAtsResumePdf(model)).findings;
}

const CLEAN: AtsResumeModel = {
  contact: {
    name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    links: ["linkedin.com/in/jane"],
  },
  summary: "Shipped things. Cut deploy time from 42 minutes to 9.",
  sections: [
    {
      heading: "Experience",
      entries: [
        {
          headerLine: "Staff Engineer",
          subLine: "Acme · Springfield, IL",
          subLineDate: "2021 — Present",
          bullets: ["Drove the platform migration end to end."],
        },
      ],
    },
  ],
};

describe("export findings — glyph coverage (#621)", { timeout: 30000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reports nothing for a clean résumé on the embedded font path", async () => {
    // The load-bearing negative. Most résumés are ASCII, the embedded font draws
    // them perfectly, and a report that fired here would put permanent warning
    // chrome on every download.
    stubFetchSucceeds();
    await expect(renderFindings(CLEAN)).resolves.toEqual([]);
  });

  it("does not report a Latin-Extended glyph the embedded font DOES cover", async () => {
    // Poppins covers ś/ł. Reporting them would be the #664 false positive
    // wearing a different hat — and it is the whole reason the embedded path
    // exists.
    stubFetchSucceeds();
    await expect(
      renderFindings({
        contact: { name: "Anna Wiśniewska", links: [] },
        summary: "Worked in Wrocław with Łukasz.",
        sections: [],
      }),
    ).resolves.toEqual([]);
  });

  it("names the character AND its source field for a glyph the font lacks", async () => {
    // Poppins has no glyph for ★ (verified in render-ats-pdf.fonts.test.ts), so
    // the export draws "?" — the exact silent degradation #621 exists to stop
    // being silent.
    stubFetchSucceeds();
    const findings = await renderFindings({
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        {
          heading: "Work History",
          entries: [
            {
              headerLine: "Staff Engineer · Acme",
              bullets: ["Ran the review board", "Migrated ★ to the new stack"],
            },
          ],
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("glyph-degraded");
    expect(findings[0].severity).toBe("warning");
    // The character itself — "a glyph was dropped" is not actionable.
    expect(findings[0].detail).toContain("★");
    expect(findings[0].detail).toContain('"?"');
    // …and where it is: section, entry, and WHICH bullet. The clean first bullet
    // must not be blamed for the second one's character.
    expect(findings[0].sourceField).toBe(
      "Work History → Staff Engineer · Acme → bullet 2",
    );
  });

  it("locates a glyph loss in a named contact field", async () => {
    stubFetchSucceeds();
    const findings = await renderFindings({
      contact: { name: "Jane ✓ Candidate", links: [] },
      sections: [],
    });
    expect(findings.map((f) => f.sourceField)).toEqual(["Name"]);
  });

  it("indexes individual contact links", async () => {
    stubFetchSucceeds();
    const findings = await renderFindings({
      contact: {
        name: "Jane Candidate",
        links: ["linkedin.com/in/jane", "github.com/jane-★", "portfolio.com/★"],
      },
      sections: [],
    });
    expect(findings.map((f) => f.sourceField)).toEqual([
      "Links → link 2",
      "Links → link 3",
    ]);
  });

  it("reports a transliterated glyph as info, not as a warning", async () => {
    // "→" is degraded — the export draws "->" — but the meaning survives, so it
    // is worth stating and not worth alarming over. Grading every substitution
    // `warning` would make the badge meaningless on the one that destroys text.
    stubFetchSucceeds();
    const findings = await renderFindings({
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        {
          heading: "Experience",
          entries: [
            { headerLine: "Intern → Engineer · Acme", bullets: ["Did work"] },
          ],
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].detail).toContain("->");
  });

  it("collapses repeats of one character within one field to a single finding", async () => {
    // A bullet with four arrows is one thing to fix, not four.
    stubFetchSucceeds();
    const findings = await renderFindings({
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        {
          heading: "Experience",
          entries: [
            { headerLine: "Engineer · Acme", bullets: ["a ★ b ★ c ★ d ★ e"] },
          ],
        },
      ],
    });
    expect(findings).toHaveLength(1);
  });

  it("does not mistake the auto-bold sentinels for uncovered glyphs", async () => {
    // An achievement header arrives from `ats-resume-model.ts` with the
    // Private-Use-Area emphasis markers already in it. They are stripped before
    // any font sees them, so scanning text that still carries them would report
    // U+E000 as a loss on every achievement — and, on the fallback path, could
    // refuse a download over a character that is never drawn.
    stubFetchSucceeds();
    await expect(
      renderFindings({
        contact: { name: "Jane Candidate", links: [] },
        sections: [
          {
            heading: "Achievements",
            entries: [
              {
                headerLine: `${EMPHASIS_OPEN}Award${EMPHASIS_CLOSE} \u00b7 Shipped the platform \u00b7 2024`,
                headerBold: false,
                bullets: [],
              },
            ],
          },
        ],
      }),
    ).resolves.toEqual([]);
  });

  it("checks a heading through the case transform the renderer applies", async () => {
    // Headings are drawn upper-cased, and `toUpperCase()` can turn a covered
    // glyph into an uncovered one: µ (U+00B5) becomes Μ (U+039C, Greek capital
    // mu), which Poppins has no glyph for. Scanning the raw text would miss
    // exactly the loss the draw is about to produce.
    stubFetchSucceeds();
    const { renderAtsResumePdf } = await loadRenderer();
    const heading = "µ-services";
    const raw = (
      await renderAtsResumePdf({
        contact: { name: "Jane Candidate", links: [] },
        // Same text NOT in a heading: drawn as-is, and Poppins covers µ, so it
        // is the control that proves the case transform is what makes the
        // difference rather than the character itself.
        summary: heading,
        sections: [],
      })
    ).findings;
    expect(raw).toEqual([]);

    const cased = (
      await renderAtsResumePdf({
        contact: { name: "Jane Candidate", links: [] },
        sections: [
          {
            heading,
            entries: [{ headerLine: "Engineer · Acme", bullets: ["Did work"] }],
          },
        ],
      })
    ).findings;
    expect(cased.map((f) => f.sourceField)).toEqual([heading]);
    // The reported character is what the user typed (µ, U+00B5), not what the
    // case transform drew (Μ, U+039C) — the user can search their résumé for
    // the former; the latter is provably absent from their input.
    expect(cased[0]!.detail).toContain('"µ" (U+00B5)');
    expect(cased[0]!.detail).not.toContain("U+039C");
  });
});

// ── What counts as a degradation at all ─────────────────────────────────────
//
// Driven through `findGlyphFindings` with an INJECTED sanitizer rather than a
// render, because the rule under test is "which substitutions are worth
// reporting" and a real font either covers a probe character or does not — which
// would make each case pass for whichever reason the font happened to supply.

describe("export findings — invisible degradations are not reported", () => {
  const model = (name: string): AtsResumeModel => ({
    contact: { name, links: [] },
    sections: [],
  });

  /** Maps exactly the characters named, passes everything else through. */
  const mapping = (table: Record<string, string>) => (text: string) =>
    [...text].map((ch) => table[ch] ?? ch).join("");

  it("ignores a mark dropped outright", () => {
    // A zero-width space or a stray control character is removed by both
    // sanitizers. Nothing the user can see changes, so a finding is noise.
    expect(
      findGlyphFindings(model("Jane\u200b Doe"), mapping({ "\u200b": "" })),
    ).toEqual([]);
  });

  it("ignores an exotic space normalised to an ordinary one", () => {
    expect(
      findGlyphFindings(model("Jane\u2009Doe"), mapping({ "\u2009": " " })),
    ).toEqual([]);
  });

  it("DOES report a visible substitution", () => {
    // The control for both cases above: the rule is "invisible", not "any
    // substitution".
    const findings = findGlyphFindings(
      model("Jane ★ Doe"),
      mapping({ "★": "?" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
  });

  it("interpolates the character's code point into the detail message", () => {
    // An invisible character absent from the table (such as VS16 U+FE0F) falls
    // through to "?"; naming the code point keeps the message actionable even
    // when the character itself cannot be seen.
    const findings = findGlyphFindings(
      model("Jane\uFE0F Doe"),
      mapping({ "\uFE0F": "?" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('no glyph for "\uFE0F" (U+FE0F)');
  });
});

// ── Pagination: a page break inside a bullet (#621) ──────────────────────────
//
// Same synthesis strategy as `export-layout-contract.test.ts`: a filler entry of
// single-line bullets pushes the subject bullet down one line at a time, so some
// filler count puts the natural page break inside it. The count is FOUND by
// bisection rather than hard-coded, so the test keeps straddling the break if
// the page geometry ever changes.

/** Wraps to exactly four drawn lines under the Helvetica fallback — the shortest
 *  bullet that can legally split (2/2), and therefore the shortest one this
 *  finding can fire on. */
const FOUR_LINE_BULLET =
  "BULLETSTART partnered across engineering, product and design to land a " +
  "platform initiative that measurably improved customer outcomes BULLETTWO " +
  "and then carried the same practice into the wider organisation, writing " +
  "the runbooks BULLETTHREE and training the on-call rotation before handing " +
  "the whole programme over to its permanent owners BULLETEND";

/** Wraps to exactly three drawn lines — indivisible under #630/#631, so it must
 *  move whole and must never produce this finding. */
const THREE_LINE_BULLET =
  "BULLETSTART partnered across engineering, product and design to land a " +
  "platform initiative that measurably improved customer outcomes BULLETMID " +
  "and then carried the same practice into the wider organisation BULLETEND";

function modelWith(subject: AtsEntry, filler: number): AtsResumeModel {
  return {
    contact: { name: "Jane Candidate", links: [] },
    sections: [
      {
        heading: "Experience",
        entries: [
          {
            headerLine: "Filler Role · Filler Company, Springfield, IL",
            bullets: Array.from(
              { length: filler },
              () => "Filler bullet kept deliberately short.",
            ),
          },
          subject,
        ],
      },
    ],
  };
}

describe(
  "export findings — a page break inside a bullet (#621)",
  { timeout: 60000 },
  () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    /** Findings + which page each bullet token landed on, for one filler count. */
    async function probe(subject: AtsEntry, filler: number) {
      const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");
      const { extractPdfDrawnLines } = await import(
        "./render-ats-pdf.test-utils.ts"
      );
      const { bytes, findings } = await renderAtsResumePdf(
        modelWith(subject, filler),
      );
      const lines = await extractPdfDrawnLines(bytes);
      const pageOf = (token: string) => {
        const hit = lines.find((l) => l.text.includes(token));
        expect(hit, `expected "${token}" to be drawn`).toBeDefined();
        return hit!.page;
      };
      return { findings, pageOf };
    }

    /** Smallest filler count that pushes `token` off page 1 — monotone, because
     *  every filler bullet is exactly one line, so a bisection is exact. */
    async function boundaryN(subject: AtsEntry, token: string, max = 80) {
      expect((await probe(subject, 0)).pageOf(token)).toBe(1);
      expect((await probe(subject, max)).pageOf(token)).toBeGreaterThan(1);
      let lo = 0;
      let hi = max;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await probe(subject, mid)).pageOf(token) > 1) hi = mid;
        else lo = mid;
      }
      return hi;
    }

    const fourLineSubject: AtsEntry = {
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: ["ALPHABULLET short first bullet.", FOUR_LINE_BULLET],
    };

    it("names the entry when a 4+ line bullet falls across a page break", async () => {
      const n = await boundaryN(fourLineSubject, "BULLETSTART");
      // Non-vacuity: at the boundary the bullet really IS split — its first and
      // last drawn lines land on different pages. Without this the assertion
      // below could pass on a render that never split anything.
      let sawSplit = false;
      for (const filler of [n - 2, n - 1, n, n + 1]) {
        const { findings, pageOf } = await probe(fourLineSubject, filler);
        const split = pageOf("BULLETSTART") !== pageOf("BULLETEND");
        const paginationFindings = findings.filter(
          (f) => f.kind === "bullet-page-break",
        );
        if (!split) {
          expect(
            paginationFindings,
            `filler=${filler}: reported a split that did not happen`,
          ).toEqual([]);
          continue;
        }
        sawSplit = true;
        expect(paginationFindings).toHaveLength(1);
        expect(paginationFindings[0].severity).toBe("warning");
        // Names the entry — and which of its bullets.
        expect(paginationFindings[0].sourceField).toBe(
          "Experience → SUBJECTROLE · Subject Company, Springfield, IL → bullet 2",
        );
        expect(paginationFindings[0].detail).toContain("4 lines");
      }
      expect(
        sawSplit,
        "no filler count in the window actually split the bullet — the test is vacuous",
      ).toBe(true);
    });

    it("reports nothing for a 3-line bullet, which #630 keeps whole", async () => {
      // The residual-case boundary. A three-line bullet has no legal split
      // position, so it moves whole and there is nothing to report — which is
      // why this finding is the 4+ line case in practice without being gated on
      // a line count.
      const subject: AtsEntry = {
        headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
        bullets: ["ALPHABULLET short first bullet.", THREE_LINE_BULLET],
      };
      const n = await boundaryN(subject, "BULLETSTART");
      for (const filler of [n - 2, n - 1, n, n + 1]) {
        const { findings, pageOf } = await probe(subject, filler);
        // Non-vacuity: the bullet really did cross the page boundary as a unit.
        expect(pageOf("BULLETEND")).toBe(pageOf("BULLETSTART"));
        expect(
          findings.filter((f) => f.kind === "bullet-page-break"),
          `filler=${filler}: reported a split on an indivisible bullet`,
        ).toEqual([]);
      }
    });

    it("reports nothing when nothing paginates", async () => {
      const { findings } = await probe(fourLineSubject, 0);
      expect(findings).toEqual([]);
    });
  },
);
