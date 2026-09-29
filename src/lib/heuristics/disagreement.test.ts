// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for diffParses (issue #242, grounding gate #1093).
 *
 * Pure function — no engine, no DOM, EXCEPT the grounding-gate describe block
 * at the bottom, which reads the real `latex/multi-degree-coursework.pdf`
 * fixture (the #1093 repro) through `runCascade` the way `corpus.test.ts`
 * does, so the n-gram threshold and the project/role split are pinned against
 * real extracted text rather than a hand-tuned string. Covers every
 * disagreement kind and its edge cases:
 *   - missing_field: each scalar (full_name/email/phone/location/summary),
 *     null/undefined/blank on the heuristic side, reverse direction ignored
 *   - dropped_section: experience / education / skills whole-section drop
 *   - dropped_role vs merged_roles: partial experience gap, disambiguated by
 *     the two_column trigger
 *   - likelyCause correlation + kind-aware trigger priority
 *   - no-disagreement cases (equal/heuristic-richer)
 *   - ordering + the partial-education non-report rationale
 *   - grounding gate (#1093): an LLM-recovered scalar/role that never
 *     demonstrably occurs in the text the model read is rejected, not shown
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  diffParses as canonicalDiffParses,
  type ParseDisagreement,
} from "./disagreement.ts";
import type { HeuristicParsedResume, LayoutTrigger } from "./types.ts";
import type { SectionName } from "./sections.config.ts";
import type { LlmParsedResume } from "../webllm/parse-resume.ts";
import { toCanonicalResume } from "./canonical.ts";
import { projectLlmDiff } from "./projections.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "./sections.ts";
import type { SectionedResume } from "./sections.ts";
import { runCascade } from "./cascade.ts";

// All gateable sections present by default — most cases below exercise drop
// *detection*, not the section-presence guard (that has its own describe block).
// Tests that probe the guard call `rawDiffParses` directly with an explicit set.
const ALL_SECTIONS: ReadonlySet<SectionName> = new Set([
  "experience",
  "education",
  "skills",
]);

// A grounding text broad enough to cover every LLM-recovered value the cases
// below use, so tests about OTHER logic (ordering, cause correlation, the
// section-presence guard…) aren't incidentally exercising the grounding gate
// too. The grounding-gate describe block at the bottom passes its own,
// deliberately narrow, text.
const DEFAULT_GROUNDING_TEXT = [
  "Jane Example",
  "jane@example.com",
  "a@example.com",
  "(312) 555-0123",
  "Chicago, IL",
  "NYC",
  "Engineer.",
  "Co 0",
  "Co 1",
  "Co 2",
  "Co 3",
].join(" ");

// Post-#445 `diffParses` takes two `CanonicalResume` shapes and derives the
// section-presence guard from the HEURISTIC canonical's `sections.byName` keys.
// This adapter reproduces the old 4-arg call surface so the cases below stay
// unchanged: it builds a heuristic canonical whose `byName` carries exactly the
// requested present-section headers, and coerces the LLM parse via the real
// `projectLlmDiff` projection (the same path production uses).
function sectionsWithHeaders(present: ReadonlySet<SectionName>): SectionedResume {
  const byName = new Map<SectionName | "profile", readonly string[]>();
  for (const name of present) byName.set(name, []);
  return {
    byName,
    accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
    source: "regex",
  };
}

function rawDiffParses(
  heuristic: HeuristicParsedResume,
  llm: LlmParsedResume,
  triggers: LayoutTrigger[],
  presentSections: ReadonlySet<SectionName>,
  groundingText: string = DEFAULT_GROUNDING_TEXT,
): ParseDisagreement[] {
  const heuristicCanonical = toCanonicalResume(
    heuristic,
    sectionsWithHeaders(presentSections),
    {},
  );
  return canonicalDiffParses(
    heuristicCanonical,
    projectLlmDiff(llm),
    triggers,
    groundingText,
  ).disagreements;
}

function diffParses(
  heuristic: HeuristicParsedResume,
  llm: LlmParsedResume,
  triggers: LayoutTrigger[],
  presentSections: ReadonlySet<SectionName> = ALL_SECTIONS,
  groundingText: string = DEFAULT_GROUNDING_TEXT,
): ParseDisagreement[] {
  return rawDiffParses(heuristic, llm, triggers, presentSections, groundingText);
}

// ── Builders ─────────────────────────────────────────────────────────────────

function heuristic(
  over: Partial<HeuristicParsedResume> = {},
): HeuristicParsedResume {
  return {
    full_name: "Jane Example",
    skills: ["TypeScript"],
    experience: [],
    education: [],
    ...over,
  };
}

function llm(over: Partial<LlmParsedResume> = {}): LlmParsedResume {
  return {
    full_name: "Jane Example",
    email: null,
    phone: null,
    location: null,
    summary: null,
    skills: ["TypeScript"],
    experience: [],
    education: [],
    ...over,
  };
}

const exp = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    company: `Co ${i}`,
    title: `Role ${i}`,
    description: "",
  }));

const edu = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    institution: `School ${i}`,
    degree: `Degree ${i}`,
  }));

function findKind(
  results: ParseDisagreement[],
  field: string,
): ParseDisagreement | undefined {
  return results.find((d) => d.field === field);
}

// ── missing_field ────────────────────────────────────────────────────────────

describe("diffParses — missing_field (scalars)", () => {
  const cases: Array<[string, Partial<HeuristicParsedResume>, Partial<LlmParsedResume>]> = [
    ["email", { email: undefined }, { email: "jane@example.com" }],
    ["phone", { phone: undefined }, { phone: "(312) 555-0123" }],
    ["location", { location: undefined }, { location: "Chicago, IL" }],
    ["summary", { summary: undefined }, { summary: "Engineer." }],
    ["full_name", { full_name: "" }, { full_name: "Jane Example" }],
  ];

  it.each(cases)(
    "reports %s missing on heuristic but present on LLM",
    (field, hOver, lOver) => {
      const r = diffParses(heuristic(hOver), llm(lOver), []);
      const d = findKind(r, field);
      expect(d).toBeDefined();
      expect(d!.kind).toBe("missing_field");
      expect(d!.heuristicValue).toBeNull();
      expect(d!.llmValue).toBe((lOver as Record<string, string>)[field]);
    },
  );

  it("treats null heuristic scalar the same as undefined", () => {
    const r = diffParses(
      heuristic({ email: null as unknown as string }),
      llm({ email: "jane@example.com" }),
      [],
    );
    expect(findKind(r, "email")?.kind).toBe("missing_field");
  });

  it("treats whitespace-only heuristic scalar as missing", () => {
    const r = diffParses(
      heuristic({ phone: "   " }),
      llm({ phone: "(312) 555-0123" }),
      [],
    );
    expect(findKind(r, "phone")?.kind).toBe("missing_field");
  });

  it("does NOT report when both sides have the field", () => {
    const r = diffParses(
      heuristic({ email: "jane@example.com" }),
      llm({ email: "jane@example.com" }),
      [],
    );
    expect(findKind(r, "email")).toBeUndefined();
  });

  it("does NOT report the reverse direction (heuristic has it, LLM null)", () => {
    const r = diffParses(
      heuristic({ email: "jane@example.com" }),
      llm({ email: null }),
      [],
    );
    expect(findKind(r, "email")).toBeUndefined();
  });

  it("ignores a blank LLM value (no recovery to report)", () => {
    const r = diffParses(heuristic({ email: undefined }), llm({ email: "  " }), []);
    expect(findKind(r, "email")).toBeUndefined();
  });
});

// ── dropped_section ──────────────────────────────────────────────────────────

describe("diffParses — dropped_section", () => {
  it("reports experience when heuristic has 0 and LLM has roles", () => {
    const r = diffParses(heuristic({ experience: [] }), llm({ experience: exp(3) }), []);
    const d = findKind(r, "experience");
    expect(d!.kind).toBe("dropped_section");
    expect(d!.heuristicValue).toBeNull();
    expect(d!.llmValue).toBe("3");
  });

  it("reports education whole-section drop", () => {
    const r = diffParses(heuristic({ education: [] }), llm({ education: edu(2) }), []);
    const d = findKind(r, "education");
    expect(d!.kind).toBe("dropped_section");
    expect(d!.llmValue).toBe("2");
  });

  it("reports skills whole-section drop", () => {
    const r = diffParses(
      heuristic({ skills: [] }),
      llm({ skills: ["Go", "Rust"] }),
      [],
    );
    const d = findKind(r, "skills");
    expect(d!.kind).toBe("dropped_section");
    expect(d!.llmValue).toBe("2");
  });

  it("does NOT report a section the heuristic also recovered", () => {
    const r = diffParses(
      heuristic({ education: edu(1) }),
      llm({ education: edu(1) }),
      [],
    );
    expect(findKind(r, "education")).toBeUndefined();
  });

  it("does NOT report a partial education gap (no kind for it by design)", () => {
    // Heuristic got 1, LLM got 3 — intentionally NOT reported. Education has no
    // partial-gap kind; only the whole-section vanish is honest to detect.
    const r = diffParses(
      heuristic({ education: edu(1) }),
      llm({ education: edu(3) }),
      [],
    );
    expect(findKind(r, "education")).toBeUndefined();
  });
});

// ── dropped_section credibility guard (section-presence) ─────────────────────

describe("diffParses — dropped_section credibility guard", () => {
  const none: ReadonlySet<SectionName> = new Set();

  it("SUPPRESSES a skills drop when no skills header exists and no trigger is active", () => {
    // The repro: clean extraction (no triggers), no skills section on the page,
    // but the LLM mined 4 technologies out of experience/summary prose.
    const r = rawDiffParses(
      heuristic({ skills: [] }),
      llm({ skills: ["Go", "Rust", "TS", "Py"] }),
      [],
      none,
    );
    expect(findKind(r, "skills")).toBeUndefined();
  });

  it("REPORTS a skills drop when the sectioner found the header (extraction failed)", () => {
    const r = rawDiffParses(
      heuristic({ skills: [] }),
      llm({ skills: ["Go", "Rust"] }),
      [],
      new Set<SectionName>(["skills"]),
    );
    expect(findKind(r, "skills")?.kind).toBe("dropped_section");
  });

  it("REPORTS a skills drop with no header when a layout trigger ate it", () => {
    const r = rawDiffParses(
      heuristic({ skills: [] }),
      llm({ skills: ["Go"] }),
      ["fonts_unmappable"],
      none,
    );
    expect(findKind(r, "skills")?.kind).toBe("dropped_section");
  });

  it("SUPPRESSES experience and education drops the same way", () => {
    const r = rawDiffParses(
      heuristic({ experience: [], education: [] }),
      llm({ experience: exp(3), education: edu(2) }),
      [],
      none,
    );
    expect(findKind(r, "experience")).toBeUndefined();
    expect(findKind(r, "education")).toBeUndefined();
  });
});

// ── dropped_role vs merged_roles ─────────────────────────────────────────────

describe("diffParses — dropped_role vs merged_roles (partial experience gap)", () => {
  it("reports dropped_role when LLM has more roles and NO two_column", () => {
    const r = diffParses(
      heuristic({ experience: [{ title: "x", company: "y" }] }),
      llm({ experience: exp(4) }),
      [],
    );
    const d = findKind(r, "experience");
    expect(d!.kind).toBe("dropped_role");
    expect(d!.heuristicValue).toBe("1");
    expect(d!.llmValue).toBe("4");
  });

  it("reports merged_roles when two_column is active", () => {
    const r = diffParses(
      heuristic({ experience: [{ title: "x", company: "y" }] }),
      llm({ experience: exp(4) }),
      ["two_column"],
    );
    const d = findKind(r, "experience");
    expect(d!.kind).toBe("merged_roles");
    expect(d!.likelyCause).toBe("two_column");
  });

  it("does NOT report when counts are equal", () => {
    const r = diffParses(
      heuristic({ experience: exp(2) }),
      llm({ experience: exp(2) }),
      [],
    );
    expect(findKind(r, "experience")).toBeUndefined();
  });

  it("does NOT report when the heuristic recovered MORE roles than the LLM", () => {
    const r = diffParses(
      heuristic({ experience: exp(3) }),
      llm({ experience: exp(1) }),
      [],
    );
    expect(findKind(r, "experience")).toBeUndefined();
  });
});

// ── likelyCause correlation ──────────────────────────────────────────────────

describe("diffParses — likelyCause correlation", () => {
  it("omits likelyCause when no triggers are active", () => {
    const r = diffParses(heuristic({ experience: [] }), llm({ experience: exp(2) }), []);
    expect(findKind(r, "experience")!.likelyCause).toBeUndefined();
    expect("likelyCause" in findKind(r, "experience")!).toBe(false);
  });

  it("prefers two_column for an experience gap even when scanned is also set", () => {
    const triggers: LayoutTrigger[] = ["scanned", "two_column"];
    const r = diffParses(heuristic({ experience: exp(1) }), llm({ experience: exp(3) }), triggers);
    expect(findKind(r, "experience")!.likelyCause).toBe("two_column");
  });

  it("prefers scanned over two_column for a scalar field gap", () => {
    const triggers: LayoutTrigger[] = ["two_column", "scanned"];
    const r = diffParses(heuristic({ email: undefined }), llm({ email: "a@example.com" }), triggers);
    expect(findKind(r, "email")!.likelyCause).toBe("scanned");
  });

  it("falls back to fonts_unmappable when it is the only trigger", () => {
    const r = diffParses(
      heuristic({ skills: [] }),
      llm({ skills: ["Go"] }),
      ["fonts_unmappable"],
    );
    expect(findKind(r, "skills")!.likelyCause).toBe("fonts_unmappable");
  });
});

// ── No disagreement / ordering ───────────────────────────────────────────────

describe("diffParses — no disagreement & ordering", () => {
  it("returns empty array when the two parses agree", () => {
    const same = {
      full_name: "Jane Example",
      email: "jane@example.com",
      skills: ["TS"],
      experience: exp(2),
      education: edu(1),
    };
    const r = diffParses(
      heuristic(same),
      llm({ ...same, phone: null, location: null, summary: null }),
      [],
    );
    expect(r).toEqual([]);
  });

  it("returns scalar gaps before section gaps, in field order", () => {
    const r = diffParses(
      heuristic({ email: undefined, location: undefined, skills: [], experience: [] }),
      llm({
        email: "a@example.com",
        location: "NYC",
        skills: ["Go"],
        experience: exp(1),
      }),
      [],
    );
    expect(r.map((d) => d.field)).toEqual([
      "email",
      "location",
      "experience",
      "skills",
    ]);
  });

  it("is deterministic across repeated calls", () => {
    const h = heuristic({ experience: exp(1), email: undefined });
    const l = llm({ experience: exp(3), email: "a@example.com" });
    const triggers: LayoutTrigger[] = ["two_column"];
    expect(diffParses(h, l, triggers)).toEqual(diffParses(h, l, triggers));
  });
});

// ── Grounding gate: scalars (#1093) ─────────────────────────────────────────

describe("diffParses — grounding gate: scalars", () => {
  it("rejects an LLM scalar that never occurs in the grounding text", () => {
    const r = diffParses(
      heuristic({ email: undefined }),
      llm({ email: "ghost@example.com" }),
      [],
      ALL_SECTIONS,
      "Jane Example works at Acme Corp.",
    );
    expect(findKind(r, "email")).toBeUndefined();
  });

  it("accepts an LLM scalar that occurs verbatim in the grounding text", () => {
    const r = diffParses(
      heuristic({ email: undefined }),
      llm({ email: "jane@example.com" }),
      [],
      ALL_SECTIONS,
      "Contact: jane@example.com",
    );
    expect(findKind(r, "email")?.kind).toBe("missing_field");
  });

  it("ignores punctuation/case/whitespace differences when grounding", () => {
    const r = diffParses(
      heuristic({ phone: undefined }),
      llm({ phone: "(312) 555-0123" }),
      [],
      ALL_SECTIONS,
      "  PHONE:   (312) 555-0123 . ",
    );
    expect(findKind(r, "phone")?.kind).toBe("missing_field");
  });

  it("counts a rejected scalar toward rejectedUngrounded, without reporting it", () => {
    const heuristicCanonical = toCanonicalResume(
      heuristic({ email: undefined }),
      sectionsWithHeaders(ALL_SECTIONS),
      {},
    );
    const result = canonicalDiffParses(
      heuristicCanonical,
      projectLlmDiff(llm({ email: "ghost@example.com" })),
      [],
      "nothing relevant here",
    );
    expect(result.disagreements).toEqual([]);
    expect(result.rejectedUngrounded).toBe(1);
  });
});

// ── Grounding gate: summary n-gram threshold (#1093) ────────────────────────
//
// Pinned against the real `latex/multi-degree-coursework.pdf` fixture — the
// exact PDF #1093 was filed against — rather than a hand-written string, so a
// change to the threshold or the tokenizer is checked against real extracted
// markdown, not a string shaped to make the test pass.

describe("diffParses — grounding gate: summary n-gram threshold", () => {
  // Quoted verbatim from #1093: the shipped model's fabricated "recovered"
  // summary for this fixture, which states nowhere in the PDF.
  const FABRICATED_SUMMARY =
    "Software engineering intern with experience in machine learning, data structures, and cloud computing. Strong analytical skills and a passion for developing innovative solutions.";

  it("rejects the fabricated #1093 summary against the real fixture text", async () => {
    const bytes = readFileSync(
      "tests/fixtures/pdfs/latex/multi-degree-coursework.pdf",
    );
    const result = await runCascade(new Uint8Array(bytes));
    const groundingText = result.markdown ?? result.rawText;

    const r = diffParses(
      heuristic({ summary: undefined }),
      llm({ summary: FABRICATED_SUMMARY }),
      [],
      ALL_SECTIONS,
      groundingText,
    );
    expect(findKind(r, "summary")).toBeUndefined();
  });

  it("accepts a real summary drawn from a fixture that has one", async () => {
    const bytes = readFileSync(
      "tests/fixtures/pdfs/google-docs/google-docs-skia-proxy-classic.pdf",
    );
    const result = await runCascade(new Uint8Array(bytes));
    const groundingText = result.markdown ?? result.rawText;
    const realSummary = result.canonical.fields.summary;
    expect(realSummary).toBeTruthy();

    const r = diffParses(
      heuristic({ summary: undefined }),
      llm({ summary: realSummary! }),
      [],
      ALL_SECTIONS,
      groundingText,
    );
    expect(findKind(r, "summary")?.kind).toBe("missing_field");
    expect(findKind(r, "summary")?.llmValue).toBe(realSummary);
  });
});

// ── Grounding gate: location vs work authorization (#1093, #792, #837) ─────

describe("diffParses — grounding gate: location vs work authorization", () => {
  it("rejects a work-authorization statement recovered as a location", () => {
    // The real #1093 contact line: "973-555-0123 | jordan.bennett@example.com
    // | LinkedIn | GitHub | US Citizen" — a right-to-work statement, not a
    // locality (#792, #837).
    const r = diffParses(
      heuristic({ location: undefined }),
      llm({ location: "US Citizen" }),
      [],
      ALL_SECTIONS,
      "973-555-0123 | jordan.bennett@example.com | LinkedIn | GitHub | US Citizen",
    );
    expect(findKind(r, "location")).toBeUndefined();
  });

  it("accepts a real locality grounded in the text", () => {
    const r = diffParses(
      heuristic({ location: undefined }),
      llm({ location: "Bellevue, WA" }),
      [],
      ALL_SECTIONS,
      "Northwind Labs Bellevue, WA",
    );
    expect(findKind(r, "location")?.kind).toBe("missing_field");
    expect(findKind(r, "location")?.llmValue).toBe("Bellevue, WA");
  });

  it("rejects a work-authorization clause packed alongside other location prose", () => {
    // matchWorkAuthorization's patterns are anchored (^...$) and only ever see
    // one delimiter-split segment — a value like "US Citizen, open to
    // relocation" must be split before matching, or the isolated-phrase-only
    // check silently lets the statement through as a "missing location".
    const r = diffParses(
      heuristic({ location: undefined }),
      llm({ location: "US Citizen, open to relocation" }),
      [],
      ALL_SECTIONS,
      "973-555-0123 | jordan.bennett@example.com | US Citizen, open to relocation",
    );
    expect(findKind(r, "location")).toBeUndefined();
  });
});

// ── Grounding gate: roles vs projects (#1093) ───────────────────────────────

describe("diffParses — grounding gate: roles excluded by project name or ungrounded company", () => {
  it("does not count an LLM role whose company matches a heuristic project name", () => {
    const r = diffParses(
      heuristic({
        experience: [{ title: "Engineer", company: "Acme Corp" }],
        projects: [{ name: "tinylm | Link" }],
      }),
      llm({
        experience: [
          { company: "Acme Corp", title: "Engineer", description: "" },
          { company: "tinylm", title: "Project", description: "" },
        ],
      }),
      [],
      ALL_SECTIONS,
      "Acme Corp Engineer. tinylm | Link is a personal project.",
    );
    expect(findKind(r, "experience")).toBeUndefined();
  });

  it("does not count an LLM role whose company never occurs in the grounding text", () => {
    const r = diffParses(
      heuristic({ experience: [{ title: "Engineer", company: "Acme Corp" }] }),
      llm({
        experience: [
          { company: "Acme Corp", title: "Engineer", description: "" },
          { company: "Ghost Inc", title: "Engineer", description: "" },
        ],
      }),
      [],
      ALL_SECTIONS,
      "Acme Corp Engineer.",
    );
    expect(findKind(r, "experience")).toBeUndefined();
  });

  it("still reports dropped_role for grounded, non-project roles", () => {
    const r = diffParses(
      heuristic({
        experience: [{ title: "Engineer", company: "Acme Corp" }],
        projects: [{ name: "tinylm | Link" }],
      }),
      llm({
        experience: [
          { company: "Acme Corp", title: "Engineer", description: "" },
          { company: "Globex", title: "Engineer", description: "" },
          { company: "tinylm", title: "Project", description: "" },
        ],
      }),
      [],
      ALL_SECTIONS,
      "Acme Corp Engineer. Globex Engineer. tinylm | Link is a personal project.",
    );
    const d = findKind(r, "experience");
    expect(d!.kind).toBe("dropped_role");
    expect(d!.heuristicValue).toBe("1");
    expect(d!.llmValue).toBe("2");
  });

  it("does not let a degenerate project name (normalizes to empty) swallow every role", () => {
    // A project header line like "." survives `extractProjects` (it only
    // drops names equal to "" before normalization); `normalizeForGrounding(".")`
    // strips the trailing punctuation to "". Every company's normalized form
    // vacuously `.includes("")`, so an unfiltered empty entry would flag every
    // grounded role as "a project" and hide a real dropped_role gap.
    const r = diffParses(
      heuristic({
        experience: [{ title: "Engineer", company: "Acme Corp" }],
        projects: [{ name: "." }],
      }),
      llm({
        experience: [
          { company: "Acme Corp", title: "Engineer", description: "" },
          { company: "Globex", title: "Engineer", description: "" },
        ],
      }),
      [],
      ALL_SECTIONS,
      "Acme Corp Engineer. Globex Engineer.",
    );
    const d = findKind(r, "experience");
    expect(d!.kind).toBe("dropped_role");
    expect(d!.heuristicValue).toBe("1");
    expect(d!.llmValue).toBe("2");
  });

  it("reproduces the #1093 shape end-to-end against the real fixture", async () => {
    const bytes = readFileSync(
      "tests/fixtures/pdfs/latex/multi-degree-coursework.pdf",
    );
    const result = await runCascade(new Uint8Array(bytes));
    const groundingText = result.markdown ?? result.rawText;

    // Mirrors #1093: the shipped model reported the 4 real roles, the 3
    // projects (tinylm, bytetoken, Finance4Dummies) as more "roles", plus one
    // entry grounded nowhere at all.
    const llmParse: LlmParsedResume = {
      full_name: null,
      email: null,
      phone: null,
      location: "US Citizen",
      summary:
        "Software engineering intern with experience in machine learning, data structures, and cloud computing. Strong analytical skills and a passion for developing innovative solutions.",
      skills: [],
      experience: [
        { company: "Northwind Labs", title: "Software Engineering Intern on the Machine Learning Team", description: "" },
        { company: "Beacon Financial", title: "Software Engineering Intern", description: "" },
        { company: "Greenfield Studios", title: "Software Engineering Intern", description: "" },
        { company: "Meridian Analytics", title: "Software Engineering Intern", description: "" },
        { company: "tinylm", title: "Project", description: "" },
        { company: "bytetoken", title: "Project", description: "" },
        { company: "Finance4Dummies", title: "Project", description: "" },
        { company: "Ghost Corp", title: "Extra", description: "" },
      ],
      education: [],
    };

    const result2 = canonicalDiffParses(
      result.canonical,
      projectLlmDiff(llmParse),
      result.triggers,
      groundingText,
    );
    expect(result2.disagreements.find((d) => d.field === "summary")).toBeUndefined();
    expect(result2.disagreements.find((d) => d.field === "location")).toBeUndefined();
    expect(result2.disagreements.find((d) => d.field === "experience")).toBeUndefined();
    expect(result2.rejectedUngrounded).toBeGreaterThan(0);
  });
});
