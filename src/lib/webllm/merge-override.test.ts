// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * mergeLlmParse (#243) — folds an LLM-recovered parse into the cascade result.
 *
 * Covers: scalar fields fall back to the original when the LLM omitted them;
 * list fields only replace when the LLM returned at least one entry;
 * `suggestedEscalation` is cleared; non-parse fields (rawText/markdown/layout)
 * stay original.
 */

import { describe, it, expect } from "vitest";
import { mergeLlmParse } from "./merge-override.ts";
import type { LlmParsedResume } from "./parse-resume.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { toCanonicalResume } from "../heuristics/canonical.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import type { SectionName } from "../heuristics/regex.ts";

function sectioned(): SectionedResume {
  const byName = new Map<SectionName | "profile", readonly string[]>([
    ["experience", ["orig bullet"]],
  ]);
  return { byName, accomplishmentSections: ["experience"], source: "regex" };
}

function baseResult(): CascadeResult {
  return {
    canonical: toCanonicalResume(
      {
      full_name: "Orig Name",
      email: "orig@example.com",
      phone: "(312) 555-0123",
      location: "Orig City",
      summary: "orig summary",
      skills: ["orig-skill"],
      experience: [
        {
          company: "Orig Co",
          title: "Orig Title",
          description: "orig desc",
          is_current: true,
        },
      ],
      education: [{ institution: "Orig U", degree: "BS" }],
      },
      sectioned(),
      {},
    ),
    confidence: 0.4,
    triggers: ["two_column"],
    suggestedEscalation: "llm",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "ORIG RAW",
    markdown: "ORIG MD",
    linkAnnotations: [],
    diagnostics: {
      rawCharCount: 100,
      extractedCharCount: 20,
      pages: 1,
      elapsedMs: 5,
    },
    timings: { t0_layout_ms: 1, t1_openresume_ms: 1 },
  };
}

function llm(over: Partial<LlmParsedResume> = {}): LlmParsedResume {
  return {
    full_name: null,
    email: null,
    phone: null,
    location: null,
    summary: null,
    skills: [],
    experience: [],
    education: [],
    ...over,
  };
}

describe("mergeLlmParse", () => {
  it("overrides scalar fields when the LLM provides them", () => {
    const merged = mergeLlmParse(
      baseResult(),
      llm({ full_name: "LLM Name", email: "llm@example.com" }),
    );
    expect(merged.canonical.fields.full_name).toBe("LLM Name");
    expect(merged.canonical.fields.email).toBe("llm@example.com");
    // Untouched scalar falls back to original.
    expect(merged.canonical.fields.location).toBe("Orig City");
  });

  it("keeps original list fields when the LLM returns none", () => {
    const merged = mergeLlmParse(baseResult(), llm());
    expect(merged.canonical.fields.skills).toEqual(["orig-skill"]);
    expect(merged.canonical.fields.experience).toHaveLength(1);
    expect(merged.canonical.fields.experience[0]!.company).toBe("Orig Co");
    expect(merged.canonical.fields.education[0]!.institution).toBe("Orig U");
  });

  it("replaces list fields when the LLM returns entries, normalizing shape", () => {
    const merged = mergeLlmParse(
      baseResult(),
      llm({
        skills: ["llm-skill"],
        experience: [
          { company: "LLM Co", title: "LLM Title", description: "llm desc" },
        ],
        education: [{ institution: "LLM U", degree: "MS" }],
      }),
    );
    expect(merged.canonical.fields.skills).toEqual(["llm-skill"]);
    expect(merged.canonical.fields.experience[0]).toEqual({
      company: "LLM Co",
      title: "LLM Title",
      description: "llm desc",
      is_current: false,
    });
    expect(merged.canonical.fields.education[0]).toEqual({
      institution: "LLM U",
      degree: "MS",
    });
  });

  it("clears the escalation flag and preserves non-parse fields", () => {
    const merged = mergeLlmParse(baseResult(), llm({ full_name: "X" }));
    expect(merged.suggestedEscalation).toBe("none");
    expect(merged.rawText).toBe("ORIG RAW");
    expect(merged.markdown).toBe("ORIG MD");
    expect(merged.triggers).toEqual(["two_column"]);
  });
});
