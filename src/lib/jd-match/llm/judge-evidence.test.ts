// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for judgeEvidence (#201), driven by a canned model stub — no
 * WebGPU. Covers the happy path + coercion, the batch boundary (call count +
 * inference-guard balance), id reconciliation (missing filled, invented ids
 * ignored), and graceful degradation on parse/engine failure. The inference
 * guard is mocked so acquire/release balance can be asserted directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the inference guard so we can assert acquire/release balance.
vi.mock("../../webllm/web-llm.ts", () => ({
  acquireInference: vi.fn(),
  releaseInference: vi.fn(),
}));

import { judgeEvidence } from "./judge-evidence.ts";
import { acquireInference, releaseInference } from "../../webllm/web-llm.ts";
import type { JdRequirement } from "./extract-requirements.ts";
import type { WebLlmEngine } from "../../webllm/types.ts";
import type { HeuristicParsedResume } from "../../heuristics/types.ts";

/** A stub engine returning `responses` in call order (empty string after). */
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

function req(id: string, over: Partial<JdRequirement> = {}): JdRequirement {
  return { id, text: `text for ${id}`, kind: "skill", ...over };
}

function parsed(): HeuristicParsedResume {
  return {
    full_name: "Jane Example",
    summary: "WIZARDSUMMARY seasoned engineer",
    skills: ["TypeScript", "Go"],
    experience: [
      { company: "Acme", title: "Engineer", description: "Built things", is_current: false },
    ],
    education: [{ institution: "State U", degree: "BS CS" }],
  };
}

const MODEL = "test-model";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("judgeEvidence", () => {
  it("returns one verdict per requirement with status/reason/evidence", async () => {
    const reqs = [
      req("req-1", { text: "TypeScript" }),
      req("req-2", { kind: "experience", text: "5 years backend", years: 5 }),
      req("req-3", { kind: "qualification", text: "PhD" }),
    ];
    const engine = makeMockEngine([
      JSON.stringify([
        { id: "req-1", status: "met", reason: "Lists TypeScript.", evidence: "TypeScript" },
        { id: "req-2", status: "partial", reason: "Shows 3 years." },
        { id: "req-3", status: "missing", reason: "No PhD mentioned." },
      ]),
    ]);
    const verdicts = await judgeEvidence(reqs, parsed(), engine, MODEL);

    expect(verdicts).toHaveLength(3);
    expect(verdicts[0]).toEqual({
      requirement: reqs[0],
      status: "met",
      reason: "Lists TypeScript.",
      evidence: "TypeScript",
    });
    expect(verdicts[1]!.status).toBe("partial");
    expect("evidence" in verdicts[1]!).toBe(false); // no evidence key when omitted
    expect(verdicts[2]!.status).toBe("missing");
    // Guard balanced for the single batch.
    expect(acquireInference).toHaveBeenCalledTimes(1);
    expect(releaseInference).toHaveBeenCalledTimes(1);
    expect(acquireInference).toHaveBeenCalledWith(MODEL);
  });

  it("batches at the boundary: 10 reqs → 2 calls, guard balanced, all ids covered", async () => {
    const reqs = Array.from({ length: 10 }, (_, i) => req(`req-${i + 1}`));
    const verdict = (id: string) => ({ id, status: "met", reason: "ok" });
    const engine = makeMockEngine([
      JSON.stringify(reqs.slice(0, 8).map((r) => verdict(r.id))),
      JSON.stringify(reqs.slice(8).map((r) => verdict(r.id))),
    ]);
    const verdicts = await judgeEvidence(reqs, parsed(), engine, MODEL);

    expect(engine.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(acquireInference).toHaveBeenCalledTimes(2);
    expect(releaseInference).toHaveBeenCalledTimes(2);
    expect(verdicts).toHaveLength(10);
    expect(verdicts.map((v) => v.requirement.id)).toEqual(reqs.map((r) => r.id));
    expect(verdicts.every((v) => v.status === "met")).toBe(true);
  });

  it("reconciles by id: fills skipped reqs missing, ignores invented ids", async () => {
    const reqs = [req("req-1"), req("req-2")];
    const engine = makeMockEngine([
      JSON.stringify([
        { id: "req-1", status: "met", reason: "found" },
        { id: "req-999", status: "met", reason: "INJECTED — not a real requirement" },
        // req-2 deliberately omitted.
      ]),
    ]);
    const verdicts = await judgeEvidence(reqs, parsed(), engine, MODEL);

    expect(verdicts).toHaveLength(2);
    expect(verdicts.map((v) => v.requirement.id)).toEqual(["req-1", "req-2"]);
    expect(verdicts[0]!.status).toBe("met");
    expect(verdicts[1]!.status).toBe("missing"); // skipped → default
    // The invented id never appears.
    expect(verdicts.some((v) => v.requirement.id === "req-999")).toBe(false);
  });

  it("returns [] and makes no model call for empty requirements", async () => {
    const engine = makeMockEngine([]);
    await expect(judgeEvidence([], parsed(), engine, MODEL)).resolves.toEqual([]);
    expect(engine.chat.completions.create).not.toHaveBeenCalled();
    expect(acquireInference).not.toHaveBeenCalled();
  });

  it("degrades a batch to missing on unparseable output, still releasing the guard", async () => {
    const reqs = [req("req-1"), req("req-2")];
    const engine = makeMockEngine(["not json at all"]);
    const verdicts = await judgeEvidence(reqs, parsed(), engine, MODEL);

    expect(verdicts.every((v) => v.status === "missing")).toBe(true);
    expect(acquireInference).toHaveBeenCalledTimes(1);
    expect(releaseInference).toHaveBeenCalledTimes(1);
  });

  it("degrades a batch to missing when the engine throws, still releasing the guard", async () => {
    const reqs = [req("req-1")];
    const engine: WebLlmEngine = {
      chat: {
        completions: { create: vi.fn().mockRejectedValue(new Error("OOM")) },
      },
    };
    const verdicts = await judgeEvidence(reqs, parsed(), engine, MODEL);

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.status).toBe("missing");
    expect(releaseInference).toHaveBeenCalledTimes(1);
  });

  it("puts the résumé projection in system (reference) and requirements in user", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ choices: [{ message: { content: "[]" } }] });
    const engine: WebLlmEngine = { chat: { completions: { create } } };
    await judgeEvidence([req("req-1", { text: "Kubernetes" })], parsed(), engine, MODEL);

    const msg = create.mock.calls[0]![0];
    expect(msg.messages[0].role).toBe("system");
    expect(msg.messages[0].content).toContain("WIZARDSUMMARY"); // projection in system
    expect(msg.messages[1].role).toBe("user");
    expect(msg.messages[1].content).toContain("req-1");
    expect(msg.messages[1].content).toContain("Kubernetes");
    expect(msg.messages[1].content).not.toContain("WIZARDSUMMARY"); // not in user
    expect(msg.temperature).toBe(0);
  });
});

describe("judgeEvidence — cancellation (#803)", () => {
  it("bounded batches: 24 reqs (3 batches of 8) → 1 batch runs then abort halts scheduling", async () => {
    // The load-bearing #803 assertion. Without the per-batch signal check,
    // an abandoned run continues through EVERY remaining batch on the shared
    // engine — that is the exact runaway behavior #803 exists to close. 24
    // reqs = 3 batches; abort in the first batch's create() must cap the
    // total at 1 call, not 3.
    const reqs = Array.from({ length: 24 }, (_, i) => req(`req-${i + 1}`));
    const controller = new AbortController();
    const create = vi.fn().mockImplementation(async () => {
      controller.abort();
      return {
        choices: [
          {
            message: {
              content: JSON.stringify(
                reqs.slice(0, 8).map((r) => ({
                  id: r.id,
                  status: "met",
                  reason: "ok",
                })),
              ),
            },
          },
        ],
      };
    });
    const engine: WebLlmEngine = { chat: { completions: { create } } };

    const verdicts = await judgeEvidence(
      reqs,
      parsed(),
      engine,
      MODEL,
      controller.signal,
    );

    // Batches after the first must NOT have been scheduled.
    expect(create).toHaveBeenCalledOnce();
    // Guard balanced for exactly the one batch that ran.
    expect(acquireInference).toHaveBeenCalledOnce();
    expect(releaseInference).toHaveBeenCalledOnce();
    // Reconciliation still runs — abandoned reqs default to `missing` — but
    // the orchestrator discards this shape via its own post-call
    // signal.aborted check. Never-throws contract is preserved.
    expect(verdicts).toHaveLength(24);
    expect(verdicts.slice(0, 8).every((v) => v.status === "met")).toBe(true);
    expect(verdicts.slice(8).every((v) => v.status === "missing")).toBe(true);
  });

  it("pre-loop check: already-aborted signal → zero batches, zero acquires", async () => {
    // The pre-check is what prevents even the first batch on a
    // caught-in-time abort.
    const reqs = Array.from({ length: 3 }, (_, i) => req(`req-${i + 1}`));
    const create = vi.fn();
    const engine: WebLlmEngine = { chat: { completions: { create } } };
    const controller = new AbortController();
    controller.abort();

    const verdicts = await judgeEvidence(
      reqs,
      parsed(),
      engine,
      MODEL,
      controller.signal,
    );

    expect(create).not.toHaveBeenCalled();
    expect(acquireInference).not.toHaveBeenCalled();
    expect(releaseInference).not.toHaveBeenCalled();
    // Still returns one verdict per input requirement — every abandoned req
    // defaults to `missing`. The never-throws contract holds even on abort.
    expect(verdicts).toHaveLength(3);
    expect(verdicts.every((v) => v.status === "missing")).toBe(true);
  });

  it("acquire/release stay balanced when abort fires mid-batch (never a leak)", async () => {
    // Cancellation must not corrupt the #148 reference count. A leaked
    // acquire here would pin `inflightInferenceCount` above zero for the
    // page's lifetime and park every later cross-model `.unload()` forever.
    const reqs = Array.from({ length: 16 }, (_, i) => req(`req-${i + 1}`));
    const controller = new AbortController();
    let callCount = 0;
    const create = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) controller.abort();
      return { choices: [{ message: { content: "[]" } }] };
    });
    const engine: WebLlmEngine = { chat: { completions: { create } } };

    await judgeEvidence(reqs, parsed(), engine, MODEL, controller.signal);

    // The abort fired inside batch 1; batch 2 is not scheduled.
    expect(create).toHaveBeenCalledOnce();
    expect(acquireInference).toHaveBeenCalledOnce();
    expect(releaseInference).toHaveBeenCalledOnce();
  });

  it("legacy 4-arg call (no signal) still works", async () => {
    // Back-compat: pre-#803 callers pass no signal. Behavior unchanged.
    const reqs = [req("req-1"), req("req-2")];
    const engine = makeMockEngine([
      JSON.stringify([
        { id: "req-1", status: "met", reason: "ok" },
        { id: "req-2", status: "met", reason: "ok" },
      ]),
    ]);
    const verdicts = await judgeEvidence(reqs, parsed(), engine, MODEL);

    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((v) => v.status === "met")).toBe(true);
  });
});
