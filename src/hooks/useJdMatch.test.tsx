// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useJdMatch (#203) — state-machine coverage exercised through a probe
 * component. Same pattern as `webllm-controllers.test.tsx`: the WebGPU
 * detector, model selection, and the semantic orchestrator are mocked so
 * each test controls the input the hook is reacting to. The keyword-path
 * functions (`extractJdTerms`, `computeCoverage`) stay REAL — the whole point
 * of the keyword branch is that its output must match the pre-#203
 * PasteJdPanel pipeline byte-for-byte, and that parity is worth proving
 * against the actual deterministic composition.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

// ── Mocks (engine + capability + model layer only) ──────────────────────────

let webgpu: "available" | "no-webgpu" | "unsupported-os" = "no-webgpu";
/** Spy-wrapped so tests can assert whether the keyword path touched WebGPU
 *  at all (issue #203 review: the keyword-only path must not fire the
 *  WebLLM funnel's top event on `/jobs/`). Reset per test in beforeEach. */
const detectWebGpuMock = vi.fn(() => Promise.resolve(webgpu));

vi.mock("../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => detectWebGpuMock(),
}));

let modelId: string = "test-model";
vi.mock("./useModelSelection.ts", () => ({
  useModelSelection: () => ({ selectedModelId: modelId }),
}));

// Semantic orchestrator: a controllable stub whose behavior each test
// configures. The real `run-llm-match.ts` is transitively pulled in by the
// hook's dynamic import; mocking here keeps the WebLLM chunk out of the
// jsdom test run.
const runLlmMatchMock = vi.fn();
vi.mock("../lib/jd-match/llm/run-llm-match.ts", () => ({
  runLlmMatch: (...args: unknown[]) => runLlmMatchMock(...args),
}));

import {
  useJdMatch,
  type JdMatchStatus,
  JD_MATCH_DEBOUNCE_MS,
} from "./useJdMatch.ts";
import { extractJdTerms } from "../lib/jd-match/extract-jd-terms.ts";
import { computeCoverage } from "../lib/jd-match/coverage.ts";
import type { JdMatchResult } from "../lib/jd-match";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { ProgressUpdate } from "../lib/webllm/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const JD_TEXT =
  "We are hiring a platform engineer. You will work with Kubernetes, " +
  "Terraform, and Go to run our production infrastructure.";

const SPARSE_RESUME: HeuristicParsedResume = {
  skills: ["React"],
  experience: [
    { title: "Frontend Engineer", company: "Acme", description: "Built UIs" },
  ],
  education: [],
} as unknown as HeuristicParsedResume;

interface ProbeProps {
  parsed: HeuristicParsedResume;
  jdText: string;
  semanticOptIn?: boolean;
}

let latestStatus: JdMatchStatus = { kind: "idle" };
/** The controller's `keyword` floor as of the last render — the channel that
 *  stays populated even while `status` is occupied by the semantic arm. */
let latestKeyword: JdMatchResult | null = null;
/** Every observed render's status, in order. Reset per test in beforeEach.
 *  Populated by the Probe during render (not in an effect), so it captures
 *  the RENDER-TIME status — the invariant #203 protects for the keyword arm. */
const renderStatuses: JdMatchStatus[] = [];

function Probe({ parsed, jdText, semanticOptIn }: ProbeProps) {
  const { status, keyword } = useJdMatch({ parsed, jdText, semanticOptIn });
  latestStatus = status;
  latestKeyword = keyword;
  renderStatuses.push(status);
  return null;
}

let container: HTMLDivElement;
let root: Root;

async function mount(props: ProbeProps): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe {...props} />);
    // Flush microtasks INSIDE act so the WebGPU detection promise's
    // resolve + its .then setState land inside the boundary. Without this
    // React logs "update was not wrapped in act(...)"; with it the mount
    // completes deterministically with capability settled to `webgpu`.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function update(props: ProbeProps): void {
  act(() => root.render(<Probe {...props} />));
}

/** Advance time past the hook's JD-text debounce so the pipeline runs. */
function flushDebounce(): void {
  act(() => {
    vi.advanceTimersByTime(JD_MATCH_DEBOUNCE_MS + 1);
  });
}

/** Flush any pending microtasks so awaited state writes land. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Return `latestStatus` widened to the exported union — TS control-flow
 *  narrowing across a test would otherwise treat later reads as the
 *  narrowest branch asserted earlier, ignoring `act()`'s side effects that
 *  re-assign the `let`. */
function readStatus(): JdMatchStatus {
  return latestStatus;
}

/** Assert the current status is `ready` with a keyword-arm result — the
 *  single check every "no engine touched" test ends with. */
function expectKeywordReady(): void {
  expect(latestStatus.kind).toBe("ready");
  if (latestStatus.kind !== "ready") throw new Error("unreachable");
  expect(latestStatus.result.path).toBe("keyword");
  expect(runLlmMatchMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers();
  webgpu = "no-webgpu";
  modelId = "test-model";
  runLlmMatchMock.mockReset();
  detectWebGpuMock.mockClear();
  latestStatus = { kind: "idle" };
  latestKeyword = null;
  renderStatuses.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
});

describe("useJdMatch — keyword-only path touches NO WebLLM machinery (#203)", () => {
  it("mounting with semanticOptIn=false NEVER calls detectWebGpu", async () => {
    // `detectWebGpu` must not run unconditionally: that fires
    // `webllm_capability_detected` — the WebLLM funnel's top event — on every
    // `/jobs/` load, making users who never opted into semantic matching
    // indistinguishable in the funnel from users who did. The capability
    // effect is gated on `semanticOptIn` to keep the funnel meaningful.
    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT });
    flushDebounce();
    await flushMicrotasks();
    expect(detectWebGpuMock).not.toHaveBeenCalled();

    // Neither does a JD change or a completed keyword transition trigger it.
    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT + " more" });
    flushDebounce();
    await flushMicrotasks();
    expect(detectWebGpuMock).not.toHaveBeenCalled();
  });

  it("flipping semanticOptIn true triggers a capability probe", async () => {
    // The other half of the gate: once the caller opts in, detection has
    // to run — otherwise `capability` stays `null` forever and the semantic
    // path can never activate.
    webgpu = "available";
    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: false });
    flushDebounce();
    await flushMicrotasks();
    expect(detectWebGpuMock).not.toHaveBeenCalled();

    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    expect(detectWebGpuMock).toHaveBeenCalled();
  });
});

describe("useJdMatch — keyword fast path is render-synchronous (#203 timing)", () => {
  it("keyword: `ready` lands on the SAME render as the debounce fire — no effect flush needed", async () => {
    // The invariant this test pins: after `setDebouncedJdText` commits, the
    // very NEXT render (produced by that setState) has `status.kind === "ready"`
    // — because `useMemo` runs during render, not in an effect. An
    // effect-driven derivation would commit one intermediate render with
    // stale status before the effect fired, adding a second commit before
    // `ready` appeared.
    //
    // The probe records `status` on every render. After the debounce fires
    // (inside act), the LAST render's status must already be `ready` —
    // without any further microtask flush, effect turn, or setState await.
    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT });
    const rendersAfterMount = renderStatuses.length;

    act(() => {
      vi.advanceTimersByTime(JD_MATCH_DEBOUNCE_MS + 1);
    });
    // NO `await flushMicrotasks()` here — the whole point of this assertion.

    const rendersAfterDebounce = renderStatuses.length;
    const lastRender = renderStatuses[rendersAfterDebounce - 1]!;

    expect(lastRender.kind).toBe("ready");
    if (lastRender.kind !== "ready") throw new Error("unreachable");
    expect(lastRender.result.path).toBe("keyword");

    // And exactly ONE additional render fired for the debounce — the commit
    // that carries both the new `debouncedJdText` and the useMemo-derived
    // `ready(keyword)`. An effect-driven derivation would produce TWO extra
    // renders (one stale, one after the effect). Guarding this count is what
    // catches a regression back to the effect-driven shape.
    expect(rendersAfterDebounce - rendersAfterMount).toBe(1);
  });
});

describe("useJdMatch — keyword fast path (no engine touched)", () => {
  it("stays idle on empty JD text (post-debounce, no compute)", async () => {
    await mount({ parsed: SPARSE_RESUME, jdText: "" });
    flushDebounce();
    expect(latestStatus).toEqual({ kind: "idle" });
    expect(runLlmMatchMock).not.toHaveBeenCalled();
  });

  it("resolves keyword synchronously when semanticOptIn is false (the default)", async () => {
    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT });
    flushDebounce();
    expectKeywordReady();
  });

  it("keyword result matches a fresh extractJdTerms + computeCoverage exactly", async () => {
    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT });
    flushDebounce();
    if (latestStatus.kind !== "ready") throw new Error("unreachable");
    if (latestStatus.result.path !== "keyword") throw new Error("unreachable");

    const extracted = extractJdTerms(JD_TEXT);
    const expectedCoverage = computeCoverage(SPARSE_RESUME, extracted.all);
    expect(latestStatus.result.terms).toEqual(extracted.all);
    expect(latestStatus.result.nounsDropped).toBe(extracted.nounsDropped);
    expect(latestStatus.result.coverage).toEqual(expectedCoverage);
  });

  it("keyword: JD text with no extractable terms → idle", async () => {
    // `"     .     "` trims to `"."` — non-empty — so `extractJdTerms` runs
    // and the zero-terms guard produces `idle`, NOT the trim-to-empty guard.
    // The complementary trim-to-empty test lives below.
    await mount({ parsed: SPARSE_RESUME, jdText: "     .     " });
    flushDebounce();
    expect(latestStatus).toEqual({ kind: "idle" });
  });

  it("keyword: trim-to-empty JD (whitespace-only) → idle without hitting extract", async () => {
    // Exercises the trim-to-empty guard specifically — `\t   \n  ` trims to
    // `""`, so `trimmedJdText.length === 0` returns null before extract runs.
    await mount({ parsed: SPARSE_RESUME, jdText: "   \t   \n  " });
    flushDebounce();
    expect(latestStatus).toEqual({ kind: "idle" });
  });

  it("keyword: JD text falls back to keyword when WebGPU is unavailable, even with opt-in", async () => {
    webgpu = "no-webgpu";
    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    expectKeywordReady();
  });

  it("keyword: JD text falls back to keyword when WebGPU is unsupported-os, even with opt-in", async () => {
    webgpu = "unsupported-os";
    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    expectKeywordReady();
  });
});

describe("useJdMatch — semantic path (opt-in + WebGPU available)", () => {
  beforeEach(() => {
    webgpu = "available";
  });

  it("progresses idle → loading → running → ready on a happy semantic run", async () => {
    // The stub captures the two callbacks so the test can drive the phase
    // transitions deterministically.
    let capturedProgress: ((u: ProgressUpdate) => void) | null = null;
    let capturedInferenceStart: (() => void) | null = null;
    let resolveRun!: (r: JdMatchResult) => void;
    const runPromise = new Promise<JdMatchResult>((res) => {
      resolveRun = res;
    });
    runLlmMatchMock.mockImplementation(
      (
        _jd: string,
        _parsed: HeuristicParsedResume,
        _model: string,
        onProgress: (u: ProgressUpdate) => void,
        onInferenceStart: () => void,
      ) => {
        capturedProgress = onProgress;
        capturedInferenceStart = onInferenceStart;
        return runPromise;
      },
    );

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    // Dynamic import + the .then chain each need a microtask flush.
    await flushMicrotasks();

    // Loading, before any progress fires.
    expect(latestStatus.kind).toBe("loading");

    // A progress tick moves the update payload but keeps us in loading.
    act(() =>
      capturedProgress?.({ progress: 0.4, text: "Downloading weights…" }),
    );
    if (latestStatus.kind !== "loading") throw new Error("unreachable");
    expect(latestStatus.progress).toEqual({
      progress: 0.4,
      text: "Downloading weights…",
    });

    // The engine finished loading; the model is now thinking.
    act(() => capturedInferenceStart?.());
    expect(latestStatus.kind).toBe("running");

    // The semantic result lands.
    const semanticResult: JdMatchResult = {
      path: "semantic",
      verdicts: [],
      summary: { met: 0, partial: 0, missing: 0, total: 0 },
    };
    await act(async () => {
      resolveRun(semanticResult);
      await runPromise;
    });
    expect(latestStatus).toEqual({ kind: "ready", result: semanticResult });
  });

  it("semantic infrastructure rejection with a live keyword result → ready(keyword), NOT error", async () => {
    // The realistic trigger is a dynamic-import failure after a deploy
    // replaces hashed chunks (`jobs/main.tsx`'s `vite:preloadError` reload
    // is one-shot). If the user was already looking at keyword coverage,
    // we preserve it rather than replacing it with a raw error string.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runLlmMatchMock.mockRejectedValue(new Error("chunk load failed"));

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    // The rejection lands one more microtask later.
    await flushMicrotasks();

    if (latestStatus.kind !== "ready") throw new Error("unreachable");
    expect(latestStatus.result.path).toBe("keyword");
    // Independent recompute oracle — the fallback IS the keyword the user
    // was already looking at, not some other coverage.
    const extracted = extractJdTerms(JD_TEXT);
    const expectedCoverage = computeCoverage(SPARSE_RESUME, extracted.all);
    if (latestStatus.result.path !== "keyword") throw new Error("unreachable");
    expect(latestStatus.result.coverage).toEqual(expectedCoverage);
  });

  it("threads the persisted model id and callbacks to runLlmMatch", async () => {
    runLlmMatchMock.mockResolvedValue({
      path: "semantic",
      verdicts: [],
      summary: { met: 0, partial: 0, missing: 0, total: 0 },
    } satisfies JdMatchResult);

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();

    expect(runLlmMatchMock).toHaveBeenCalledTimes(1);
    const [jd, parsed, modelId, onProgress, onInferenceStart, signal] =
      runLlmMatchMock.mock.calls[0]!;
    expect(jd).toBe(JD_TEXT);
    expect(parsed).toBe(SPARSE_RESUME);
    expect(modelId).toBe("test-model");
    expect(typeof onProgress).toBe("function");
    expect(typeof onInferenceStart).toBe("function");
    // #803: the hook owns an AbortController per run and threads its signal
    // through as the 6th argument so `runLlmMatch` can bail at the next
    // safe boundary once the run is superseded / opted-out / unmounted.
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(false);
  });
});

describe("useJdMatch — semantic input normalization (#203)", () => {
  it("trailing whitespace on a completed semantic result does NOT restart the LLM run", async () => {
    // Keying semantic freshness on the RAW debounced text while storing the
    // TRIMMED one makes a trailing-space edit look like a new input: a
    // byte-identical trimmed payload behind a fresh reference, so the stale
    // check fails and a full extract + judge restarts on a change that cannot
    // alter the answer. Both keyword extraction and semantic freshness
    // therefore key off the canonical `trimmedJdText`.
    webgpu = "available";
    const semanticResult: JdMatchResult = {
      path: "semantic",
      verdicts: [],
      summary: { met: 0, partial: 0, missing: 0, total: 0 },
    };
    runLlmMatchMock.mockResolvedValue(semanticResult);

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    // The result lands.
    await flushMicrotasks();
    expect(runLlmMatchMock).toHaveBeenCalledTimes(1);
    if (latestStatus.kind !== "ready") throw new Error("unreachable");
    expect(latestStatus.result.path).toBe("semantic");

    // Add trailing whitespace — trims to the same JD.
    update({
      parsed: SPARSE_RESUME,
      jdText: JD_TEXT + "   \t   ",
      semanticOptIn: true,
    });
    flushDebounce();
    await flushMicrotasks();
    await flushMicrotasks();

    // Semantic run must NOT have restarted. Also the completed semantic
    // result must still be visible — the slot's value-comparison detected
    // that the trimmed inputs are identical and reused the cached state.
    expect(runLlmMatchMock).toHaveBeenCalledTimes(1);
    if (latestStatus.kind !== "ready") throw new Error("unreachable");
    expect(latestStatus.result).toBe(semanticResult);
  });
});

describe("useJdMatch — `keyword` floor is available alongside a semantic status", () => {
  it("exposes keyword coverage WHILE the semantic arm sits in `loading`", async () => {
    // `status` cannot carry both — the semantic arm owns `loading`/`running`
    // for the whole engine-load window, which on a cold cache is minutes. A
    // consumer reading only `status` would paint an empty spinner over
    // coverage it already had, so the controller exposes `keyword` too. That
    // is what makes "keyword is always available" a property of the API and
    // not just of the docblock.
    webgpu = "available";
    runLlmMatchMock.mockReturnValue(new Promise(() => {}));

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();

    expect(latestStatus.kind).toBe("loading");
    expect(latestKeyword).not.toBeNull();
    if (latestKeyword?.path !== "keyword") throw new Error("unreachable");
    const extracted = extractJdTerms(JD_TEXT);
    expect(latestKeyword.coverage).toEqual(
      computeCoverage(SPARSE_RESUME, extracted.all),
    );
  });

  it("keyword floor is null exactly when status is idle", async () => {
    await mount({ parsed: SPARSE_RESUME, jdText: "   \t  " });
    flushDebounce();
    expect(latestStatus).toEqual({ kind: "idle" });
    expect(latestKeyword).toBeNull();
  });
});

describe("useJdMatch — opt-out preserves a COMPLETED semantic result", () => {
  it("opt-out → opt-in with unchanged inputs does NOT re-run the LLM", async () => {
    // Clearing the slot on every exit threw away a finished answer: an
    // opt-out → opt-in toggle that changed no input re-ran a full engine
    // load + extract + judge for a byte-identical result. Only unsettled
    // slots need clearing, so a `ready` slot now survives the exit.
    webgpu = "available";
    const completed: JdMatchResult = {
      path: "semantic",
      verdicts: [],
      summary: { met: 1, partial: 0, missing: 0, total: 1 },
    };
    runLlmMatchMock.mockResolvedValue(completed);

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(runLlmMatchMock).toHaveBeenCalledTimes(1);
    if (latestStatus.kind !== "ready") throw new Error("unreachable");
    expect(latestStatus.result).toBe(completed);

    // Opt OUT — status falls back to the keyword arm.
    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: false });
    await flushMicrotasks();
    const optedOut = readStatus();
    if (optedOut.kind !== "ready") throw new Error("unreachable");
    expect(optedOut.result.path).toBe("keyword");

    // Opt back IN with identical JD / parse / model — the cached semantic
    // result must come straight back, with no second run.
    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(runLlmMatchMock).toHaveBeenCalledTimes(1);
    const optedBackIn = readStatus();
    if (optedBackIn.kind !== "ready") throw new Error("unreachable");
    expect(optedBackIn.result).toBe(completed);
  });

  it("opt-out while STILL LOADING clears the slot, so opt-in restarts instead of stranding a spinner", async () => {
    // The complement, and the reason the retention is conditional: a partial
    // slot kept across the exit would match on opt-back-in, the effect would
    // early-return, and nothing would restart the run the id bump had
    // already orphaned — a spinner that never ends.
    webgpu = "available";
    runLlmMatchMock.mockReturnValue(new Promise(() => {}));

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    expect(latestStatus.kind).toBe("loading");
    expect(runLlmMatchMock).toHaveBeenCalledTimes(1);

    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: false });
    await flushMicrotasks();
    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();

    // A FRESH run was started — the orphaned one is not being waited on.
    expect(runLlmMatchMock).toHaveBeenCalledTimes(2);
    expect(readStatus().kind).toBe("loading");
  });
});

describe("useJdMatch — transitions & stale-request protection", () => {
  it("semantic → keyword: opting OUT INVALIDATES the request id, so LATE progress ticks stop calling setState", async () => {
    // This test proves the request-id guard (layer 1 of the two-layer
    // staleness protection), NOT the derived-status mask. Under the pre-fix
    // shape the effect early-returned WITHOUT bumping the id, so opt-out
    // during a weight download let every subsequent `onProgress` write to
    // the slot and re-render the panel for a status the consumer could no
    // longer observe. Test would stay green there — this one fails there.
    //
    // Method: capture the progress callback the hook hands to `runLlmMatch`,
    // opt out, then fire progress. Under the fix the write is dropped
    // (mounted-ref true, id mismatch); under the bug it lands and updates
    // the slot. We assert on WHETHER the slot took a `loading, 0.9` write
    // by observing the semantic-side status transition path.
    webgpu = "available";
    let capturedProgress: ((u: ProgressUpdate) => void) | null = null;
    const runPromise = new Promise<JdMatchResult>(() => {});
    runLlmMatchMock.mockImplementation(
      (
        _jd: string,
        _parsed: HeuristicParsedResume,
        _model: string,
        onProgress: (u: ProgressUpdate) => void,
      ) => {
        capturedProgress = onProgress;
        return runPromise;
      },
    );

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    expect(latestStatus.kind).toBe("loading");

    // Opt out. The effect's early-return now bumps the id and clears the
    // slot; the derived status flips synchronously to keyword ready.
    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: false });
    expect(latestStatus.kind).toBe("ready");
    if (latestStatus.kind !== "ready") throw new Error("unreachable");
    expect(latestStatus.result.path).toBe("keyword");

    // Toggle opt-in back on WITHOUT firing the stale progress. If the id
    // were NOT bumped on opt-out, the very next slot write (from the OPT-IN
    // effect starting a NEW run and re-seeding the slot to LOADING_START)
    // would collide with any late writes from the stale run. We prove the
    // stale progress cannot land: fire it AFTER the new run has started,
    // and assert the slot's loading progress remains the fresh one (0)
    // rather than the stale one (0.9).
    const secondRunPromise = new Promise<JdMatchResult>(() => {});
    let secondRunProgress: ((u: ProgressUpdate) => void) | null = null;
    runLlmMatchMock.mockImplementation(
      (
        _jd: string,
        _parsed: HeuristicParsedResume,
        _model: string,
        onProgress: (u: ProgressUpdate) => void,
      ) => {
        secondRunProgress = onProgress;
        return secondRunPromise;
      },
    );
    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    expect(latestStatus.kind).toBe("loading");

    // Fire the STALE progress callback captured before opt-out. Under the
    // fix: id was bumped on opt-out AND again on the fresh run, so the
    // stale callback's id no longer matches. The slot stays on the fresh
    // run's loading state (progress: 0 from LOADING_START). Assert via
    // `readStatus()` (widens past TS's stale narrowing from earlier in the
    // test — `latestStatus` is a `let` re-assigned by Probe on every
    // render, but TS control-flow doesn't consider act()'s side effects).
    act(() => capturedProgress?.({ progress: 0.9, text: "STALE" }));
    const afterStale = readStatus();
    if (afterStale.kind !== "loading") throw new Error("unreachable");
    expect(afterStale.progress.progress).toBe(0);
    expect(afterStale.progress.text).not.toBe("STALE");

    // The FRESH run's progress must still land — proves the id-bump didn't
    // over-invalidate.
    act(() => secondRunProgress?.({ progress: 0.5, text: "fresh" }));
    const afterFresh = readStatus();
    if (afterFresh.kind !== "loading") throw new Error("unreachable");
    expect(afterFresh.progress).toEqual({ progress: 0.5, text: "fresh" });
  });

  it("keyword → semantic: opting IN kicks off the engine load", async () => {
    webgpu = "available";
    runLlmMatchMock.mockReturnValue(new Promise(() => {}));

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: false });
    await flushMicrotasks();
    flushDebounce();
    expect(latestStatus.kind).toBe("ready");
    if (latestStatus.kind !== "ready") throw new Error("unreachable");
    expect(latestStatus.result.path).toBe("keyword");
    expect(runLlmMatchMock).not.toHaveBeenCalled();

    // Flip opt-in on.
    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    expect(latestStatus.kind).toBe("loading");
    expect(runLlmMatchMock).toHaveBeenCalledTimes(1);
  });

  it("JD change mid-semantic-run: an old result cannot overwrite the new state", async () => {
    webgpu = "available";
    // First run: never resolves (stub returns a forever-pending promise the
    // test resolves manually).
    let resolveFirst!: (r: JdMatchResult) => void;
    const firstRun = new Promise<JdMatchResult>((res) => {
      resolveFirst = res;
    });
    // Second run: also forever-pending — we only care that the FIRST run's
    // late resolve doesn't clobber the new "loading" state.
    const secondRun = new Promise<JdMatchResult>(() => {});
    runLlmMatchMock
      .mockReturnValueOnce(firstRun)
      .mockReturnValueOnce(secondRun);

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    expect(latestStatus.kind).toBe("loading");
    expect(runLlmMatchMock).toHaveBeenCalledTimes(1);

    // JD text changes → second run kicks off; first is now stale.
    update({
      parsed: SPARSE_RESUME,
      jdText: JD_TEXT + " Additional requirement: Rust.",
      semanticOptIn: true,
    });
    flushDebounce();
    await flushMicrotasks();
    expect(runLlmMatchMock).toHaveBeenCalledTimes(2);
    expect(latestStatus.kind).toBe("loading");

    // Late resolve of the FIRST run — must be dropped.
    const staleResult: JdMatchResult = {
      path: "semantic",
      verdicts: [],
      summary: { met: 99, partial: 0, missing: 0, total: 99 },
    };
    await act(async () => {
      resolveFirst(staleResult);
      await firstRun;
    });
    // Still loading (the second run has not resolved); the first run's
    // result was correctly dropped rather than transitioning us to `ready`.
    expect(latestStatus.kind).toBe("loading");
  });

  it("StrictMode: the mount effect's double-invoke does NOT leave the mounted-ref stale-false", async () => {
    // The mountedRef guard has to be re-established in the effect body, not
    // just at hook creation — otherwise StrictMode's simulated remount
    // (first effect + cleanup, then a second effect on the SAME hook
    // instance) leaves the ref pointing at `false` for the real mount and
    // every semantic write silently no-ops. Repro: mount under StrictMode,
    // resolve a semantic run — if the guard is broken, the `ready` write
    // is dropped and status stays `loading`.
    webgpu = "available";
    let resolveRun!: (r: JdMatchResult) => void;
    const runPromise = new Promise<JdMatchResult>((res) => {
      resolveRun = res;
    });
    runLlmMatchMock.mockReturnValue(runPromise);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <Probe parsed={SPARSE_RESUME} jdText={JD_TEXT} semanticOptIn={true} />
        </StrictMode>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    flushDebounce();
    await flushMicrotasks();
    expect(latestStatus.kind).toBe("loading");

    const semanticResult: JdMatchResult = {
      path: "semantic",
      verdicts: [],
      summary: { met: 0, partial: 0, missing: 0, total: 0 },
    };
    await act(async () => {
      resolveRun(semanticResult);
      await runPromise;
    });
    // If mountedRef were stale-false, this stays "loading" forever.
    expect(latestStatus).toEqual({ kind: "ready", result: semanticResult });
  });

  it("model change mid-request: the old model's run cannot overwrite the new one", async () => {
    // Model-selection changing between two `useJdMatch` renders bumps the
    // `semanticInputs` identity (its dep tuple includes `selectedModelId`),
    // so the effect fires with a fresh `myId` and the old run's late
    // callbacks fail the guard. Verifies the request-id + inputs-identity
    // pair — not just JD-text change — invalidates a stale semantic write.
    webgpu = "available";
    let resolveFirst!: (r: JdMatchResult) => void;
    const firstRun = new Promise<JdMatchResult>((res) => {
      resolveFirst = res;
    });
    const secondRun = new Promise<JdMatchResult>(() => {});
    runLlmMatchMock
      .mockReturnValueOnce(firstRun)
      .mockReturnValueOnce(secondRun);

    modelId = "model-A";
    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    expect(runLlmMatchMock).toHaveBeenCalledTimes(1);
    expect(runLlmMatchMock.mock.calls[0]![2]).toBe("model-A");

    // Model changes — force the hook to re-run (which is what a real
    // ExternalStore-backed model change does via useSyncExternalStore).
    modelId = "model-B";
    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    expect(runLlmMatchMock).toHaveBeenCalledTimes(2);
    expect(runLlmMatchMock.mock.calls[1]![2]).toBe("model-B");
    expect(latestStatus.kind).toBe("loading");

    // The FIRST run (against model-A) lands late with a result — must NOT
    // overwrite the loading state of the new (model-B) run.
    const staleResult: JdMatchResult = {
      path: "semantic",
      verdicts: [],
      summary: { met: 42, partial: 0, missing: 0, total: 42 },
    };
    await act(async () => {
      resolveFirst(staleResult);
      await firstRun;
    });
    expect(latestStatus.kind).toBe("loading");
  });

  // DELIBERATELY NOT TESTED: `setSlotIfCurrent`'s `mountedRef` unmount guard.
  //
  // No assertion can distinguish that guard being present from absent, so any
  // such test would be decoration. Both candidate oracles were tried and both
  // stay GREEN with `if (!mountedRef.current) return;` deleted:
  //   - A React console warning. React removed "Can't perform a React state
  //     update on an unmounted component" in v18; the only "unmounted
  //     component" strings in react-dom 19.2.6 are the internal "Unable to
  //     find node on an unmounted component" invariant.
  //   - A render count after unmount. `root.unmount()` tears the tree down,
  //     so the late `setSemanticSlot` is a React-level no-op — no render
  //     happens either way.
  // The guard stays in the hook as intent (React's no-op-on-unmounted is an
  // implementation detail, not a contract), but a green test claiming to pin
  // it would misrepresent the coverage, so there isn't one. The `mountedRef`
  // RE-SET in the mount effect is a different matter: it IS load-bearing and
  // IS covered — the StrictMode test above fails if it is dropped.
});

/**
 * Cancellation tests (#803). Focus is Layer-3 — the AbortController per run
 * that stops the WORK, not just the writes. Every test captures the signal
 * passed to `runLlmMatch` and asserts on `signal.aborted`, which is the
 * observable a UI-layer or timing-based test can't fake.
 */
describe("useJdMatch — Layer-3 abort controller (#803)", () => {
  beforeEach(() => {
    webgpu = "available";
  });

  /** Capture every signal `runLlmMatch` is called with; deferred-resolve
   *  promises so the test controls when (or if) each run finishes. */
  function trackSignals() {
    const signals: AbortSignal[] = [];
    runLlmMatchMock.mockImplementation(
      (
        _jd: string,
        _parsed: HeuristicParsedResume,
        _model: string,
        _onProgress: (u: ProgressUpdate) => void,
        _onInferenceStart: () => void,
        signal: AbortSignal,
      ) => {
        signals.push(signal);
        return new Promise<JdMatchResult>(() => {}); // never resolves
      },
    );
    return signals;
  }

  it("threads a non-null AbortSignal to runLlmMatch on every run start", async () => {
    // The API-shape assertion — if #803 shipped without threading the signal,
    // every other test in this block would still pass on stale state, so
    // pinning the argument shape first is what catches an unwired signal.
    const signals = trackSignals();

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
  });

  it("supersession aborts the previous run's signal BEFORE the new run's is passed", async () => {
    // The A → B → C requirement's smallest case (A → B). The ordering matters:
    // if the new signal is created BEFORE the old one is aborted, a stale
    // reader momentarily sees the wrong controller. This test only pins the
    // OUTCOME — old-aborted, new-not — because pinning the intermediate
    // ordering across React commits is fragile.
    const signals = trackSignals();

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    // JD change → run B kicks off; run A is superseded.
    update({
      parsed: SPARSE_RESUME,
      jdText: JD_TEXT + " Additional: Rust.",
      semanticOptIn: true,
    });
    flushDebounce();
    await flushMicrotasks();

    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true); // A aborted
    expect(signals[1]!.aborted).toBe(false); // B still live
  });

  it("A → B → C rapid changes: each supersession aborts the prior; only the last is live", async () => {
    // The full #803 A → B → C scenario from the ticket body. Without the
    // Layer-3 abort, three runs stack on the shared engine; with it, exactly
    // one is live and two are aborted.
    const signals = trackSignals();

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();

    update({
      parsed: SPARSE_RESUME,
      jdText: JD_TEXT + " Edit 1",
      semanticOptIn: true,
    });
    flushDebounce();
    await flushMicrotasks();

    update({
      parsed: SPARSE_RESUME,
      jdText: JD_TEXT + " Edit 1 Edit 2",
      semanticOptIn: true,
    });
    flushDebounce();
    await flushMicrotasks();

    expect(signals).toHaveLength(3);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(true);
    expect(signals[2]!.aborted).toBe(false);
  });

  it("opting out aborts the current run's signal", async () => {
    const signals = trackSignals();

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    expect(signals[0]!.aborted).toBe(false);

    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: false });
    await flushMicrotasks();

    expect(signals[0]!.aborted).toBe(true);
    // No new run started.
    expect(signals).toHaveLength(1);
  });

  it("clearing the JD aborts the current run's signal", async () => {
    // JD → empty flips `takingSemanticPath` false (keywordResult becomes null),
    // so the exit branch fires and aborts.
    const signals = trackSignals();

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    expect(signals[0]!.aborted).toBe(false);

    update({ parsed: SPARSE_RESUME, jdText: "", semanticOptIn: true });
    flushDebounce();
    await flushMicrotasks();

    expect(signals[0]!.aborted).toBe(true);
    expect(signals).toHaveLength(1);
  });

  it("model change aborts the previous run's signal and starts a fresh one", async () => {
    // Same shape as the JD-change test but the input that changed is the
    // model id. The layered-inputs equality check (`semanticInputsMatch`)
    // includes modelId, so a change re-enters the "new run" branch.
    const signals = trackSignals();

    modelId = "model-A";
    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    expect(signals).toHaveLength(1);

    modelId = "model-B";
    update({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();

    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it("unmount aborts the current run's signal (after the microtask hop)", async () => {
    // Deferred abort past one microtask; a naive synchronous abort in the
    // mount-cleanup would kill runs mid-StrictMode-remount (see the docblock).
    const signals = trackSignals();

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();
    expect(signals[0]!.aborted).toBe(false);

    act(() => root.unmount());
    // The abort is scheduled as a microtask; flush.
    await flushMicrotasks();

    expect(signals[0]!.aborted).toBe(true);
  });

  it("StrictMode remount does NOT abort the in-flight run (microtask guard defers past the re-mount)", async () => {
    // Pins what the microtask defer + `mountedRef` re-check actually buy:
    // a cleanup queued by StrictMode's simulated unmount must not later kill
    // the REAL run that the re-mount started.
    //
    // Scoped deliberately. It does NOT prove the defer prevents a live abort
    // at the double-invoke, because no run exists to abort there: the mount
    // effect's cleanup fires while `debouncedJdText` is still `""` and
    // `capability` is still `null`, so `takingSemanticPath` is false and
    // `controllerRef.current` is null through the whole synchronous
    // double-invoke. A synchronous abort in that cleanup passes this test too.
    // The guard is a belt against a future ordering — see the Layer-3 note in
    // the hook's module docblock — and this test pins the part that is real.
    const signals: AbortSignal[] = [];
    runLlmMatchMock.mockImplementation(
      (
        _jd: string,
        _parsed: HeuristicParsedResume,
        _model: string,
        _onProgress: (u: ProgressUpdate) => void,
        _onInferenceStart: () => void,
        signal: AbortSignal,
      ) => {
        signals.push(signal);
        return new Promise<JdMatchResult>(() => {});
      },
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <Probe parsed={SPARSE_RESUME} jdText={JD_TEXT} semanticOptIn={true} />
        </StrictMode>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    flushDebounce();
    await flushMicrotasks();
    // Microtask queue flushed — if the cleanup's abort weren't deferred + guarded,
    // this is where the still-in-flight run would already be aborted.
    await flushMicrotasks();

    // At least one signal was created; the LAST one (the live run) must NOT be aborted.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[signals.length - 1]!.aborted).toBe(false);
  });

  it("A late-arriving semantic result from an aborted run does NOT overwrite a fresh run's state", async () => {
    // Belt AND suspenders together: even if a network layer somewhere let a
    // partially-completed run resolve after abort, the id guard drops the
    // late write. The abort tests above prove the WORK stops; this test
    // proves the WRITES also stay hidden — the two layers protect different
    // things, and #803's implementation must not accidentally couple them.
    let resolveFirst!: (r: JdMatchResult) => void;
    const firstRun = new Promise<JdMatchResult>((res) => {
      resolveFirst = res;
    });
    const secondRun = new Promise<JdMatchResult>(() => {});
    runLlmMatchMock
      .mockReturnValueOnce(firstRun)
      .mockReturnValueOnce(secondRun);

    await mount({ parsed: SPARSE_RESUME, jdText: JD_TEXT, semanticOptIn: true });
    await flushMicrotasks();
    flushDebounce();
    await flushMicrotasks();

    // JD change → run B starts, run A is aborted but its promise still exists.
    update({
      parsed: SPARSE_RESUME,
      jdText: JD_TEXT + " Additional: Rust.",
      semanticOptIn: true,
    });
    flushDebounce();
    await flushMicrotasks();
    expect(latestStatus.kind).toBe("loading");

    // Late resolve of run A — must be dropped by the id guard.
    const staleResult: JdMatchResult = {
      path: "semantic",
      verdicts: [],
      summary: { met: 99, partial: 0, missing: 0, total: 99 },
    };
    await act(async () => {
      resolveFirst(staleResult);
      await firstRun;
    });

    expect(latestStatus.kind).toBe("loading"); // run B still loading, not overwritten
  });
});
