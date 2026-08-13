// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

describe("extractRequirements — cancellation (#803)", () => {
  it("pre-call check: an already-aborted signal skips the engine entirely", async () => {
    // The whole point of the pre-check: avoid starting the expensive
    // completion at all if the run has already been superseded. If this
    // check is removed, the engine.chat.completions.create call still fires,
    // and the wasted work bound is broken.
    const create = vi.fn();
    const engine: WebLlmEngine = { chat: { completions: { create } } };
    const controller = new AbortController();
    controller.abort();

    await expect(
      extractRequirements("jd", engine, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(create).not.toHaveBeenCalled();
  });

  it("post-call check: abort during the completion skips coercion and throws AbortError", async () => {
    // The completion itself finishes (we can't safely interrupt a shared
    // engine), but nothing downstream — coercion, and by extension the
    // orchestrator's judge call — runs. AbortError is distinct from
    // RequirementExtractionError so the orchestrator can suppress the
    // console.warn on cancellation.
    const controller = new AbortController();
    const create = vi.fn().mockImplementation(async () => {
      controller.abort();
      return {
        choices: [
          {
            message: {
              content: JSON.stringify([
                { id: "req-1", kind: "skill", text: "TypeScript" },
              ]),
            },
          },
        ],
      };
    });
    const engine: WebLlmEngine = { chat: { completions: { create } } };

    await expect(
      extractRequirements("jd", engine, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    // Engine WAS called — that's the bounded work per #803's residual bound.
    expect(create).toHaveBeenCalledOnce();
  });

  it("does NOT wrap an AbortError from the engine call as RequirementExtractionError", async () => {
    // Preserves the orchestrator's ability to distinguish cancellation from
    // a real extraction failure via `err.name === "AbortError"`. If wrapping
    // happens, the orchestrator would log "semantic path failed" over a
    // cancellation we initiated — the exact behavior #803 forbids.
    //
    // The signal must fire DURING the call, not before it: an already-aborted
    // signal is caught by the pre-call check, which throws its own AbortError
    // and never enters the try — so both assertions would pass without the
    // re-throw under test even existing.
    const abortErr = new DOMException("aborted", "AbortError");
    const controller = new AbortController();
    const create = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(abortErr);
    });
    const engine: WebLlmEngine = { chat: { completions: { create } } };

    // Identity, not shape: the engine's OWN error must come back untouched.
    // `toMatchObject({name:"AbortError"})` would also pass on the AbortError
    // the pre-call check throws, which is what made the earlier version of
    // this test vacuous.
    await expect(
      extractRequirements("jd", engine, controller.signal),
    ).rejects.toBe(abortErr);
    expect(create).toHaveBeenCalledOnce();
    // Not a RequirementExtractionError — that would break the orchestrator's
    // catch-branch distinction.
    expect(abortErr).not.toBeInstanceOf(RequirementExtractionError);
  });

  it("WRAPS an engine AbortError when our signal never fired", async () => {
    // The `signal?.aborted` half of the re-throw guard. `isAbortError` is a
    // pure shape check, so an engine-originated error merely NAMED
    // "AbortError" — a future per-request timeout, a device-lost surfaced
    // this way — would otherwise be re-thrown into the orchestrator's SILENT
    // cancellation branch: degraded to keyword with the `[run-llm-match]
    // semantic path failed` warn deliberately skipped, leaving no diagnostic
    // trail for a failure we did not cause.
    const abortErr = new DOMException("engine timeout", "AbortError");
    const engine: WebLlmEngine = {
      chat: {
        completions: { create: vi.fn().mockRejectedValue(abortErr) },
      },
    };
    // Live, never-fired signal — the run was not cancelled by us.
    const controller = new AbortController();

    await expect(
      extractRequirements("jd", engine, controller.signal),
    ).rejects.toBeInstanceOf(RequirementExtractionError);
  });

  it("no signal (legacy 2-arg call): behavior unchanged, no aborts anywhere", async () => {
    // Every pre-#803 caller passes just (jdText, engine). The `signal?`
    // optionality has to leave that path byte-identical to pre-#803.
    const engine = makeMockEngine([
      JSON.stringify([{ id: "req-1", kind: "skill", text: "TypeScript" }]),
    ]);
    await expect(extractRequirements("jd", engine)).resolves.toEqual([
      { id: "req-1", kind: "skill", text: "TypeScript" },
    ]);
  });
});
