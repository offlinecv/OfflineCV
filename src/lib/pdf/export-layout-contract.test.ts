// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Export layout-contract gate (#334).
 *
 * The "Download PDF" exporter guarantees a fixed ATS layout contract:
 *   - SINGLE column, top-to-bottom (render-ats-pdf.ts draws one column).
 *   - REVERSE-CHRONOLOGICAL entries (document order, as parsed).
 *   - CANONICAL section headers — every heading the exporter emits must be a
 *     header our OWN parser re-recognizes on re-upload.
 *   - STANDARD fonts (Liberation Sans with a Helvetica fallback, both text-layer fonts).
 *
 * This test enforces the headers half: it asserts that every heading the
 * exporter can emit — the canonical fallback set, PLUS every verbatim
 * `AtsSection.heading` and the summary heading produced from real fixtures — is
 * recognized by `matchSectionHeader()`. So the export can never emit a heading
 * the parser would fail to re-open as a section on re-upload (which would break
 * the round-trip invariant). PII-free: asserts recognition of heading strings
 * (synthetic-persona fixtures), never dumps field values.
 *
 * It also enforces the PAGINATION half of the contract (#629, #631, #632, #635):
 * a section heading or an entry header may never be the final drawn line on a
 * page; a bullet that wraps may never leave one of its lines alone on a page —
 * neither its first at a page bottom (#629) nor its last at a page top (#631);
 * an entry may never open a page with its last bullet alone (#632); and the
 * summary body — the one wrapped block those three left uncovered — may not
 * widow its last line either (#635). Those cases are exercised on SYNTHESIZED
 * models (no PDF fixture) — see the second and third describe blocks, whose
 * helpers locate by bisection the exact input length that puts the natural page
 * break on the subject line.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { matchSectionHeader } from "../heuristics/regex.ts";
import { runCascade } from "../heuristics/cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import type { AtsEntry, AtsResumeModel } from "./ats-resume-model.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { REFERENCE_BODY_PT, renderAtsResumePdf } from "./render-ats-pdf.ts";
import {
  extractPdfDrawnLines,
  type PdfDrawnLine,
} from "./render-ats-pdf.test-utils.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "../../..", "tests/fixtures/pdfs");

/** The canonical fallback headings `buildAtsResumeModel` emits when a section
 *  carried no recognized verbatim heading (see the `?? "..."` fallbacks). Plus
 *  the Summary fallback (`render-ats-pdf.ts` draws `summaryHeading ?? "Summary"`). */
const CANONICAL_FALLBACK_HEADINGS = [
  "Summary",
  "Experience",
  "Projects",
  "Achievements",
  "Education",
  "Skills",
] as const;

function walkPdfs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkPdfs(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) out.push(p);
  }
  return out.sort();
}

function scoreFor(cascade: CascadeResult) {
  return computeAnonymousAtsScore({
    parsed: { ...cascade.canonical.fields },
    fieldConfidence: cascade.canonical.fieldConfidence,
    triggers: cascade.triggers,
    rawText: cascade.rawText,
    sections: cascade.canonical.sections,
  });
}

describe("export layout contract — canonical headers re-recognize (#334)", () => {
  it("every canonical fallback heading is recognized by matchSectionHeader", () => {
    for (const heading of CANONICAL_FALLBACK_HEADINGS) {
      expect(
        matchSectionHeader(heading),
        `exporter fallback heading "${heading}" is not re-recognized`,
      ).not.toBeNull();
    }
  });

  const fixtures = walkPdfs(FIXTURE_ROOT);

  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    const rel = fixture.slice(FIXTURE_ROOT.length + 1);
    it(`emits only re-recognizable headings: ${rel}`, async () => {
      const cascade = await runCascade(new Uint8Array(readFileSync(fixture)));
      const model = buildAtsResumeModel(cascade, scoreFor(cascade));

      const headings = model.sections.map((s) => s.heading);
      // The summary heading is drawn separately from `sections` (falls back to
      // "Summary"); include it only when a summary is actually emitted.
      if (model.summary) headings.push(model.summaryHeading ?? "Summary");

      for (const heading of headings) {
        expect(
          matchSectionHeader(heading),
          `${rel}: exporter emits heading "${heading}" that matchSectionHeader does not recognize`,
        ).not.toBeNull();
      }
    });
  }
});

// ── Pagination half of the contract: keep-with-next (#629) ───────────────────
//
// Content is SYNTHESIZED (no PDF fixture, per #629): a "filler" entry of N
// single-line bullets pushes a "subject" line down the page one line at a time,
// so some N puts the natural page break exactly on that subject line. `boundaryN`
// finds that N by bisection instead of hard-coding it, so the tests keep
// straddling the break if the page geometry / type scale ever changes — and fail
// LOUDLY (its bracket assertions) rather than going vacuous if they stop.

/** A filler bullet short enough to occupy exactly one drawn line. No digits, so
 *  `autoBoldMetrics` finds no metric and the plain single-string path is used. */
const FILLER_BULLET = "Filler bullet kept deliberately short.";

function fillerEntry(bullets: number): AtsEntry {
  return {
    headerLine: "Filler Role · Filler Company, Springfield, IL",
    bullets: Array.from({ length: bullets }, () => FILLER_BULLET),
  };
}

/**
 * A bullet wrapping to exactly THREE drawn lines under the Helvetica fallback,
 * carrying one distinctive token per line. Three is the canonical widow case
 * (#631): it is the shortest bullet with NO legal split position — either half
 * of a 2/1 or 1/2 break strands a lone line — so it can only move whole.
 */
const THREE_LINE_BULLET =
  "BULLETSTART partnered closely across engineering, product, design and " +
  "operations leadership to land a platform initiative that measurably " +
  "improved customer outcomes across every core segment BULLETMID and then " +
  "carried the same practice into the wider organisation over several " +
  "subsequent quarters of sustained delivery BULLETEND";
const THREE_LINE_TOKENS = ["BULLETSTART", "BULLETMID", "BULLETEND"];

/** A bullet wrapping to exactly FOUR drawn lines, one token per line. Four is
 *  the shortest bullet that CAN legally split (2/2), so it is the case that
 *  exercises break placement rather than a whole-bullet reservation (#631). */
const FOUR_LINE_BULLET =
  "BULLETSTART partnered closely across engineering, product, design and " +
  "operations leadership to land a platform initiative that measurably " +
  "improved customer outcomes across every core segment BULLETTWO and then " +
  "carried the same practice into the wider organisation, writing the " +
  "complete set of on-call runbooks and operational playbooks BULLETTHREE " +
  "and training the whole on-call rotation before handing the entire " +
  "programme over to its permanent long-term owners BULLETEND";
const FOUR_LINE_TOKENS = [
  "BULLETSTART",
  "BULLETTWO",
  "BULLETTHREE",
  "BULLETEND",
];

/** Build a model whose `sections` are pushed down by `filler` one-line bullets. */
type ModelBuilder = (filler: number) => AtsResumeModel;

/** One Experience section: the filler entry, then the subject entry. */
const withFillerBefore =
  (subject: AtsEntry): ModelBuilder =>
  (filler) => ({
    contact: { name: "Jane Candidate", links: [] },
    sections: [
      { heading: "Experience", entries: [fillerEntry(filler), subject] },
    ],
  });

/**
 * Every contract in this file is about WHERE the engine breaks a page, so each
 * render pins the body size instead of letting the fit pass choose it.
 *
 * Unpinned, these tests would be vacuous rather than wrong: the fit pass exists
 * to keep a résumé on one page, and it would shrink each deliberately-oversized
 * fixture below until there was no page break left to make a claim about. The
 * rung itself is arbitrary — the reference size keeps the fixtures calibrated
 * where they already were.
 */
const PINNED = { bodyPt: REFERENCE_BODY_PT } as const;

async function drawnLines(
  build: ModelBuilder,
  filler: number,
): Promise<PdfDrawnLine[]> {
  return extractPdfDrawnLines(
    (await renderAtsResumePdf(build(filler), PINNED)).bytes,
  );
}

/** Index of the single drawn line containing `token` (fails if 0 or 2+ match). */
function lineIndexOf(lines: PdfDrawnLine[], token: string): number {
  const hits = lines
    .map((l, i) => (l.text.includes(token) ? i : -1))
    .filter((i) => i >= 0);
  expect(hits, `expected "${token}" on exactly one drawn line`).toHaveLength(1);
  return hits[0];
}

/** The page (1-based) the line containing `token` landed on. */
function pageOf(lines: PdfDrawnLine[], token: string): number {
  return lines[lineIndexOf(lines, token)].page;
}

/** How many text lines were drawn on `page` — the density measure a "wasted
 *  page" / "de-densified page" assertion is about (#629). */
function linesOnPage(lines: PdfDrawnLine[], page: number): number {
  return lines.filter((l) => l.page === page).length;
}

/**
 * The smallest filler-bullet count that pushes `token` off page 1. Monotone by
 * construction — every filler bullet is exactly one line, so the subject only
 * ever moves down — so a bisection is exact. The two bracket assertions are the
 * non-vacuity gate: they prove the break really is inside the searched range.
 */
async function boundaryN(
  build: ModelBuilder,
  token: string,
  max = 80,
): Promise<number> {
  expect(
    pageOf(await drawnLines(build, 0), token),
    `"${token}" must start on page 1 with no filler`,
  ).toBe(1);
  expect(
    pageOf(await drawnLines(build, max), token),
    `"${token}" must be pushed off page 1 by ${max} filler bullets`,
  ).toBeGreaterThan(1);
  let lo = 0;
  let hi = max;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (pageOf(await drawnLines(build, mid), token) > 1) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Filler counts to assert over: the break lands on the subject line inside this
 *  window, so it covers "just fits", "exactly on the boundary", and "just past". */
const windowAround = (n: number) => [n - 2, n - 1, n, n + 1];

/** The minimum drawn lines of one wrapped bullet that must land on each side of
 *  a page break it straddles — `BULLET_KEEP_LINES` in render-ats-pdf.ts. Kept as
 *  a local literal rather than an import so the test states the CONTRACT and
 *  cannot be silently relaxed by editing the implementation's constant. */
const MIN_BULLET_LINES_PER_PAGE = 2;

/**
 * How many of one bullet's drawn lines landed on each page it occupies, in page
 * order — `tokens` names those lines, one distinctive token per wrapped line, in
 * draw order.
 *
 * A single count of `1` IS the whole page-break defect family: on the first page
 * of the pair it is #629's orphan (a lone first line at a page bottom), on the
 * second it is #631's widow (a lone last line at a page top). Asserting every
 * count `>= MIN_BULLET_LINES_PER_PAGE` therefore states both halves at once, and
 * for a bullet too short to admit any legal split it collapses to the stronger
 * "all on one page" — the only arrangement that satisfies it.
 */
function bulletLinesPerPage(
  lines: PdfDrawnLine[],
  tokens: string[],
): number[] {
  const perPage = new Map<number, number>();
  for (const token of tokens) {
    const page = pageOf(lines, token);
    perPage.set(page, (perPage.get(page) ?? 0) + 1);
  }
  return [...perPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, count]) => count);
}

/** Assert `tokens`' drawn lines are contiguous, in order, at `filler = 0` — the
 *  non-vacuity gate for a break-position test, whether the tokens name one
 *  bullet's wrapped lines (#631) or one bullet each (#632). Without it, content
 *  that laid out differently than intended would make the page assertions pass
 *  for the wrong reason. */
function expectWrapsTo(lines: PdfDrawnLine[], tokens: string[]) {
  const first = lineIndexOf(lines, tokens[0]);
  tokens.forEach((token, i) => {
    expect(
      lineIndexOf(lines, token),
      `expected "${token}" on wrapped line ${i + 1} of the bullet`,
    ).toBe(first + i);
  });
}

describe("export layout contract — keep-with-next pagination (#629)", () => {
  it("never leaves an entry header as the last line on a page", async () => {
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: ["ALPHABULLET drove the platform migration end to end."],
    });
    const n = await boundaryN(build, "SUBJECTROLE");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      expect(
        pageOf(lines, "SUBJECTROLE"),
        `filler=${filler}: header stranded away from its first bullet`,
      ).toBe(pageOf(lines, "ALPHABULLET"));
    }
  });

  it("moves ALL of a wrapped entry header with its first bullet", async () => {
    const build = withFillerBefore({
      headerLine:
        "SUBJECTROLE Senior Staff Engineering Manager · Subject Company, " +
        "Springfield, Illinois · Platform Infrastructure, Developer " +
        "Experience, Release Engineering HEADEREND",
      headerHangingIndent: 12,
      bullets: ["ALPHABULLET drove the platform migration end to end."],
    });
    // Non-vacuity: the header really does wrap, and to exactly two lines — so
    // reserving one header line (the pre-#629 behaviour) is provably not enough.
    const unbroken = await drawnLines(build, 0);
    expect(lineIndexOf(unbroken, "HEADEREND")).toBe(
      lineIndexOf(unbroken, "SUBJECTROLE") + 1,
    );

    const n = await boundaryN(build, "SUBJECTROLE");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      const headPage = pageOf(lines, "SUBJECTROLE");
      expect(
        pageOf(lines, "HEADEREND"),
        `filler=${filler}: wrapped header split across pages`,
      ).toBe(headPage);
      expect(
        pageOf(lines, "ALPHABULLET"),
        `filler=${filler}: wrapped header stranded from its first bullet`,
      ).toBe(headPage);
    }
  });

  it("keeps a bullet-less entry's header and sub-line together, reserving no phantom bullet line", async () => {
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company",
      subLine: "SUBLINETOKEN Springfield, Illinois",
      bullets: [],
    });
    const n = await boundaryN(build, "SUBJECTROLE");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      expect(
        pageOf(lines, "SUBLINETOKEN"),
        `filler=${filler}: bullet-less header split from its sub-line`,
      ).toBe(pageOf(lines, "SUBJECTROLE"));
    }
  });

  it("never splits a wrapped bullet one line / rest across a page break", async () => {
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: [
        "ALPHABULLET short first bullet.",
        "BULLETSTART partnered across engineering, product and design to land " +
          "an initiative that measurably improved customer outcomes BULLETEND",
      ],
    });
    // Non-vacuity: the subject bullet wraps to exactly two drawn lines, so
    // "first line and last line on the same page" IS the no-split assertion.
    const unbroken = await drawnLines(build, 0);
    expect(lineIndexOf(unbroken, "BULLETEND")).toBe(
      lineIndexOf(unbroken, "BULLETSTART") + 1,
    );

    const n = await boundaryN(build, "BULLETSTART");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      expect(
        pageOf(lines, "BULLETEND"),
        `filler=${filler}: wrapped bullet orphaned its first line`,
      ).toBe(pageOf(lines, "BULLETSTART"));
    }
  });

  it("never leaves a section heading as the last line on a page", async () => {
    const build: ModelBuilder = (filler) => ({
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        { heading: "Experience", entries: [fillerEntry(filler)] },
        {
          heading: "Achievements",
          entries: [
            {
              headerLine: "SUBJECTROLE · Subject Company",
              bullets: ["ALPHABULLET led the standards working group."],
            },
          ],
        },
      ],
    });
    const n = await boundaryN(build, "ACHIEVEMENTS");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      const headingPage = pageOf(lines, "ACHIEVEMENTS");
      expect(
        pageOf(lines, "SUBJECTROLE"),
        `filler=${filler}: section heading stranded from its first entry`,
      ).toBe(headingPage);
      expect(
        pageOf(lines, "ALPHABULLET"),
        `filler=${filler}: section heading kept only a header, not a content line`,
      ).toBe(headingPage);
    }
  });

  it("never splits an entry's FIRST wrapped bullet one line / rest", async () => {
    // The first bullet is the one `drawEntry` marks `alreadyReserved`, so its
    // orphan control comes entirely from the entry's keep-block. Reserving
    // "header + ONE bullet line" there let the break land at header + 1 line and
    // split this bullet 1 / rest — the same defect the standalone-bullet case
    // above forbids, on the one bullet that case cannot reach.
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: [
        "BULLETSTART partnered across engineering, product and design to land " +
          "an initiative that measurably improved customer outcomes BULLETEND",
        "Second bullet kept deliberately short.",
      ],
    });
    // Non-vacuity: the FIRST bullet wraps to exactly two drawn lines, immediately
    // after the header — so "all three on one page" IS the no-split assertion.
    const unbroken = await drawnLines(build, 0);
    expect(lineIndexOf(unbroken, "BULLETSTART")).toBe(
      lineIndexOf(unbroken, "SUBJECTROLE") + 1,
    );
    expect(lineIndexOf(unbroken, "BULLETEND")).toBe(
      lineIndexOf(unbroken, "BULLETSTART") + 1,
    );

    const n = await boundaryN(build, "BULLETSTART");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      const startPage = pageOf(lines, "BULLETSTART");
      expect(
        pageOf(lines, "BULLETEND"),
        `filler=${filler}: entry's first wrapped bullet orphaned its first line`,
      ).toBe(startPage);
      expect(
        pageOf(lines, "SUBJECTROLE"),
        `filler=${filler}: header stranded from its first bullet`,
      ).toBe(startPage);
    }
  });

  it("never leaves a THREE-line bullet's last line alone at a page top", async () => {
    // The widow half (#631). A three-line bullet has no legal split: the 2/1
    // break a two-line reservation permits leaves its tail alone at the next
    // page's top, and the 1/2 alternative is #629's orphan. So it must move
    // whole — the reservation is its full height, not a fixed two lines.
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: ["ALPHABULLET short first bullet.", THREE_LINE_BULLET],
    });
    // Non-vacuity: the subject bullet really does wrap to three drawn lines, in
    // token order — so a page-count of 1 or 2 for its tail is a real split.
    expectWrapsTo(await drawnLines(build, 0), THREE_LINE_TOKENS);

    const n = await boundaryN(build, "BULLETSTART");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      for (const count of bulletLinesPerPage(lines, THREE_LINE_TOKENS)) {
        expect(
          count,
          `filler=${filler}: three-line bullet split across pages`,
        ).toBeGreaterThanOrEqual(MIN_BULLET_LINES_PER_PAGE);
      }
    }
  });

  it("never leaves an entry's FIRST THREE-line bullet's last line alone at a page top", async () => {
    // The first bullet is the one `drawEntry` marks `alreadyReserved`, so its
    // whole break-position guarantee comes from the entry's keep-block. A block
    // reserving "header + two bullet lines" lets the break land after line two
    // and widows line three — the same defect the standalone case above forbids,
    // on the one bullet that case cannot reach.
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: [THREE_LINE_BULLET, "Second bullet kept deliberately short."],
    });
    // Non-vacuity: the bullet wraps to three lines AND sits immediately under
    // the header, so the keep-block really is what places it.
    const unbroken = await drawnLines(build, 0);
    expectWrapsTo(unbroken, THREE_LINE_TOKENS);
    expect(lineIndexOf(unbroken, "BULLETSTART")).toBe(
      lineIndexOf(unbroken, "SUBJECTROLE") + 1,
    );

    const n = await boundaryN(build, "BULLETSTART");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      for (const count of bulletLinesPerPage(lines, THREE_LINE_TOKENS)) {
        expect(
          count,
          `filler=${filler}: entry's first three-line bullet split across pages`,
        ).toBeGreaterThanOrEqual(MIN_BULLET_LINES_PER_PAGE);
      }
      expect(
        pageOf(lines, "SUBJECTROLE"),
        `filler=${filler}: header stranded from its first bullet`,
      ).toBe(pageOf(lines, "BULLETSTART"));
    }
  });

  it("splits a FOUR-line bullet so neither page gets a lone line", async () => {
    // A four-line bullet stays DIVISIBLE — reserving it whole would de-densify
    // pages, the failure mode #630 measured. Instead the break is placed: when
    // three lines would fit, the third is pushed forward so the tail carries two
    // lines rather than widowing the fourth.
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: ["ALPHABULLET short first bullet.", FOUR_LINE_BULLET],
    });
    // Non-vacuity: the subject bullet really does wrap to four drawn lines, so a
    // 3/1 split is reachable and is what this asserts against.
    expectWrapsTo(await drawnLines(build, 0), FOUR_LINE_TOKENS);

    const n = await boundaryN(build, "BULLETSTART");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      for (const count of bulletLinesPerPage(lines, FOUR_LINE_TOKENS)) {
        expect(
          count,
          `filler=${filler}: four-line bullet left a lone line on a page`,
        ).toBeGreaterThanOrEqual(MIN_BULLET_LINES_PER_PAGE);
      }
    }
  });

  it("never leaves an entry's LAST bullet alone at a page top", async () => {
    // #632. Once the header is safely placed, nothing constrained how an entry's
    // bullets distributed among THEMSELVES — so a four-bullet entry rendered 3/1
    // and the fourth bullet opened the next page with no other trace of its entry
    // above it. The rule pushes the third forward with it, so at least two travel
    // together. Single-line bullets on purpose: the defect does not need a wrapped
    // bullet, and a wrapped-only rule would not reach this repro.
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: [
        "ONEBULLET drove the platform migration.",
        "TWOBULLET rebuilt the release pipeline.",
        "THREEBULLET mentored the on-call rotation.",
        "FOURBULLET owned the incident review process.",
      ],
    });
    // Non-vacuity: all four bullets really are one drawn line each and contiguous
    // in order, so "the last two share a page" IS the no-lone-bullet assertion.
    expectWrapsTo(await drawnLines(build, 0), [
      "ONEBULLET",
      "TWOBULLET",
      "THREEBULLET",
      "FOURBULLET",
    ]);

    const n = await boundaryN(build, "FOURBULLET");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      expect(
        pageOf(lines, "FOURBULLET"),
        `filler=${filler}: entry's last bullet left alone at a page top`,
      ).toBe(pageOf(lines, "THREEBULLET"));
    }
  });

  it("never leaves the SECOND bullet of a two-bullet entry alone at a page top", async () => {
    // The hard case. Here the second-to-last bullet IS the first bullet — the one
    // `drawEntry` marks `alreadyReserved` — so the hand-off has nowhere to ride
    // and `entryKeepHeight` must carry it. That makes this the one shape where the
    // rule grows the entry's own keep-block, which is why it is bounded to the
    // trailing bullet's keep-opening and dropped outright if it would push the
    // block past a page (#629 outranks #632).
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: [
        "ONEBULLET drove the platform migration.",
        "TWOBULLET rebuilt the release pipeline.",
      ],
    });
    // Non-vacuity: both bullets are one drawn line each, immediately under the
    // header — so the keep-block really is what places them.
    const unbroken = await drawnLines(build, 0);
    expectWrapsTo(unbroken, ["ONEBULLET", "TWOBULLET"]);
    expect(lineIndexOf(unbroken, "ONEBULLET")).toBe(
      lineIndexOf(unbroken, "SUBJECTROLE") + 1,
    );

    const n = await boundaryN(build, "TWOBULLET");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      const firstPage = pageOf(lines, "ONEBULLET");
      expect(
        pageOf(lines, "TWOBULLET"),
        `filler=${filler}: two-bullet entry's second bullet left alone at a page top`,
      ).toBe(firstPage);
      expect(
        pageOf(lines, "SUBJECTROLE"),
        `filler=${filler}: header stranded from its first bullet`,
      ).toBe(firstPage);
    }
  });

  it("keeps the last bullet with the TAIL of a wrapped second-to-last bullet", async () => {
    // The interaction with #631. When the second-to-last bullet is itself long
    // enough to split, the reservation covering its final line is the TAIL
    // reservation, not its opening — so that is where the last bullet's
    // keep-opening rides. Either the tail and the last bullet both fit here, or
    // the break moves up and they travel forward together. The four-line bullet
    // must also stay divisible: reserving it whole is the density failure #630
    // measured, so this asserts placement, not a whole-bullet move.
    const build = withFillerBefore({
      headerLine: "SUBJECTROLE · Subject Company, Springfield, IL",
      bullets: [
        "ALPHABULLET short first bullet.",
        FOUR_LINE_BULLET,
        "TAILBULLET owned the incident review process.",
      ],
    });
    // Non-vacuity: the middle bullet really does wrap to four drawn lines, so its
    // tail is a real, separately-placed unit.
    expectWrapsTo(await drawnLines(build, 0), FOUR_LINE_TOKENS);

    const n = await boundaryN(build, "TAILBULLET");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      expect(
        pageOf(lines, "TAILBULLET"),
        `filler=${filler}: last bullet left alone at a page top, away from the wrapped bullet's tail`,
      ).toBe(pageOf(lines, "BULLETEND"));
      // #631 still holds: the wrapped bullet is not pulled forward whole, and
      // neither side of any break it straddles gets a lone line.
      for (const count of bulletLinesPerPage(lines, FOUR_LINE_TOKENS)) {
        expect(
          count,
          `filler=${filler}: four-line bullet left a lone line on a page`,
        ).toBeGreaterThanOrEqual(MIN_BULLET_LINES_PER_PAGE);
      }
    }
  });

  it("moves ALL of a genuine THREE-line entry header with its first bullet", async () => {
    // The B2 cap on body-text headers must not reach a real header: a role header
    // that wraps to three lines still reserves all three.
    const build = withFillerBefore({
      headerLine:
        "HEADSTART Senior Staff Engineering Manager and Principal Technical " +
        "Program Lead · Subject Company Incorporated, Springfield, Illinois · " +
        "Platform Infrastructure, Developer Experience, Release Engineering, " +
        "Observability and Reliability Engineering HEADEREND",
      headerHangingIndent: 12,
      bullets: ["ALPHABULLET drove the platform migration end to end."],
    });
    // Non-vacuity: the header really does wrap to THREE lines, so a two-line cap
    // (what a body-text header gets) is provably not enough to hold it.
    const unbroken = await drawnLines(build, 0);
    expect(lineIndexOf(unbroken, "HEADEREND")).toBe(
      lineIndexOf(unbroken, "HEADSTART") + 2,
    );

    const n = await boundaryN(build, "HEADSTART");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      const headPage = pageOf(lines, "HEADSTART");
      expect(
        pageOf(lines, "HEADEREND"),
        `filler=${filler}: three-line header split across pages`,
      ).toBe(headPage);
      expect(
        pageOf(lines, "ALPHABULLET"),
        `filler=${filler}: three-line header stranded from its first bullet`,
      ).toBe(headPage);
    }
  });

  it("does not pull a long skills list forward as one indivisible block", async () => {
    // The skills list is a SINGLE `headerLine` (`skills.join(" · ")` with no
    // bullets — `ats-resume-model.ts`), marked `headerBold: false` because it
    // reads as body text. Reserving every one of its wrapped lines as a
    // keep-with-next unit moves the WHOLE list to the next page and leaves a
    // half-empty page behind, which `drawSectionHeading` inherits through
    // `followHeight`. Body text is divisible; it must flow.
    const skillsSection = (skills: string[]) => ({
      heading: "Skills",
      entries: [
        {
          headerLine: skills.join(" · "),
          headerBold: false,
          atomicSegments: true,
          bullets: [],
        } satisfies AtsEntry,
      ],
    });
    const longSkills = [
      "FIRSTSKILL",
      ...Array.from({ length: 120 }, (_, i) => `Skill${i}`),
      "LASTSKILL",
    ];
    const buildFor =
      (skills: string[]): ModelBuilder =>
      (filler) => ({
        contact: { name: "Jane Candidate", links: [] },
        sections: [
          { heading: "Experience", entries: [fillerEntry(filler)] },
          skillsSection(skills),
        ],
      });
    const build = buildFor(longSkills);
    // A one-line control list: same document, same filler, a skills block that
    // cannot possibly be pulled forward. Page 1 of the long variant must be at
    // least as full as page 1 of the control — that is the density claim, and it
    // is what a whole-block reservation breaks.
    const control = buildFor(["FIRSTSKILL", "Skill0", "LASTSKILL"]);

    // Non-vacuity: the long list really does wrap far past the two-line cap.
    const unbroken = await drawnLines(build, 0);
    expect(
      lineIndexOf(unbroken, "LASTSKILL") - lineIndexOf(unbroken, "FIRSTSKILL"),
    ).toBeGreaterThan(2);

    const n = await boundaryN(build, "LASTSKILL");
    for (const filler of windowAround(n)) {
      const lines = await drawnLines(build, filler);
      expect(
        pageOf(lines, "FIRSTSKILL"),
        `filler=${filler}: whole skills list pulled off the heading's page`,
      ).toBe(pageOf(lines, "SKILLS"));
      expect(
        linesOnPage(lines, 1),
        `filler=${filler}: skills block de-densified page 1`,
      ).toBeGreaterThanOrEqual(
        linesOnPage(await drawnLines(control, filler), 1),
      );
    }
  });

  it("wastes no page on a keep-block taller than a whole page", async () => {
    // An entry whose header alone outruns a full page makes BOTH the section
    // heading's reservation and the entry's own reservation unsatisfiable. If
    // `ensureBlock` were a bare `ensure`, each would break in turn: the heading
    // lands alone on a fresh page and the entry starts on the one after — a wasted
    // page AND the very stranding the reservation exists to prevent (#629 AC3).
    //
    // The header is a GENUINE (bold) one on purpose. A body-text header — the
    // skills list — is capped at two lines and so can no longer reach this case at
    // all; only an uncapped real header can, which is what makes it the honest
    // exercise of `ensureBlock`'s unsatisfiable branch.
    const model: AtsResumeModel = {
      contact: { name: "Jane Candidate", links: [] },
      sections: [
        { heading: "Experience", entries: [fillerEntry(10)] },
        {
          heading: "Achievements",
          entries: [
            {
              headerLine: [
                "FIRSTHEAD",
                ...Array.from({ length: 900 }, (_, i) => `Award${i}`),
                "LASTHEAD",
              ].join(" · "),
              bullets: ["ALPHABULLET led the standards working group."],
            },
          ],
        },
      ],
    };
    const lines = await extractPdfDrawnLines(
      (await renderAtsResumePdf(model, PINNED)).bytes,
    );
    const pages = Math.max(...lines.map((l) => l.page));
    const densest = Math.max(
      ...Array.from({ length: pages }, (_, i) => linesOnPage(lines, i + 1)),
    );
    // Non-vacuity: the block really is taller than a whole page — it draws more
    // lines than the densest page can hold, so NO page could ever satisfy its
    // reservation. Measured on the drawn output, not asserted from the input size.
    expect(
      lineIndexOf(lines, "LASTHEAD") - lineIndexOf(lines, "FIRSTHEAD") + 1,
    ).toBeGreaterThan(densest);

    expect(
      pageOf(lines, "FIRSTHEAD"),
      "ACHIEVEMENTS heading stranded alone; its entry starts on the next page",
    ).toBe(pageOf(lines, "ACHIEVEMENTS"));
    // No page before the last is wasted. A page consumed by an unsatisfiable
    // reservation is grossly under-filled (a heading and nothing else), so
    // comparing against half the densest page separates "wasted" from the few
    // lines a heading + rule + section gaps legitimately cost.
    for (let page = 1; page < pages; page++) {
      expect(
        linesOnPage(lines, page),
        `page ${page} was wasted by an unsatisfiable reservation`,
      ).toBeGreaterThan(densest / 2);
    }
  });
});

/**
 * The Summary body is the one wrapped block #629/#631/#632 left uncovered: it is
 * plain body text on the `drawText` path, so before this it paginated per line
 * and could widow its last line onto a page of its own.
 *
 * Reaching it takes a summary long enough to outrun page one on its own — the
 * summary is always drawn immediately after the contact block, so nothing can
 * push a SHORT one across a break. That makes the case remote, not impossible:
 * the summary is a free-text field the user can edit and paste into (#625), and
 * the boundary is located here by measurement rather than assumed.
 *
 * The ORPHAN half needs no test. `drawSectionHeading` already reserves the
 * heading plus one body line, and the block can only ever begin on page one's
 * first content line, so its opening can never sit at a page bottom.
 */
describe("export layout contract — the Summary body honours widow control", () => {
  /** A summary of `words` filler tokens, each wrapped line individually
   *  identifiable by its token index. No digits-only tokens that would read as a
   *  metric, and no middot, so it takes the plain wrapped-body path. */
  function summaryModel(words: number): AtsResumeModel {
    return {
      contact: { name: "Jane Candidate", links: [] },
      summary: Array.from({ length: words }, (_, i) => `token${i}`).join(" "),
      summaryHeading: "Professional Profile",
      sections: [],
    };
  }

  /** Drawn summary lines per page, in page order — the same shape
   *  {@link bulletLinesPerPage} returns, so a `1` is the widow. */
  async function summaryLinesPerPage(words: number): Promise<number[]> {
    const lines = await extractPdfDrawnLines(
      (await renderAtsResumePdf(summaryModel(words), PINNED)).bytes,
    );
    const perPage = new Map<number, number>();
    for (const line of lines) {
      if (!/\btoken\d+\b/.test(line.text)) continue;
      perPage.set(line.page, (perPage.get(line.page) ?? 0) + 1);
    }
    return [...perPage.entries()].sort(([a], [b]) => a - b).map(([, n]) => n);
  }

  /**
   * The smallest summary that spills onto page two at all. Monotone in `words`
   * (every extra word only ever pushes the block down), so a bisection is exact.
   * Bracketed on both sides: the low end must fit page one entirely and the high
   * end must spill, which is what stops the window below from being vacuous.
   */
  async function spillBoundary(max = 1400): Promise<number> {
    expect(
      (await summaryLinesPerPage(0)).length,
      "an empty summary must not spill onto page two",
    ).toBeLessThan(2);
    expect(
      (await summaryLinesPerPage(max)).length,
      `a ${max}-word summary must spill onto page two`,
    ).toBeGreaterThan(1);
    let lo = 0;
    let hi = max;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await summaryLinesPerPage(mid)).length > 1) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  it("never leaves the summary's last line alone at the top of a page", async () => {
    const n = await spillBoundary();
    // The widow can only occur in the first few words past the boundary — beyond
    // that the tail is naturally two or more lines — so the window is where the
    // defect lives, and every count in it must clear the same minimum a wrapped
    // bullet must (#631).
    for (let words = n; words <= n + 24; words += 4) {
      const perPage = await summaryLinesPerPage(words);
      expect(
        perPage.length,
        `words=${words}: summary no longer spans a page break`,
      ).toBe(2);
      expect(
        Math.min(...perPage),
        `words=${words}: summary widowed ${JSON.stringify(perPage)}`,
      ).toBeGreaterThanOrEqual(MIN_BULLET_LINES_PER_PAGE);
    }
  }, 60000);
});
