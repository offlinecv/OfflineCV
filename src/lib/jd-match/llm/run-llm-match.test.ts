// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for runLlmMatch (#202) — the semantic orchestrator's two
 * branches, driven by stubs (no WebGPU): the happy path assembles a
 * `semantic` result from the collaborators' outputs, and EVERY failure mode
 * (engine load error, extraction hard-failure, empty extraction, unexpected
 * judge error) resolves to a keyword result that matches a fresh
 * `extractJdTerms` + `computeCoverage` computation exactly — fallback parity,
 * proven the same way rank parity is (#319-style independent recompute).
 *
 * `loadEngine` / `extractRequirements` / `judgeEvidence` are mocked at their
 * module boundary; the keyword-path functions stay REAL so the fallback
 * assertion exercises the actual deterministic pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the engine loader (and the inference-guard exports judge-evidence's
// module-level imports resolve against, so importing it stays loadable).
vi.mock("../../webllm/web-llm.ts", () => ({
  loadEngine: vi.fn(),
  acquireInference: vi.fn(),
  releaseInference: vi.fn(),
}));

// Mock the two LLM calls; keep the real RequirementExtractionError class so
// the thrown-error test uses the same type the production extractor throws.
vi.mock("./extract-requirements.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./extract-requirements.ts")>();
  return { ...actual, extractRequirements: vi.fn() };
});
vi.mock("./judge-evidence.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./judge-evidence.ts")>();
  return { ...actual, judgeEvidence: vi.fn() };
});

import { runLlmMatch } from "./run-llm-match.ts";
import {
  acquireInference,
  loadEngine,
  releaseInference,
} from "../../webllm/web-llm.ts";
import {
  extractRequirements,
  RequirementExtractionError,
  type JdRequirement,
} from "./extract-requirements.ts";
import { judgeEvidence, type RequirementVerdict } from "./judge-evidence.ts";
import { extractJdTerms } from "../extract-jd-terms.ts";
import { computeCoverage } from "../coverage.ts";
import type { WebLlmEngine } from "../../webllm/types.ts";
import type { HeuristicParsedResume } from "../../heuristics/types.ts";

const loadEngineMock = vi.mocked(loadEngine);
const extractMock = vi.mocked(extractRequirements);
const judgeMock = vi.mocked(judgeEvidence);
const acquireMock = vi.mocked(acquireInference);
const releaseMock = vi.mocked(releaseInference);

const MODEL = "test-model";
const JD_TEXT =
  "We are hiring a backend engineer. Requires TypeScript and Go. " +
  "Kubernetes experience is a plus.";

const engine: WebLlmEngine = {
  chat: { completions: { create: vi.fn() } },
};

function parsed(): HeuristicParsedResume {
  return {
    full_name: "Jane Example",
    skills: ["TypeScript", "Go"],
    experience: [
      {
        company: "Acme",
        title: "Backend Engineer",
        description: "Built TypeScript services",
        is_current: false,
      },
    ],
    education: [],
  };
}

function req(id: string, text: string): JdRequirement {
  return { id, kind: "skill", text };
}

function verdict(
  id: string,
  status: RequirementVerdict["status"],
): RequirementVerdict {
  return {
    requirement: req(id, `text for ${id}`),
    status,
    reason: `reason for ${id}`,
  };
}

/** The exact keyword result the fallback must reproduce. */
function freshKeywordResult(resume: HeuristicParsedResume) {
  const extracted = extractJdTerms(JD_TEXT);
  return {
    path: "keyword" as const,
    coverage: computeCoverage(resume, extracted.all),
    terms: extracted.all,
    nounsDropped: extracted.nounsDropped,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The fallback branch warns; keep test output clean and assertable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  loadEngineMock.mockResolvedValue(engine);
});

describe("runLlmMatch — happy path", () => {
  it("assembles a semantic result: verdicts passed through, summary tallied", async () => {
    const requirements = [req("req-1", "TypeScript"), req("req-2", "Go"), req("req-3", "Kubernetes"), req("req-4", "GraphQL")];
    const verdicts = [
      verdict("req-1", "met"),
      verdict("req-2", "met"),
      verdict("req-3", "partial"),
      verdict("req-4", "missing"),
    ];
    extractMock.mockResolvedValue(requirements);
    judgeMock.mockResolvedValue(verdicts);

    const onProgress = vi.fn();
    const result = await runLlmMatch(JD_TEXT, parsed(), MODEL, onProgress);

    expect(result.path).toBe("semantic");
    if (result.path !== "semantic") throw new Error("unreachable");
    expect(result.verdicts).toBe(verdicts);
    expect(result.summary).toEqual({ met: 2, partial: 1, missing: 1, total: 4 });
  });

  it("threads jdText, engine, modelId, and onProgress to the right collaborators", async () => {
    const resume = parsed();
    const requirements = [req("req-1", "TypeScript")];
    extractMock.mockResolvedValue(requirements);
    judgeMock.mockResolvedValue([verdict("req-1", "met")]);

    const onProgress = vi.fn();
    await runLlmMatch(JD_TEXT, resume, MODEL, onProgress);

    expect(loadEngineMock).toHaveBeenCalledExactlyOnceWith(MODEL, onProgress);
    // Trailing `undefined` signal argument (#803): the orchestrator always
    // passes its own `signal` parameter through even when the caller didn't
    // supply one, so the collaborator's arg tuple carries a positional
    // `undefined` we have to match here.
    expect(extractMock).toHaveBeenCalledExactlyOnceWith(
      JD_TEXT,
      engine,
      undefined,
    );
    expect(judgeMock).toHaveBeenCalledExactlyOnceWith(
      requirements,
      resume,
      engine,
      MODEL,
      undefined,
    );
  });

  it("fires onInferenceStart exactly once, AFTER loadEngine RESOLVES, BEFORE extractRequirements (#203)", async () => {
    // The load→infer transition is what lets a state-machine consumer
    // distinguish `loading` from `running` without duplicating the
    // orchestrator. The trace has to record the RESOLUTION of loadEngine's
    // promise (not its call time), otherwise a regression to
    //
    //   const p = loadEngine(modelId, onProgress);
    //   onInferenceStart?.();
    //   const engine = await p;
    //
    // would still produce the "correct" ordering in the trace and pass. A
    // deferred promise + a `.then` marker gives us the actual resolution
    // event; the deferred is resolved AFTER the runLlmMatch call so an
    // early `onInferenceStart` would land before "loadEngine.resolve" in
    // the trace and fail the assertion.
    const trace: string[] = [];
    let resolveEngine!: (e: WebLlmEngine) => void;
    const enginePromise = new Promise<WebLlmEngine>((res) => {
      resolveEngine = res;
    });
    // Marker fires on the ACTUAL resolution of the promise. Chained here
    // rather than inside `mockImplementation`'s body — that body executes
    // synchronously on call and would record call time.
    void enginePromise.then(() => trace.push("loadEngine.resolve"));
    loadEngineMock.mockReturnValue(enginePromise);

    extractMock.mockImplementation(async () => {
      trace.push("extractRequirements.call");
      return [req("req-1", "TypeScript")];
    });
    judgeMock.mockResolvedValue([verdict("req-1", "met")]);

    const onInferenceStart = vi.fn(() => trace.push("onInferenceStart"));
    const runPromise = runLlmMatch(
      JD_TEXT,
      parsed(),
      MODEL,
      vi.fn(),
      onInferenceStart,
    );
    // Resolve the engine AFTER runLlmMatch is under way. A regression that
    // fires `onInferenceStart` before awaiting the engine promise would
    // land it in the trace here (before "loadEngine.resolve").
    resolveEngine(engine);
    await runPromise;

    expect(onInferenceStart).toHaveBeenCalledOnce();
    expect(trace).toEqual([
      "loadEngine.resolve",
      "onInferenceStart",
      "extractRequirements.call",
    ]);
  });

  it("does NOT fire onInferenceStart on the fallback branch (engine load failed)", async () => {
    // The caller stays in `loading` all the way to the fallback keyword
    // `ready`; a spurious `running` transition would leave the UI briefly
    // in an inference state that never actually started.
    loadEngineMock.mockRejectedValue(new Error("WebGPU unavailable"));

    const onInferenceStart = vi.fn();
    const result = await runLlmMatch(
      JD_TEXT,
      parsed(),
      MODEL,
      vi.fn(),
      onInferenceStart,
    );

    expect(result.path).toBe("keyword");
    expect(onInferenceStart).not.toHaveBeenCalled();
  });
});

describe("runLlmMatch — #148 inference guard brackets the WHOLE load-and-use sequence", () => {
  it("acquires BEFORE awaiting loadEngine, and releases exactly once", async () => {
    // `web-llm.ts` is explicit that acquiring AFTER the await is too late:
    // `await` yields even on the already-loaded fast path, and a concurrent
    // cross-model load's `evictAllExcept` can see `inflightInferenceCount`
    // at 0 in that gap and `.unload()` the engine mid-use. So the ordering
    // — not merely the presence of the call — is the contract. A trace is
    // what pins ordering; a `toHaveBeenCalled` pair would pass for the
    // broken "load first, acquire second" shape too.
    const trace: string[] = [];
    acquireMock.mockImplementation(() => {
      trace.push("acquire");
    });
    releaseMock.mockImplementation(() => {
      trace.push("release");
    });
    loadEngineMock.mockImplementation(() => {
      trace.push("loadEngine");
      return Promise.resolve(engine);
    });
    extractMock.mockImplementation(async () => {
      trace.push("extractRequirements");
      return [req("req-1", "TypeScript")];
    });
    judgeMock.mockImplementation(async () => {
      trace.push("judgeEvidence");
      return [verdict("req-1", "met")];
    });

    await runLlmMatch(JD_TEXT, parsed(), MODEL, vi.fn());

    expect(trace).toEqual([
      "acquire",
      "loadEngine",
      "extractRequirements",
      "judgeEvidence",
      "release",
    ]);
    expect(acquireMock).toHaveBeenCalledWith(MODEL);
    expect(releaseMock).toHaveBeenCalledWith(MODEL);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("releases on the engine-load failure path (the keyword fallback)", async () => {
    // A leaked acquire would pin `inflightInferenceCount` above zero for the
    // page's lifetime, parking every later cross-model `.unload()` forever —
    // so the release has to survive the branch that degrades to keyword.
    loadEngineMock.mockRejectedValue(new Error("WebGPU unavailable"));

    const result = await runLlmMatch(JD_TEXT, parsed(), MODEL, vi.fn());

    expect(result.path).toBe("keyword");
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("releases on the empty-extraction degrade path", async () => {
    // The third exit from the try block — an early `return` rather than a
    // throw, which is exactly the shape a `finally` is needed to cover.
    extractMock.mockResolvedValue([]);

    const result = await runLlmMatch(JD_TEXT, parsed(), MODEL, vi.fn());

    expect(result.path).toBe("keyword");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("runLlmMatch — fallback discipline (every failure → keyword, never a rejection)", () => {
  it("falls back when the engine load fails (also the no-WebGPU manifestation)", async () => {
    loadEngineMock.mockRejectedValue(new Error("WebGPU unavailable"));

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());

    expect(result).toEqual(freshKeywordResult(resume));
    expect(extractMock).not.toHaveBeenCalled();
    expect(judgeMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("falls back when extraction hard-fails (RequirementExtractionError)", async () => {
    extractMock.mockRejectedValue(
      new RequirementExtractionError("no parseable JSON array"),
    );

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());

    expect(result).toEqual(freshKeywordResult(resume));
    expect(judgeMock).not.toHaveBeenCalled();
  });

  it("falls back on a valid-but-empty extraction (zero verdicts = blank panel)", async () => {
    extractMock.mockResolvedValue([]);

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());

    expect(result.path).toBe("keyword");
    expect(judgeMock).not.toHaveBeenCalled();
    // Not an error — the extractor succeeded — so no warning is logged.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("falls back if the judge throws unexpectedly (defensive; its contract is never-throw)", async () => {
    extractMock.mockResolvedValue([req("req-1", "TypeScript")]);
    judgeMock.mockRejectedValue(new Error("engine evicted mid-batch"));

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());

    expect(result).toEqual(freshKeywordResult(resume));
  });

  it("fallback parity: the keyword result matches the JD-fit surface's own composition exactly", async () => {
    loadEngineMock.mockRejectedValue(new Error("boom"));

    const resume = parsed();
    const result = await runLlmMatch(JD_TEXT, resume, MODEL, vi.fn());
    const fresh = freshKeywordResult(resume);

    if (result.path !== "keyword") throw new Error("expected keyword path");
    expect(result.coverage.score).toBe(fresh.coverage.score);
    expect(result.terms.length).toBeGreaterThan(0);
    expect(result.terms).toEqual(fresh.terms);
    expect(result.nounsDropped).toBe(fresh.nounsDropped);
  });
});

/**
 * Cancellation tests (#803). Each test targets ONE boundary from the map in
 * `run-llm-match.ts`'s docblock and would go RED if that specific abort check
 * is removed — pinning them separately, rather than one all-or-nothing test,
 * is what makes a regression at any single boundary a red bar.
 */
describe("runLlmMatch — cancellation (#803)", () => {
  it("legacy 4-arg call still works (backward compatibility)", async () => {
    // Existing callers that pre-date #803 pass no `signal`. The orchestrator
    // must not require one and must behave exactly as before when absent.
    extractMock.mockResolvedValue([req("req-1", "TypeScript")]);
    judgeMock.mockResolvedValue([verdict("req-1", "met")]);

    const result = await runLlmMatch(JD_TEXT, parsed(), MODEL, vi.fn());

    expect(result.path).toBe("semantic");
    expect(loadEngineMock).toHaveBeenCalledOnce();
    expect(extractMock).toHaveBeenCalledOnce();
    expect(judgeMock).toHaveBeenCalledOnce();
  });

  it("legacy 5-arg call (onInferenceStart, no signal) still works", async () => {
    // The other back-compat shape: consumers that took the #203 onInferenceStart
    // upgrade but haven't wired an AbortController yet.
    extractMock.mockResolvedValue([req("req-1", "TypeScript")]);
    judgeMock.mockResolvedValue([verdict("req-1", "met")]);
    const onInferenceStart = vi.fn();

    const result = await runLlmMatch(
      JD_TEXT,
      parsed(),
      MODEL,
      vi.fn(),
      onInferenceStart,
    );

    expect(result.path).toBe("semantic");
    expect(onInferenceStart).toHaveBeenCalledOnce();
  });

  it("boundary 1: an already-aborted signal skips the pipeline entirely — no acquire, no load, no extract, no judge", async () => {
    // The pre-acquire short-circuit is the ONLY branch that must also skip
    // the release, because it didn't acquire. Testing acquire === 0 AND
    // release === 0 together is what pins the paired exit. A regression that
    // moved the abort check inside the try block would leak an unbalanced
    // release call.
    const controller = new AbortController();
    controller.abort();

    const resume = parsed();
    const result = await runLlmMatch(
      JD_TEXT,
      resume,
      MODEL,
      vi.fn(),
      undefined,
      controller.signal,
    );

    expect(result).toEqual(freshKeywordResult(resume));
    expect(acquireMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(loadEngineMock).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
    expect(judgeMock).not.toHaveBeenCalled();
    // Not logged as a failure — cancellation is expected control flow.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("boundary 2: abort while loadEngine is in flight → no onInferenceStart, no extract, no judge", async () => {
    // loadEngine has no signal parameter (we can't safely cancel it — it's
    // cross-consumer shared) so the abort must be detected on RESUMPTION
    // after the await. onInferenceStart NOT firing is the observable that
    // proves the check is post-await, not post-callback.
    const controller = new AbortController();
    let resolveEngine!: (e: WebLlmEngine) => void;
    loadEngineMock.mockReturnValue(
      new Promise<WebLlmEngine>((res) => {
        resolveEngine = res;
      }),
    );
    const onInferenceStart = vi.fn();

    const runPromise = runLlmMatch(
      JD_TEXT,
      parsed(),
      MODEL,
      vi.fn(),
      onInferenceStart,
      controller.signal,
    );
    // Abort DURING the loadEngine await, then let the engine resolve.
    controller.abort();
    resolveEngine({ chat: { completions: { create: vi.fn() } } });
    const result = await runPromise;

    expect(result.path).toBe("keyword");
    expect(onInferenceStart).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
    expect(judgeMock).not.toHaveBeenCalled();
    // Acquire/release still balanced — the abort landed INSIDE the try block.
    expect(acquireMock).toHaveBeenCalledOnce();
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("boundary 5: abort between extract and judge → judge is never called", async () => {
    // The check between the two LLM calls guards the empty gap where an
    // orchestrator without a signal would proceed straight to judgeEvidence.
    const controller = new AbortController();
    extractMock.mockImplementation(async () => {
      controller.abort();
      return [req("req-1", "TypeScript")];
    });

    const resume = parsed();
    const result = await runLlmMatch(
      JD_TEXT,
      resume,
      MODEL,
      vi.fn(),
      undefined,
      controller.signal,
    );

    expect(result).toEqual(freshKeywordResult(resume));
    expect(judgeMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("boundary 7: abort mid-judge → judge's partial result is DISCARDED in favor of keyword", async () => {
    // `judgeEvidence` never throws (contract): on abort it returns a partial
    // reconciled result with abandoned reqs defaulted to `missing`. That
    // shape must NEVER reach the caller — showing a semantic verdict list
    // for a superseded run is exactly the failure mode #803 is closing.
    const controller = new AbortController();
    const requirements = [req("req-1", "TS"), req("req-2", "Go")];
    extractMock.mockResolvedValue(requirements);
    judgeMock.mockImplementation(async () => {
      // Simulate the internal per-batch-loop bailing on abort.
      controller.abort();
      return [
        {
          requirement: requirements[0]!,
          status: "missing",
          reason: "No matching evidence found in the résumé.",
        },
        {
          requirement: requirements[1]!,
          status: "missing",
          reason: "No matching evidence found in the résumé.",
        },
      ];
    });

    const resume = parsed();
    const result = await runLlmMatch(
      JD_TEXT,
      resume,
      MODEL,
      vi.fn(),
      undefined,
      controller.signal,
    );

    // Must be keyword, NOT the partial-all-missing semantic result.
    expect(result).toEqual(freshKeywordResult(resume));
  });

  it("abort thrown from a signal-aware extractRequirements → keyword fallback, no warn", async () => {
    // Even in the future where `extractRequirements` could throw an AbortError
    // in-band (or a signal-aware `chat.completions.create` does), the
    // orchestrator's catch must map AbortError → keyword WITHOUT logging.
    //
    // The signal fires DURING extract, not before: an already-aborted signal
    // is short-circuited by boundary 1 before `acquireInference`, so the catch
    // under test is never entered and the assertions pass vacuously.
    const controller = new AbortController();
    loadEngineMock.mockResolvedValue(engine);
    extractMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(
        new DOMException("Semantic run aborted.", "AbortError"),
      );
    });

    const resume = parsed();
    const result = await runLlmMatch(
      JD_TEXT,
      resume,
      MODEL,
      vi.fn(),
      undefined,
      controller.signal,
    );

    expect(extractMock).toHaveBeenCalledOnce();
    expect(result).toEqual(freshKeywordResult(resume));
    // Distinguishes cancellation from a real semantic failure — the
    // RequirementExtractionError test in the fallback-discipline block
    // asserts warn IS called; here it must NOT.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("an AbortError-shaped engine error on an UNFIRED signal still warns and degrades", async () => {
    // The `signal?.aborted` half of the catch's cancellation branch.
    // `isAbortError` is a pure shape check, so without it any error the engine
    // happens to name "AbortError" — a future per-request timeout, a
    // device-lost surfaced this way — becomes indistinguishable from a user
    // supersession: degraded to keyword with the warn deliberately skipped and
    // zero diagnostic trail for a failure we did not cause.
    const controller = new AbortController(); // never fired
    loadEngineMock.mockResolvedValue(engine);
    extractMock.mockRejectedValue(
      new DOMException("engine request timed out", "AbortError"),
    );

    const resume = parsed();
    const result = await runLlmMatch(
      JD_TEXT,
      resume,
      MODEL,
      vi.fn(),
      undefined,
      controller.signal,
    );

    // Still degrades — the never-rejects contract is unconditional.
    expect(result).toEqual(freshKeywordResult(resume));
    // But it is a FAILURE, so the diagnostic must survive.
    expect(console.warn).toHaveBeenCalledWith(
      "[run-llm-match] semantic path failed; falling back to keyword:",
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("aborted runLlmMatch RESOLVES; never rejects, never leaks the AbortError", async () => {
    // The never-rejects contract MUST hold for cancellation too — a rejection
    // here would bypass the useJdMatch hook's `.then(result => setSlot(ready))`
    // and land in `.catch`, where the code would log "semantic path failed
    // unexpectedly" over a cancellation that was our own initiative.
    const controller = new AbortController();
    controller.abort();

    // Deliberately no unhandled-rejection oracle — vitest already fails a
    // test on unhandled promise rejection in the same tick. This is the
    // await that would surface it.
    await expect(
      runLlmMatch(
        JD_TEXT,
        parsed(),
        MODEL,
        vi.fn(),
        undefined,
        controller.signal,
      ),
    ).resolves.toBeDefined();
  });

  it("cancellation is NOT logged as a semantic failure", async () => {
    // The distinguishing test for logging discipline — a real failure logs a
    // console.warn (see the "extraction hard-fails" test above), a
    // cancellation must not. Same abort as boundary-1 test but the assertion
    // focus is the log oracle.
    const controller = new AbortController();
    controller.abort();

    await runLlmMatch(
      JD_TEXT,
      parsed(),
      MODEL,
      vi.fn(),
      undefined,
      controller.signal,
    );

    expect(console.warn).not.toHaveBeenCalled();
  });

  it("real (non-abort) semantic failure with an unfired signal still degrades to keyword AND still warns", async () => {
    // Belt-and-suspenders: verify the abort-vs-failure branching didn't
    // accidentally silence a genuine RequirementExtractionError.
    const controller = new AbortController(); // NOT aborted
    extractMock.mockRejectedValue(
      new RequirementExtractionError("no parseable JSON array"),
    );

    const resume = parsed();
    const result = await runLlmMatch(
      JD_TEXT,
      resume,
      MODEL,
      vi.fn(),
      undefined,
      controller.signal,
    );

    expect(result).toEqual(freshKeywordResult(resume));
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
