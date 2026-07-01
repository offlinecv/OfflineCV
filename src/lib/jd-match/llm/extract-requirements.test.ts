// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for extractRequirements (#200), driven by a canned model stub —
 * no WebGPU, so this ships full CI coverage. Covers the happy path + coercion,
 * the tolerant-parse recovery, the empty-array-is-not-a-failure distinction,
 * and every hard-failure path (malformed JSON, non-array, engine throw).
 */

import { describe, it, expect, vi } from "vitest";
import {
  extractRequirements,
  RequirementExtractionError,
} from "./extract-requirements.ts";
import type { WebLlmEngine } from "../../webllm/types.ts";

/** A stub engine that returns `responses` in call order (empty string after). */
function makeMockEngine(responses: string[]): WebLlmEngine {
  let i = 0;
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          const content = responses[i] ?? "";
          i++;
          return { choices: [{ message: { content } }] };
        }),
      },
    },
  };
}

/** A stub engine whose create() always rejects. */
function makeThrowingEngine(err: Error): WebLlmEngine {
  return {
    chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
  };
}

describe("extractRequirements", () => {
  it("returns a typed JdRequirement[] from a valid array", async () => {
    const engine = makeMockEngine([
      JSON.stringify([
        { id: "req-1", kind: "skill", text: "5+ years of TypeScript", years: 5 },
        { id: "req-2", kind: "qualification", text: "BS in Computer Science" },
      ]),
    ]);
    const reqs = await extractRequirements("jd text", engine);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toEqual({
      id: "req-1",
      kind: "skill",
      text: "5+ years of TypeScript",
      years: 5,
    });
    // years omitted on the source → no years key at all.
    expect("years" in reqs[1]!).toBe(false);
  });

  it("recovers an array from fenced + prose-wrapped output", async () => {
    const engine = makeMockEngine([
      'Sure!\n```json\n[{"id":"req-1","kind":"responsibility","text":"Lead the team"}]\n```\nDone.',
    ]);
    await expect(extractRequirements("jd", engine)).resolves.toEqual([
      { id: "req-1", kind: "responsibility", text: "Lead the team" },
    ]);
  });

  it("returns [] for a valid empty array (no requirements is not a failure)", async () => {
    const engine = makeMockEngine(["[]"]);
    await expect(extractRequirements("jd", engine)).resolves.toEqual([]);
  });

  it("throws RequirementExtractionError on malformed JSON", async () => {
    const engine = makeMockEngine(["not json at all"]);
    await expect(extractRequirements("jd", engine)).rejects.toBeInstanceOf(
      RequirementExtractionError,
    );
  });

  it("throws when the model returns a non-array JSON value", async () => {
    const engine = makeMockEngine(['{"id":"req-1","text":"x"}']);
    await expect(extractRequirements("jd", engine)).rejects.toBeInstanceOf(
      RequirementExtractionError,
    );
  });

  it("throws when the engine call fails", async () => {
    const engine = makeThrowingEngine(new Error("OOM"));
    await expect(extractRequirements("jd", engine)).rejects.toBeInstanceOf(
      RequirementExtractionError,
    );
  });

  it("defaults an unknown kind to 'skill' and assigns a sequential id", async () => {
    const engine = makeMockEngine([
      JSON.stringify([{ kind: "bogus", text: "Ship features" }]),
    ]);
    const reqs = await extractRequirements("jd", engine);
    expect(reqs[0]).toEqual({ id: "req-1", kind: "skill", text: "Ship features" });
  });

  it("drops unusable entries and renumbers survivors as contiguous req-N", async () => {
    // The model's own ids ("req-1", "req-7") are ignored — ids come from the
    // OUTPUT position so the extract → judge join key is always contiguous.
    const engine = makeMockEngine([
      JSON.stringify([
        { id: "req-1", kind: "skill", text: "" },
        { id: "req-7", kind: "skill", text: "Go" },
        "garbage",
        { kind: "skill" },
      ]),
    ]);
    await expect(extractRequirements("jd", engine)).resolves.toEqual([
      { id: "req-1", kind: "skill", text: "Go" },
    ]);
  });

  it("puts the rules in system and the JD (only) in the user message", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ choices: [{ message: { content: "[]" } }] });
    const engine: WebLlmEngine = { chat: { completions: { create } } };
    await extractRequirements("PASTED JD BODY", engine);
    const req = create.mock.calls[0]![0];
    expect(req.messages[0].role).toBe("system");
    expect(req.messages[1].role).toBe("user");
    expect(req.messages[1].content).toContain("PASTED JD BODY");
    expect(req.messages[0].content).not.toContain("PASTED JD BODY");
    expect(req.temperature).toBe(0);
  });
});
