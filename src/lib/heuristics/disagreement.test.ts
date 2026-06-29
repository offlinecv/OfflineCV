// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for diffParses (issue #242).
 *
 * Pure function — no engine, no DOM. Covers every disagreement kind and its
 * edge cases:
 *   - missing_field: each scalar (full_name/email/phone/location/summary),
 *     null/undefined/blank on the heuristic side, reverse direction ignored
 *   - dropped_section: experience / education / skills whole-section drop
 *   - dropped_role vs merged_roles: partial experience gap, disambiguated by
 *     the two_column trigger
 *   - likelyCause correlation + kind-aware trigger priority
 *   - no-disagreement cases (equal/heuristic-richer)
 *   - ordering + the partial-education non-report rationale
 */

import { describe, it, expect } from "vitest";
import { diffParses as rawDiffParses, type ParseDisagreement } from "./disagreement.ts";
import type { HeuristicParsedResume, LayoutTrigger } from "./types.ts";
import type { SectionName } from "./sections.config.ts";
import type { LlmParsedResume } from "../webllm/parse-resume.ts";

// All gateable sections present by default — most cases below exercise drop
// *detection*, not the section-presence guard (that has its own describe block).
// Tests that probe the guard call `rawDiffParses` directly with an explicit set.
const ALL_SECTIONS: ReadonlySet<SectionName> = new Set([
  "experience",
  "education",
  "skills",
]);

function diffParses(
  heuristic: HeuristicParsedResume,
  llm: LlmParsedResume,
  triggers: LayoutTrigger[],
  presentSections: ReadonlySet<SectionName> = ALL_SECTIONS,
): ParseDisagreement[] {
  return rawDiffParses(heuristic, llm, triggers, presentSections);
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
