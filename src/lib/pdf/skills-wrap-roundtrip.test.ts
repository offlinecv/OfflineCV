// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip regression for #301 — a multi-word skill token must not split
 * across the line-wrap boundary on the parse → "Download PDF" → re-parse
 * cycle.
 *
 * Mechanism (see `ats-resume-model.ts:361` and `render-ats-pdf.ts`):
 *   - Reconstruction joins all skills into ONE middot-delimited header line
 *     (`skills.join(" · ")`).
 *   - The renderer word-wraps that line. Before the fix, the wrap split on
 *     ANY whitespace (`text.split(/\s+/)`), so a wrap point could fall INSIDE
 *     a multi-word skill (e.g. between "Data" and "Warehousing" in "Cloud
 *     Data Warehousing"), breaking it across two rendered PDF lines.
 *   - On re-parse the skills tokenizer then reads the wrapped continuation as
 *     a brand-new token, so one skill became two (count N → N+1).
 *
 * The fix makes `Layout.wrap()` treat each " · "-delimited segment (a whole
 * skill) as an atomic wrap unit — the wrap point can only fall BETWEEN
 * skills, never inside one.
 *
 * No new binary PDF fixture is needed: this test reuses an in-tree synthetic
 * fixture purely to get a legitimate `CascadeResult` (satisfying
 * `buildAtsResumeModel`'s full input contract), then overrides `parsed.skills`
 * with a long, deliberately multi-word-heavy list engineered to force at
 * least one wrap boundary inside a 2-4 word skill under the old
 * `\s+`-only wrap. Round-trip correctness is asserted as an exact set/count
 * match, independent of exactly where any given line wraps.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import { extractFromPdfBytes } from "../heuristics/pdf-extract.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf, wrapSegmentsToLines } from "./render-ats-pdf.ts";
import { loadPdfLibOnce } from "./load-pdf-lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/latex/awesome-cv-resume.pdf",
);

function scoreFor(cascade: CascadeResult) {
  return computeAnonymousAtsScore({
    parsed: { ...cascade.canonical.fields },
    fieldConfidence: cascade.canonical.fieldConfidence,
    triggers: cascade.triggers,
    rawText: cascade.rawText,
    sections: cascade.canonical.sections,
  });
}

// A long, multi-word-heavy skill list. Several 2-4 word skills interleaved
// with single-word ones so the joined " · " line spans multiple wrapped
// lines at the renderer's header size/width — under the pre-fix `\s+`-only
// wrap, at least one of these multi-word skills is virtually guaranteed to
// straddle a wrap boundary.
const SYNTHETIC_SKILLS = [
  "Python",
  "Kubernetes",
  "Cloud Data Warehousing",
  "Terraform",
  "Site Reliability Engineering",
  "Docker",
  "Machine Learning Operations",
  "SQL",
  "Customer Relationship Management",
  "AWS",
  "Distributed Systems Design",
  "Golang",
  "Continuous Integration Pipelines",
  "React",
  "Infrastructure As Code",
  "Redis",
  "Data Warehouse Modeling",
  "Linux",
  "Security Incident Response",
  "GraphQL",
];

describe("#301 — multi-word skill does not split at the line-wrap boundary", () => {
  let reparsedSkills: string[];

  // Fixture-read + runCascade/render round-trip is slow under a
  // coverage-instrumented full-suite `verify` run; scope a higher timeout to
  // just this hook rather than bumping vitest's global default (#360).
  beforeAll(async () => {
    const original = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const withSyntheticSkills: CascadeResult = {
      ...original,
      canonical: {
        ...original.canonical,
        fields: { ...original.canonical.fields, skills: SYNTHETIC_SKILLS },
      },
    };
    const model = buildAtsResumeModel(
      withSyntheticSkills,
      scoreFor(withSyntheticSkills),
    );
    const { bytes } = await renderAtsResumePdf(model);
    const reparsed = await runCascade(bytes);
    reparsedSkills = reparsed.canonical.fields.skills ?? [];
  }, 20000);

  it("round-trips the same skill count (AC)", () => {
    expect(reparsedSkills.length).toBe(SYNTHETIC_SKILLS.length);
  });

  it("round-trips every multi-word skill intact — none split at a wrap point", () => {
    const reparsedSet = new Set(reparsedSkills);
    for (const skill of SYNTHETIC_SKILLS) {
      expect(reparsedSet.has(skill)).toBe(true);
    }
  });
});

/**
 * Round-trip regression for #791 — a category that covers only a SUBSET of the
 * flat skills list (the ungrouped remainder created by the first-category
 * reachability fix) must not drop the remainder on export. Reuses the same
 * fixture-read + override technique as the #301 block above: no new PDF.
 */
describe("#791 — a categorised-plus-ungrouped skills list survives export and re-parse", () => {
  const CATEGORIES = [
    { label: "Data Stores", skills: ["PostgreSQL", "Redis"] },
    { label: "Backend", skills: ["Java", "Golang"] },
  ];
  const UNGROUPED = ["Excel", "PowerPoint", "Tableau"];
  const ALL_SKILLS = [...CATEGORIES.flatMap((c) => c.skills), ...UNGROUPED];

  let reparsedSkills: string[];

  beforeAll(async () => {
    const original = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const withMixedSkills: CascadeResult = {
      ...original,
      canonical: {
        ...original.canonical,
        fields: {
          ...original.canonical.fields,
          skills: ALL_SKILLS,
          skillCategories: CATEGORIES,
        },
      },
    };
    const model = buildAtsResumeModel(
      withMixedSkills,
      scoreFor(withMixedSkills),
    );
    const { bytes } = await renderAtsResumePdf(model);
    const reparsed = await runCascade(bytes);
    reparsedSkills = reparsed.canonical.fields.skills ?? [];
  }, 20000);

  it("round-trips every skill — categorised AND ungrouped alike", () => {
    const reparsedSet = new Set(reparsedSkills);
    for (const skill of ALL_SKILLS) {
      expect(reparsedSet.has(skill)).toBe(true);
    }
  });

  it("loses none to the categorised branch's grouping logic (exact count)", () => {
    expect(reparsedSkills.length).toBe(ALL_SKILLS.length);
  });
});

/**
 * Round-trip regression for #881 — bolding the category label must not cost the
 * atomic wrap. The label is drawn as an inset on the FIRST line only, so the
 * members still wrap segment-atomically (a bolded label emitted inside the
 * emphasis sentinels would route the line to the whitespace-word run wrapper
 * instead, re-opening #301 on the very line that now has less room).
 *
 * Both categories are wide enough to wrap several times at the export's header
 * size, and every member is multi-word, so a mid-name break would show up as a
 * skill that fails to come back. The whole section is categorised — the parser
 * emits the structured `skillCategories` view only when nothing precedes the
 * first label — so the labels and their membership are asserted too.
 */
describe("#881 — a bold category label keeps atomic wrapping on its own line", () => {
  const CATEGORIES = [
    {
      label: "Machine Learning",
      skills: [
        "Cloud Data Warehousing",
        "Machine Learning Operations",
        "Distributed Systems Design",
        "Natural Language Processing",
        "Feature Store Engineering",
        "Model Serving Infrastructure",
      ],
    },
    {
      label: "Platform Engineering",
      skills: [
        "Site Reliability Engineering",
        "Continuous Integration Pipelines",
        "Infrastructure As Code",
        "Security Incident Response",
        "Container Orchestration",
        "Observability Tooling",
      ],
    },
  ];
  const ALL_SKILLS = CATEGORIES.flatMap((c) => c.skills);

  let reparsedSkills: string[];
  let reparsedCategories: { label: string; skills: string[] }[] | undefined;

  beforeAll(async () => {
    const original = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const withCategories: CascadeResult = {
      ...original,
      canonical: {
        ...original.canonical,
        fields: {
          ...original.canonical.fields,
          skills: ALL_SKILLS,
          skillCategories: CATEGORIES,
        },
      },
    };
    const model = buildAtsResumeModel(withCategories, scoreFor(withCategories));
    const { bytes } = await renderAtsResumePdf(model);
    const reparsed = await runCascade(bytes);
    reparsedSkills = reparsed.canonical.fields.skills ?? [];
    reparsedCategories = reparsed.canonical.fields.skillCategories;
  }, 20000);

  it("round-trips every multi-word skill intact — none split at a wrap point (AC)", () => {
    const reparsedSet = new Set(reparsedSkills);
    for (const skill of ALL_SKILLS) {
      expect(reparsedSet.has(skill)).toBe(true);
    }
    expect(reparsedSkills.length).toBe(ALL_SKILLS.length);
  });

  it("re-parses the same category labels and members (AC)", () => {
    expect(reparsedCategories).toEqual(CATEGORIES);
  });
});

/**
 * #881 AC — a category label long enough to eat line 0 must wrap sanely rather
 * than run past the right margin. Two shapes, one assertion: a label that fills
 * most of the line takes line 0 alone and the members start below it, and a
 * label wider than the whole line stops leading altogether and word-wraps as
 * ordinary text (it is drawn as one piece, so an inset could not break it).
 * Asserted on the DRAWN items, since the margin is a geometry property no model
 * assertion can see.
 */
describe("#881 — an over-long category label never overflows the right margin", () => {
  const RIGHT_EDGE = 612 - 36; // PAGE_WIDTH - MARGIN, per render-ats-pdf.ts.
  const MEMBERS = ["Cloud Data Warehousing", "Machine Learning Operations"];

  // Scoped to the Skills section on purpose: this fixture's own résumé already
  // draws one bullet ~2pt past the margin, which is a separate defect on the
  // bullet path and not what this assertion is about.
  async function drawnSkillsItems(label: string) {
    const original = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const withCategory: CascadeResult = {
      ...original,
      canonical: {
        ...original.canonical,
        fields: {
          ...original.canonical.fields,
          skills: MEMBERS,
          skillCategories: [{ label, skills: MEMBERS }],
        },
      },
    };
    const model = buildAtsResumeModel(withCategory, scoreFor(withCategory));
    const { bytes } = await renderAtsResumePdf(model);
    const { items } = await extractFromPdfBytes(bytes);
    const heading = items.findIndex((i) => i.str.trim() === "SKILLS");
    expect(heading).toBeGreaterThan(-1);
    return items.slice(heading + 1);
  }

  it("keeps the skills lines inside the margin for a label that fills the line", async () => {
    const items = await drawnSkillsItems(
      "Machine Learning And Data Platform Engineering Practice",
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.x + item.width).toBeLessThanOrEqual(RIGHT_EDGE);
    }
  }, 20000);

  it("keeps the skills lines inside the margin for a label wider than the line", async () => {
    const items = await drawnSkillsItems(
      "Extremely Long Category Label That Consumes The Entire Available Content Width Of The Page And Then A Good Deal More Besides",
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.x + item.width).toBeLessThanOrEqual(RIGHT_EDGE);
    }
  }, 20000);
});

/**
 * Unit coverage for the first-line inset the bold label wraps against (#881) —
 * the half of the fix `wrapSegmentsToLines` owns. `render-ats-pdf.ts` narrows
 * line 0 by the lead's BOLD width and draws the members flush against its end,
 * so the wrapper has to honour two widths and, when the lead leaves no usable
 * room, hand the lead a line of its own rather than overflow the margin.
 */
describe("wrapSegmentsToLines — inset first line (#881)", () => {
  const SIZE = 10;
  const MAX_WIDTH = 468;
  const SEGMENTS = [
    "Cloud Data Warehousing",
    "Machine Learning Operations",
    "Distributed Systems Design",
    "Security Incident Response",
  ];

  it("packs line 0 to the narrowed width and the rest to the full width", async () => {
    const { PDFDocument, StandardFonts } = await loadPdfLibOnce();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const inset = 160;
    const lines = wrapSegmentsToLines(
      SEGMENTS,
      font,
      SIZE,
      MAX_WIDTH,
      MAX_WIDTH - inset,
    );
    expect(font.widthOfTextAtSize(lines[0], SIZE)).toBeLessThanOrEqual(
      MAX_WIDTH - inset,
    );
    for (const line of lines.slice(1)) {
      expect(font.widthOfTextAtSize(line, SIZE)).toBeLessThanOrEqual(MAX_WIDTH);
    }
    // The inset must cost line 0 room, not integrity: every segment comes back
    // whole, so no multi-word skill was broken to make it fit.
    expect(lines.join(" · ").split(" · ")).toEqual(SEGMENTS);
  });

  it("gives an over-wide lead line 0 to itself instead of overflowing", async () => {
    const { PDFDocument, StandardFonts } = await loadPdfLibOnce();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    // A lead consuming all but 4pt of the line: nothing fits beside it.
    const lines = wrapSegmentsToLines(SEGMENTS, font, SIZE, MAX_WIDTH, 4);
    expect(lines[0]).toBe("");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(font.widthOfTextAtSize(line, SIZE)).toBeLessThanOrEqual(MAX_WIDTH);
    }
    expect(lines.slice(1).join(" · ").split(" · ")).toEqual(SEGMENTS);
  });

  it("is byte-identical to the un-inset wrap when no lead is passed", async () => {
    const { PDFDocument, StandardFonts } = await loadPdfLibOnce();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    expect(wrapSegmentsToLines(SEGMENTS, font, SIZE, MAX_WIDTH, MAX_WIDTH)).toEqual(
      wrapSegmentsToLines(SEGMENTS, font, SIZE, MAX_WIDTH),
    );
  });
});

/**
 * Regression for the `wrapSegmentsToLines` first-segment bug: `segments[0]`
 * used to be assigned to `current` before the loop and never measured, so an
 * overlong FIRST segment (a "Company · Location" org line whose company name
 * alone exceeds maxWidth) was emitted verbatim and overflowed the right margin.
 * Proven repro (Helvetica, size 10, maxWidth 468): the 104-char company string
 * measures 476.46pt > 468. Every returned line must now fit within maxWidth.
 */
describe("wrapSegmentsToLines — overlong FIRST segment is wrapped, not overflowed", () => {
  const SIZE = 10;
  const MAX_WIDTH = 468;

  it("no rendered line exceeds maxWidth when segments[0] is too wide", async () => {
    const { PDFDocument, StandardFonts } = await loadPdfLibOnce();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const segments = [
      "International Business Machines Corporation Yorktown Heights Thomas J Watson Research Center Division",
      "Yorktown Heights NY",
    ];
    // Sanity-check the repro precondition: the first segment alone overflows.
    expect(font.widthOfTextAtSize(segments[0], SIZE)).toBeGreaterThan(MAX_WIDTH);

    const lines = wrapSegmentsToLines(segments, font, SIZE, MAX_WIDTH);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, SIZE)).toBeLessThanOrEqual(MAX_WIDTH);
    }
  });
});
