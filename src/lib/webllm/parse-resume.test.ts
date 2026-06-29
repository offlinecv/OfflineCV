// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for parseResumeWithLlm (issue #241).
 *
 * All tests use a stub WebLlmEngine — no real model, no WebGPU.
 * Covers:
 *   - Strict valid JSON → correct LlmParsedResume
 *   - Fenced ```json block → repaired correctly
 *   - JSON embedded in prose → bracket-extracted
 *   - Garbage / empty → safe empty shape, no throw
 *   - Shape coercion: missing fields, wrong-typed skills, partial experience
 *   - Prefers markdown over rawText in the prompt
 *   - Engine error → safe empty shape, no throw
 */

import { describe, it, expect, vi } from "vitest";
import { parseResumeWithLlm } from "./parse-resume.ts";
import type { WebLlmEngine } from "./types.ts";
import type { LlmParsedResume } from "./parse-resume.ts";

// ---------------------------------------------------------------------------
// Stub engine factory
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Expected safe empty shape
// ---------------------------------------------------------------------------

const EMPTY_SHAPE: LlmParsedResume = {
  full_name: null,
  email: null,
  phone: null,
  location: null,
  summary: null,
  skills: [],
  experience: [],
  education: [],
};

// ---------------------------------------------------------------------------
// Full valid fixture
// ---------------------------------------------------------------------------

const VALID_PARSED: LlmParsedResume = {
  full_name: "Alex Rivera",
  email: "alex.rivera@example.com",
  phone: "(312) 555-0142",
  location: "Chicago, IL",
  summary: "Software engineer with 5 years of experience in distributed systems.",
  skills: ["Python", "Go", "PostgreSQL", "Kubernetes"],
  experience: [
    {
      company: "Meridian Tech",
      title: "Senior Software Engineer",
      description: "Led backend API development for a platform serving 10M users.",
    },
  ],
  education: [
    {
      institution: "Fenwick State University",
      degree: "B.S. Computer Science",
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests: JSON parse paths
// ---------------------------------------------------------------------------

describe("parseResumeWithLlm — JSON parse paths", () => {
  it("returns correct shape for strict valid JSON", async () => {
    const engine = makeEngine(JSON.stringify(VALID_PARSED));
    const result = await parseResumeWithLlm({ rawText: "some resume" }, engine);
    expect(result).toEqual(VALID_PARSED);
  });

  it("repairs fenced ```json block", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_PARSED) + "\n```";
    const engine = makeEngine(fenced);
    const result = await parseResumeWithLlm({ rawText: "some resume" }, engine);
    expect(result).toEqual(VALID_PARSED);
  });

  it("repairs bare ``` block (no language tag)", async () => {
    const fenced = "```\n" + JSON.stringify(VALID_PARSED) + "\n```";
    const engine = makeEngine(fenced);
    const result = await parseResumeWithLlm({ rawText: "some resume" }, engine);
    expect(result).toEqual(VALID_PARSED);
  });

  it("extracts JSON embedded in prose", async () => {
    const prose =
      "Here is the parsed result: " +
      JSON.stringify(VALID_PARSED) +
      " That's all.";
    const engine = makeEngine(prose);
    const result = await parseResumeWithLlm({ rawText: "some resume" }, engine);
    expect(result).toEqual(VALID_PARSED);
  });

  it("extracts the balanced object when trailing prose contains a brace", async () => {
    // Regression: a greedy `/\{[\s\S]*\}/` would run to the brace in the
    // trailing note and fail to parse, silently dropping valid output.
    const out =
      "```json\n" +
      JSON.stringify(VALID_PARSED) +
      "\n```\nNote: replace {name} with the candidate's name.";
    const engine = makeEngine(out);
    const result = await parseResumeWithLlm({ rawText: "some resume" }, engine);
    expect(result).toEqual(VALID_PARSED);
  });

  it("returns safe empty shape when output is a JSON array", async () => {
    const engine = makeEngine(JSON.stringify(["Python", "Go"]));
    const result = await parseResumeWithLlm({ rawText: "some resume" }, engine);
    expect(result).toEqual(EMPTY_SHAPE);
  });

  it("returns safe empty shape for garbage output", async () => {
    const engine = makeEngine("not json at all!!!");
    const result = await parseResumeWithLlm({ rawText: "some resume" }, engine);
    expect(result).toEqual(EMPTY_SHAPE);
  });

  it("returns safe empty shape for empty string output", async () => {
    const engine = makeEngine("");
    const result = await parseResumeWithLlm({ rawText: "some resume" }, engine);
    expect(result).toEqual(EMPTY_SHAPE);
  });

  it("does not throw on garbage output", async () => {
    const engine = makeEngine("{invalid json");
    await expect(parseResumeWithLlm({ rawText: "some resume" }, engine)).resolves.toEqual(
      EMPTY_SHAPE,
    );
  });

  it("returns safe empty shape when engine throws", async () => {
    const engine = makeThrowingEngine(new Error("OOM"));
    const result = await parseResumeWithLlm({ rawText: "some resume" }, engine);
    expect(result).toEqual(EMPTY_SHAPE);
  });

  it("does not throw when engine throws", async () => {
    const engine = makeThrowingEngine(new Error("context window exceeded"));
    await expect(parseResumeWithLlm({ rawText: "some resume" }, engine)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: shape coercion
// ---------------------------------------------------------------------------

describe("parseResumeWithLlm — shape coercion", () => {
  it("coerces missing scalar fields to null", async () => {
    // Only full_name and email present; rest missing
    const partial = JSON.stringify({ full_name: "Alex", email: "alex@example.com" });
    const engine = makeEngine(partial);
    const result = await parseResumeWithLlm({ rawText: "resume" }, engine);
    expect(result.full_name).toBe("Alex");
    expect(result.email).toBe("alex@example.com");
    expect(result.phone).toBeNull();
    expect(result.location).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.skills).toEqual([]);
    expect(result.experience).toEqual([]);
    expect(result.education).toEqual([]);
  });

  it("filters non-string values from skills array", async () => {
    const obj = {
      ...EMPTY_SHAPE,
      skills: ["Python", 42, null, "Go", true, "  ", "Kubernetes"],
    };
    const engine = makeEngine(JSON.stringify(obj));
    const result = await parseResumeWithLlm({ rawText: "resume" }, engine);
    // Non-strings and whitespace-only strings are dropped
    expect(result.skills).toEqual(["Python", "Go", "Kubernetes"]);
  });

  it("returns empty skills when skills is not an array", async () => {
    const obj = { ...EMPTY_SHAPE, skills: "Python, Go" };
    const engine = makeEngine(JSON.stringify(obj));
    const result = await parseResumeWithLlm({ rawText: "resume" }, engine);
    expect(result.skills).toEqual([]);
  });

  it("coerces missing experience subfields to empty string", async () => {
    const obj = {
      ...EMPTY_SHAPE,
      experience: [
        { company: "Acme" }, // missing title and description
      ],
    };
    const engine = makeEngine(JSON.stringify(obj));
    const result = await parseResumeWithLlm({ rawText: "resume" }, engine);
    expect(result.experience).toEqual([{ company: "Acme", title: "", description: "" }]);
  });

  it("filters non-object items from experience array", async () => {
    const obj = {
      ...EMPTY_SHAPE,
      experience: [
        null,
        "not an object",
        { company: "Acme", title: "Dev", description: "Did things." },
      ],
    };
    const engine = makeEngine(JSON.stringify(obj));
    const result = await parseResumeWithLlm({ rawText: "resume" }, engine);
    expect(result.experience).toHaveLength(1);
    expect(result.experience[0]?.company).toBe("Acme");
  });

  it("coerces missing education subfields to empty string", async () => {
    const obj = {
      ...EMPTY_SHAPE,
      education: [
        { institution: "Fenwick U" }, // missing degree
      ],
    };
    const engine = makeEngine(JSON.stringify(obj));
    const result = await parseResumeWithLlm({ rawText: "resume" }, engine);
    expect(result.education).toEqual([{ institution: "Fenwick U", degree: "" }]);
  });

  it("returns safe shape when top-level value is not an object", async () => {
    const engine = makeEngine(JSON.stringify([1, 2, 3]));
    const result = await parseResumeWithLlm({ rawText: "resume" }, engine);
    expect(result).toEqual(EMPTY_SHAPE);
  });

  it("trims whitespace from scalar fields", async () => {
    const obj = { ...EMPTY_SHAPE, full_name: "  Alex Rivera  ", email: "  a@b.com  " };
    const engine = makeEngine(JSON.stringify(obj));
    const result = await parseResumeWithLlm({ rawText: "resume" }, engine);
    expect(result.full_name).toBe("Alex Rivera");
    expect(result.email).toBe("a@b.com");
  });

  it("coerces whitespace-only scalar to null", async () => {
    const obj = { ...EMPTY_SHAPE, full_name: "   " };
    const engine = makeEngine(JSON.stringify(obj));
    const result = await parseResumeWithLlm({ rawText: "resume" }, engine);
    expect(result.full_name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: prompt input preference
// ---------------------------------------------------------------------------

describe("parseResumeWithLlm — prompt input preference", () => {
  it("uses markdown when both markdown and rawText are provided", async () => {
    const engine = makeEngine(JSON.stringify(EMPTY_SHAPE));
    const createSpy = engine.chat.completions.create as ReturnType<typeof vi.fn>;

    await parseResumeWithLlm(
      { rawText: "raw text content", markdown: "## Experience\n- Did things" },
      engine,
    );

    expect(createSpy).toHaveBeenCalledOnce();
    const [callArg] = createSpy.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
    const userMessage = callArg.messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("## Experience");
    expect(userMessage?.content).not.toContain("raw text content");
  });

  it("falls back to rawText when no markdown provided", async () => {
    const engine = makeEngine(JSON.stringify(EMPTY_SHAPE));
    const createSpy = engine.chat.completions.create as ReturnType<typeof vi.fn>;

    await parseResumeWithLlm({ rawText: "only raw text" }, engine);

    const [callArg] = createSpy.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
    const userMessage = callArg.messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("only raw text");
  });

  it("sends temperature=0 for deterministic output", async () => {
    const engine = makeEngine(JSON.stringify(EMPTY_SHAPE));
    const createSpy = engine.chat.completions.create as ReturnType<typeof vi.fn>;

    await parseResumeWithLlm({ rawText: "resume" }, engine);

    const [callArg] = createSpy.mock.calls[0] as [{ temperature: number }];
    expect(callArg.temperature).toBe(0);
  });
});
