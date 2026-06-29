// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
    parsed: {
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
    confidence: 0.4,
    fieldConfidence: {},
    triggers: ["two_column"],
    suggestedEscalation: "llm",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: "ORIG RAW",
    markdown: "ORIG MD",
    sections: sectioned(),
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
    expect(merged.parsed.full_name).toBe("LLM Name");
    expect(merged.parsed.email).toBe("llm@example.com");
    // Untouched scalar falls back to original.
    expect(merged.parsed.location).toBe("Orig City");
  });

  it("keeps original list fields when the LLM returns none", () => {
    const merged = mergeLlmParse(baseResult(), llm());
    expect(merged.parsed.skills).toEqual(["orig-skill"]);
    expect(merged.parsed.experience).toHaveLength(1);
    expect(merged.parsed.experience[0]!.company).toBe("Orig Co");
    expect(merged.parsed.education[0]!.institution).toBe("Orig U");
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
    expect(merged.parsed.skills).toEqual(["llm-skill"]);
    expect(merged.parsed.experience[0]).toEqual({
      company: "LLM Co",
      title: "LLM Title",
      description: "llm desc",
      is_current: false,
    });
    expect(merged.parsed.education[0]).toEqual({
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
