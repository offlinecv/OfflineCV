// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for analyzeResumeWithLlm — the combined parse+critique inference
 * (issue #262). Every test stubs the engine so no model download is needed.
 *
 * Coverage:
 *   - Single inference call (the whole point of the issue).
 *   - Strict valid JSON → both halves populated correctly.
 *   - Fenced ```json + prose → repaired via the shared json-repair ladder.
 *   - Partial-result tolerance:
 *       * malformed critique half → parse half still returned.
 *       * malformed parse half → critique half still returned.
 *   - Garbage / empty output → safe empty shapes for both halves, no throw.
 *   - Engine throw → safe empty shapes, no throw.
 *   - Prefers markdown over rawText in the user prompt.
 */

import { describe, it, expect, vi } from "vitest";
import {
  analyzeResumeWithLlm,
  type CombinedAnalysis,
} from "./analyze-resume.ts";
import type { WebLlmEngine, ChatCompletionRequest } from "./types.ts";

// ── Engine factories ──────────────────────────────────────────────────────────

function makeEngine(content: string): WebLlmEngine {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  };
}

function makeThrowingEngine(err: unknown): WebLlmEngine {
  return {
    chat: {
      completions: {
        create: vi.fn().mockRejectedValue(err),
      },
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Wire-shape (flat) fixture the mock engine returns. The schema is intentionally
 * flat (top-level scalars + arrays + snake_case critique keys) per the Run 3
 * prompt redesign for issue #262 — see SYSTEM_PROMPT in analyze-resume.ts. The
 * coercer re-keys this to the public `CombinedAnalysis { parse, critique }`
 * shape under `EXPECTED_FULL` below.
 */
const FULL_VALID_WIRE = {
  full_name: "Alex Rivera",
  email: "alex@example.com",
  phone: "(312) 555-0142",
  location: "Chicago, IL",
  summary: "Senior engineer focused on distributed systems.",
  skills: ["Python", "Go", "PostgreSQL"],
  experience: [
    {
      company: "Meridian Tech",
      title: "Senior Engineer",
      description: "Led backend API development.",
    },
  ],
  education: [{ institution: "State U", degree: "B.S. CS" }],
  bullet_findings: [
    {
      bullet: "Led backend API development",
      issue: "no_quantification",
      suggestion:
        "Led migration of 12 services to Kubernetes, reducing deploy time 40%",
    },
  ],
  missing_sections: [],
  summary_feedback: "Summary is clear but could mention team scale.",
};

const EXPECTED_FULL: CombinedAnalysis = {
  parse: {
    full_name: "Alex Rivera",
    email: "alex@example.com",
    phone: "(312) 555-0142",
    location: "Chicago, IL",
    summary: "Senior engineer focused on distributed systems.",
    skills: ["Python", "Go", "PostgreSQL"],
    experience: [
      {
        company: "Meridian Tech",
        title: "Senior Engineer",
        description: "Led backend API development.",
      },
    ],
    education: [{ institution: "State U", degree: "B.S. CS" }],
  },
  critique: {
    bulletFindings: [
      {
        bullet: "Led backend API development",
        issue: "no_quantification",
        suggestion:
          "Led migration of 12 services to Kubernetes, reducing deploy time 40%",
      },
    ],
    missingSections: [],
    summaryFeedback: "Summary is clear but could mention team scale.",
  },
};

const EMPTY_COMBINED: CombinedAnalysis = {
  parse: {
    full_name: null,
    email: null,
    phone: null,
    location: null,
    summary: null,
    skills: [],
    experience: [],
    education: [],
  },
  critique: { bulletFindings: [], missingSections: [] },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("analyzeResumeWithLlm", () => {
  it("issues exactly ONE engine call (the whole point of #262)", async () => {
    const engine = makeEngine(JSON.stringify(FULL_VALID_WIRE));
    await analyzeResumeWithLlm({ rawText: "resume text" }, engine);
    expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("returns both halves on strict valid JSON", async () => {
    const engine = makeEngine(JSON.stringify(FULL_VALID_WIRE));
    const result = await analyzeResumeWithLlm({ rawText: "resume text" }, engine);
    expect(result).toEqual(EXPECTED_FULL);
  });

  it("repairs ```json fences and surrounding prose", async () => {
    const fenced = "Sure, here it is:\n```json\n" + JSON.stringify(FULL_VALID_WIRE) + "\n```\nLet me know.";
    const engine = makeEngine(fenced);
    const result = await analyzeResumeWithLlm({ rawText: "resume text" }, engine);
    expect(result.parse.full_name).toBe("Alex Rivera");
    expect(result.critique.bulletFindings).toHaveLength(1);
  });

  it("partial tolerance: critique fields malformed → parse kept, critique empty", async () => {
    // Parse half present; critique wire keys point at wrong-typed values.
    const partial = {
      ...FULL_VALID_WIRE,
      bullet_findings: "not an array",
      missing_sections: 42,
      summary_feedback: 99,
    };
    const engine = makeEngine(JSON.stringify(partial));
    const result = await analyzeResumeWithLlm({ rawText: "resume text" }, engine);
    expect(result.parse.full_name).toBe("Alex Rivera");
    expect(result.critique).toEqual({ bulletFindings: [], missingSections: [] });
  });

  it("partial tolerance: parse fields malformed → critique kept, parse empty", async () => {
    // Critique half present; parse wire keys point at wrong-typed values so the
    // shape-coercion drops them. Skills/experience/education stay as arrays
    // because [] is the safe default and a non-array maps to [].
    const partial = {
      full_name: 42,
      email: 42,
      phone: 42,
      location: 42,
      summary: 42,
      skills: "not an array",
      experience: 42,
      education: 42,
      bullet_findings: FULL_VALID_WIRE.bullet_findings,
      missing_sections: FULL_VALID_WIRE.missing_sections,
      summary_feedback: FULL_VALID_WIRE.summary_feedback,
    };
    const engine = makeEngine(JSON.stringify(partial));
    const result = await analyzeResumeWithLlm({ rawText: "resume text" }, engine);
    expect(result.parse).toEqual(EMPTY_COMBINED.parse);
    expect(result.critique.bulletFindings).toHaveLength(1);
  });

  it("partial tolerance: skips malformed bullet_findings entries without dropping the list", async () => {
    const partial = {
      ...FULL_VALID_WIRE,
      bullet_findings: [
        { bullet: "good", issue: "weak_verb" },
        "not an object", // skipped
        null, // skipped
        { bullet: "also good", issue: "ok" },
      ],
    };
    const engine = makeEngine(JSON.stringify(partial));
    const result = await analyzeResumeWithLlm({ rawText: "resume text" }, engine);
    expect(result.critique.bulletFindings).toHaveLength(2);
    expect(result.critique.bulletFindings[0]!.bullet).toBe("good");
    expect(result.critique.bulletFindings[1]!.bullet).toBe("also good");
  });

  it("returns safe empty shapes on garbage output (no throw)", async () => {
    const engine = makeEngine("definitely not json at all");
    const result = await analyzeResumeWithLlm({ rawText: "resume text" }, engine);
    expect(result).toEqual(EMPTY_COMBINED);
  });

  it("returns safe empty shapes when the engine throws (no throw to caller)", async () => {
    const engine = makeThrowingEngine(new Error("OOM"));
    const result = await analyzeResumeWithLlm({ rawText: "resume text" }, engine);
    expect(result).toEqual(EMPTY_COMBINED);
  });

  it("prefers markdown over rawText in the user prompt", async () => {
    const engine = makeEngine(JSON.stringify(FULL_VALID_WIRE));
    await analyzeResumeWithLlm(
      { rawText: "RAW", markdown: "MARKDOWN" },
      engine,
    );
    const call = (engine.chat.completions.create as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as ChatCompletionRequest;
    const userMsg = call.messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("MARKDOWN");
    expect(userMsg!.content).not.toContain("RAW");
  });

  it("falls back to rawText when markdown is absent", async () => {
    const engine = makeEngine(JSON.stringify(FULL_VALID_WIRE));
    await analyzeResumeWithLlm({ rawText: "ONLY-RAW" }, engine);
    const call = (engine.chat.completions.create as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as ChatCompletionRequest;
    const userMsg = call.messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("ONLY-RAW");
  });
});
