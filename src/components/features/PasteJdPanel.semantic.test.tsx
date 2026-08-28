// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * PasteJdPanel semantic opt-in (#204) — the wired lane, end to end.
 *
 * This is the INTEGRATION test for #204, and the mock seam is deliberately
 * narrow: only the three things a jsdom run cannot have — the WebGPU probe,
 * the persisted model id, and the WebLLM orchestrator — are stubbed. The
 * panel, `useJdMatch`, `JdMatch`'s router, `KeywordMatch`, `SemanticMatch` and
 * the whole deterministic keyword pipeline (`extractJdTerms` +
 * `computeCoverage`) are REAL. A test that mocked `useJdMatch` would prove the
 * panel renders whatever it is handed and nothing about whether the opt-in is
 * actually gating anything.
 *
 * The claims worth the most here are the negative ones — that an untouched
 * panel does no WebGPU work at all, and that an abandoned run can never flash
 * a verdict over a newer state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

// ── Mocks (capability + model layer + orchestrator only) ────────────────────

let webgpu: "available" | "no-webgpu" | "unsupported-os" = "available";
const detectWebGpuMock = vi.fn(() => Promise.resolve(webgpu));
vi.mock("../../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => detectWebGpuMock(),
}));

let modelId = "test-model";
vi.mock("../../hooks/useModelSelection.ts", () => ({
  useModelSelection: () => ({ selectedModelId: modelId }),
}));

/** One captured `runLlmMatch` invocation, with the handles a test needs to
 *  drive it: the progress/inference callbacks, the abort signal #803 threads,
 *  and the resolver that stands in for the model finishing. */
interface RunCall {
  jdText: string;
  modelId: string;
  onProgress: (update: { progress: number; text: string }) => void;
  onInferenceStart?: () => void;
  signal?: AbortSignal;
  resolve: (result: JdMatchResult) => void;
}

const runs: RunCall[] = [];
const runLlmMatchMock = vi.fn(
  (
    jdText: string,
    _parsed: unknown,
    runModelId: string,
    onProgress: RunCall["onProgress"],
    onInferenceStart?: () => void,
    signal?: AbortSignal,
  ) =>
    new Promise<JdMatchResult>((resolve) => {
      runs.push({
        jdText,
        modelId: runModelId,
        onProgress,
        onInferenceStart,
        signal,
        resolve,
      });
    }),
);
vi.mock("../../lib/jd-match/llm/run-llm-match.ts", () => ({
  runLlmMatch: (...args: Parameters<typeof runLlmMatchMock>) =>
    runLlmMatchMock(...args),
}));

import { PasteJdPanel } from "./PasteJdPanel.tsx";
import { extractJdTerms, computeCoverage } from "../../lib/jd-match";
import { buildJdRewriteContextFromVerdicts } from "../../lib/jd-match/rewrite-context.ts";
import type { JdMatchResult } from "../../lib/jd-match";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import type { RequirementVerdict } from "../../lib/jd-match/llm/judge-evidence.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const JD_A =
  "We are hiring a platform engineer. You will work with Kubernetes, " +
  "Terraform, and Go to run our production infrastructure.";
const JD_B =
  "We are hiring a data engineer. You will work with Airflow, Spark, and " +
  "Python to run our analytics warehouse.";
const JD_C =
  "We are hiring a security engineer. You will work with Terraform, Rust, " +
  "and threat modeling to harden our production estate.";

const SPARSE_RESUME: HeuristicParsedResume = {
  skills: ["React"],
  experience: [
    { title: "Frontend Engineer", company: "Acme", description: "Built UIs" },
  ],
  education: [],
} as unknown as HeuristicParsedResume;

function verdicts(): RequirementVerdict[] {
  return [
    {
      requirement: { id: "req-1", kind: "skill", text: "Run Kubernetes" },
      status: "met",
      reason: "Operated production clusters.",
      evidence: "Ran a 40-node cluster",
    },
    {
      requirement: { id: "req-2", kind: "experience", text: "Five years of Go" },
      status: "missing",
      reason: "No Go experience listed.",
    },
  ];
}

function semanticResult(headline = "Run Kubernetes"): JdMatchResult {
  const list = verdicts();
  list[0].requirement.text = headline;
  return {
    path: "semantic",
    verdicts: list,
    summary: { met: 1, partial: 0, missing: 1, total: 2 },
  };
}

function keywordResult(jdText: string): JdMatchResult {
  const extracted = extractJdTerms(jdText);
  return {
    path: "keyword",
    coverage: computeCoverage(SPARSE_RESUME, extracted.all),
    terms: extracted.all,
    nounsDropped: extracted.nounsDropped,
  };
}

// ── Harness ────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

/** Options `mount` accepts. All optional, so the 22 bare `mount()` calls that
 *  predate the tailor-steering tests keep working unchanged. `parsed` and
 *  `onTailor` exist because those tests need a résumé whose keyword coverage
 *  is 100% and a spy they can assert the handoff payload on — without them a
 *  test has to hand-roll this whole helper, which is what #867 originally did
 *  three times over. */
interface MountOptions {
  strict?: boolean;
  parsed?: HeuristicParsedResume;
  onTailor?: (jdContext: string) => void;
}

function mount({
  strict = false,
  parsed = SPARSE_RESUME,
  onTailor = vi.fn(),
}: MountOptions = {}): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree = <PasteJdPanel parsed={parsed} onTailor={onTailor} />;
  act(() => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  // Expand the collapsed-by-default disclosure.
  act(() => discloseButton().click());
}

function discloseButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Paste it"),
  );
  if (!button) throw new Error("paste-a-JD disclosure button not found");
  return button as HTMLButtonElement;
}

/** Type a JD the way React's own synthetic events do, then flush the hook's
 *  200 ms debounce and any awaited state writes. */
async function setJd(text: string): Promise<void> {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("JD textarea not found");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(500);
  });
  await settle();
}

function optInBox(): HTMLInputElement {
  const box = container.querySelector('input[type="checkbox"]');
  if (!box) throw new Error("opt-in checkbox not found");
  return box as HTMLInputElement;
}

/** Click the opt-in checkbox and let the capability probe resolve. */
async function toggleOptIn(): Promise<void> {
  act(() => optInBox().click());
  await settle();
}

/** Flush microtasks inside `act` so promise continuations' setState land. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function text(): string {
  return container.textContent ?? "";
}

function showsKeywordColumns(): boolean {
  return text().includes("Your resume mentions");
}

function showsSemanticVerdicts(): boolean {
  return /Met \(\d+\)/.test(text());
}

/** The tailor handoff trigger, absent when there is nothing to steer with. */
function tailorButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Tailor résumé to this job"),
  ) as HTMLButtonElement | undefined;
}

function progressBar(): HTMLElement | null {
  return container.querySelector('[role="progressbar"]');
}

/** The accessible label a screen reader would read for the opt-in control. */
function optInLabel(): string {
  const box = optInBox();
  const label = container.querySelector(`label[for="${box.id}"]`);
  return label?.textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
  webgpu = "available";
  modelId = "test-model";
  runs.length = 0;
  detectWebGpuMock.mockClear();
  runLlmMatchMock.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
});

// ── Default path: opt-in OFF ───────────────────────────────────────────────

describe("PasteJdPanel — semantic opt-in defaults OFF", () => {
  it("offers a labelled, unchecked opt-in control", async () => {
    mount();
    await setJd(JD_A);
    expect(optInBox().checked).toBe(false);
    expect(optInLabel()).toContain("Analyze with on-device AI");
  });

  it("renders the instant keyword result and no semantic chrome", async () => {
    mount();
    await setJd(JD_A);
    expect(showsKeywordColumns()).toBe(true);
    expect(showsSemanticVerdicts()).toBe(false);
    expect(progressBar()).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("never probes WebGPU, so no capability event enters the WebLLM funnel", async () => {
    // `detectWebGpu` fires `webllm_capability_detected` — the funnel's top
    // event. A keyword-only user must not appear in it at all.
    mount();
    await setJd(JD_A);
    expect(detectWebGpuMock).not.toHaveBeenCalled();
  });

  it("never loads the orchestrator, so no model download starts", async () => {
    mount();
    await setJd(JD_A);
    expect(runLlmMatchMock).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });
});

// ── Opting in ──────────────────────────────────────────────────────────────

describe("PasteJdPanel — opting in", () => {
  it("probes WebGPU only after the box is ticked, then starts one run", async () => {
    mount();
    await setJd(JD_A);
    expect(detectWebGpuMock).not.toHaveBeenCalled();

    await toggleOptIn();

    expect(detectWebGpuMock).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].jdText).toBe(JD_A);
    expect(runs[0].modelId).toBe("test-model");
  });

  it("keeps the keyword floor on screen for the whole engine load", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();

    // Loading: progress bar AND the keyword columns, not one replacing the
    // other. The keyword result is the "always show something" return hook.
    expect(progressBar()).toBeTruthy();
    expect(showsKeywordColumns()).toBe(true);

    act(() => runs[0].onProgress({ progress: 0.42, text: "shard 3 of 7" }));
    await settle();
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("42");
    expect(text()).toContain("shard 3 of 7");
    expect(showsKeywordColumns()).toBe(true);
  });

  it("moves to a truthful running line with no invented requirement counts", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();

    act(() => runs[0].onInferenceStart?.());
    await settle();

    expect(progressBar()).toBeNull();
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Reading this JD");
    // #204's example copy ("Judging requirement 4 of 9…") has no data behind
    // it — `judgeEvidence` reports no per-requirement progress. Nothing may
    // claim one.
    expect(text()).not.toMatch(/requirement \d+ of \d+/i);
    expect(showsKeywordColumns()).toBe(true);
  });

  it("swaps the keyword columns for the verdict list once the run resolves", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();

    act(() => runs[0].onInferenceStart?.());
    await settle();
    act(() => runs[0].resolve(semanticResult()));
    await settle();

    expect(showsSemanticVerdicts()).toBe(true);
    expect(text()).toContain("Run Kubernetes");
    expect(text()).toContain("Operated production clusters.");
    expect(text()).toContain("1 met · 0 partial · 1 missing");
    expect(showsKeywordColumns()).toBe(false);
    expect(progressBar()).toBeNull();
  });

  it("reuses a finished run when the box is toggled off and back on", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();
    act(() => runs[0].resolve(semanticResult()));
    await settle();
    expect(showsSemanticVerdicts()).toBe(true);

    await toggleOptIn(); // off
    expect(showsKeywordColumns()).toBe(true);
    expect(showsSemanticVerdicts()).toBe(false);

    await toggleOptIn(); // on again
    // The cached `ready` slot answers immediately: no second engine load, no
    // second extract + judge for a byte-identical input.
    expect(showsSemanticVerdicts()).toBe(true);
    expect(runs).toHaveLength(1);
  });
});

// ── No WebGPU ──────────────────────────────────────────────────────────────

describe("PasteJdPanel — no WebGPU", () => {
  it("keeps the keyword columns and explains in one muted line, with no error", async () => {
    webgpu = "no-webgpu";
    mount();
    await setJd(JD_A);
    await toggleOptIn();

    expect(showsKeywordColumns()).toBe(true);
    expect(showsSemanticVerdicts()).toBe(false);
    // Not an error and not a warning strip — the panel is not in a failed
    // state, it just can't add the optional layer.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("This browser can't run on-device analysis");
    expect(progressBar()).toBeNull();
  });

  it("starts no run at all", async () => {
    webgpu = "unsupported-os";
    mount();
    await setJd(JD_A);
    await toggleOptIn();
    expect(runLlmMatchMock).not.toHaveBeenCalled();
    expect(showsKeywordColumns()).toBe(true);
  });

  it("does not route the panel away and back while the probe is resolving", async () => {
    // The chosen UX for the detect window (#204 "no flicker"): the keyword
    // card stays mounted throughout and only the line under the checkbox
    // changes. Asserted by watching the card across every step.
    mount();
    await setJd(JD_A);
    expect(showsKeywordColumns()).toBe(true);
    act(() => optInBox().click()); // ticked; probe not yet resolved
    expect(showsKeywordColumns()).toBe(true);
    await settle(); // probe resolves
    expect(showsKeywordColumns()).toBe(true);
  });
});

// ── Cancellation / races (#803 seen from the UI) ────────────────────────────

describe("PasteJdPanel — cancellation and races", () => {
  it("opting out mid-load returns to keyword at once and aborts the run", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();
    expect(runs[0].signal?.aborted).toBe(false);

    await toggleOptIn(); // opt out while still loading

    expect(runs[0].signal?.aborted).toBe(true);
    expect(showsKeywordColumns()).toBe(true);
    expect(progressBar()).toBeNull();
  });

  it("opting out mid-inference aborts, and the abandoned verdict never flashes", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();
    act(() => runs[0].onInferenceStart?.());
    await settle();

    await toggleOptIn(); // opt out mid-inference
    expect(runs[0].signal?.aborted).toBe(true);
    expect(showsKeywordColumns()).toBe(true);

    // The abandoned run resolves LATE. Its write must be dropped.
    act(() => runs[0].resolve(semanticResult("STALE REQUIREMENT")));
    await settle();
    expect(text()).not.toContain("STALE REQUIREMENT");
    expect(showsSemanticVerdicts()).toBe(false);
    expect(showsKeywordColumns()).toBe(true);
  });

  it("a JD edit mid-run supersedes it; the old run's late result is ignored", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();

    await setJd(JD_B);
    expect(runs).toHaveLength(2);
    expect(runs[0].signal?.aborted).toBe(true);
    expect(runs[1].signal?.aborted).toBe(false);

    act(() => runs[0].resolve(semanticResult("STALE REQUIREMENT")));
    await settle();
    expect(text()).not.toContain("STALE REQUIREMENT");

    act(() => runs[1].resolve(semanticResult("FRESH REQUIREMENT")));
    await settle();
    expect(text()).toContain("FRESH REQUIREMENT");
  });

  it("does not report a superseded run as a failed analysis", async () => {
    // `runLlmMatch` resolves an aborted run to the KEYWORD arm by contract.
    // If that landed in the slot, the panel would tell the user analysis
    // "didn't return a verdict" every time they edited the JD mid-run. The
    // id guard drops the write, so the note must never appear.
    mount();
    await setJd(JD_A);
    await toggleOptIn();
    await setJd(JD_B);

    act(() => runs[0].resolve(keywordResult(JD_A)));
    await settle();

    expect(text()).not.toContain("didn't return a verdict");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("A → B → C rapid edits leave one live run and render only its result", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();
    await setJd(JD_B);
    await setJd(JD_C);

    expect(runs).toHaveLength(3);
    expect(runs[0].signal?.aborted).toBe(true);
    expect(runs[1].signal?.aborted).toBe(true);
    expect(runs[2].signal?.aborted).toBe(false);

    // Resolve them out of order, oldest last — the id guard, not arrival
    // order, is what decides which one is allowed to paint.
    act(() => runs[1].resolve(semanticResult("STALE B")));
    act(() => runs[2].resolve(semanticResult("FRESH C")));
    act(() => runs[0].resolve(semanticResult("STALE A")));
    await settle();

    expect(text()).toContain("FRESH C");
    expect(text()).not.toContain("STALE A");
    expect(text()).not.toContain("STALE B");
  });

  it("a model change mid-run aborts the old run and starts a fresh one", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();
    expect(runs).toHaveLength(1);

    modelId = "another-model";
    act(() => {
      root.render(<PasteJdPanel parsed={SPARSE_RESUME} onTailor={vi.fn()} />);
    });
    await settle();

    expect(runs).toHaveLength(2);
    expect(runs[0].signal?.aborted).toBe(true);
    expect(runs[1].modelId).toBe("another-model");
  });

  it("clearing the JD aborts the run and takes the panel back to nothing", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();

    await setJd("");

    expect(runs[0].signal?.aborted).toBe(true);
    expect(showsKeywordColumns()).toBe(false);
    expect(showsSemanticVerdicts()).toBe(false);
  });

  it("unmounting aborts the in-flight run", async () => {
    mount();
    await setJd(JD_A);
    await toggleOptIn();
    expect(runs[0].signal?.aborted).toBe(false);

    act(() => root.unmount());
    await settle(); // the abort is deferred by one microtask

    expect(runs[0].signal?.aborted).toBe(true);
  });

  it("StrictMode's double-invoke does not kill the live run", async () => {
    mount({ strict: true });
    await setJd(JD_A);
    await toggleOptIn();
    await settle();

    expect(runs).toHaveLength(1);
    expect(runs[0].signal?.aborted).toBe(false);

    act(() => runs[0].resolve(semanticResult()));
    await settle();
    expect(showsSemanticVerdicts()).toBe(true);
  });
});

// ── Fallback / failure ─────────────────────────────────────────────────────

describe("PasteJdPanel — semantic fallback", () => {
  it("routes a keyword-arm result from the semantic run back to the keyword view", async () => {
    // `runLlmMatch` never rejects: an engine failure, an unparseable
    // extraction or a JD with no requirements all come back as `path:
    // "keyword"`. The router must show coverage, not a blank panel.
    mount();
    await setJd(JD_A);
    await toggleOptIn();

    act(() => runs[0].resolve(keywordResult(JD_A)));
    await settle();

    expect(showsKeywordColumns()).toBe(true);
    expect(showsSemanticVerdicts()).toBe(false);
    expect(text()).toContain("On-device analysis didn't return a verdict");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("preserves the keyword floor when the orchestrator import itself fails", async () => {
    // The one failure `runLlmMatch`'s own contract can't absorb — the dynamic
    // import rejecting (a hashed chunk gone after a deploy). The hook falls
    // back to the keyword result it snapshotted; the panel must show it, and
    // must not leak the loader's message.
    runLlmMatchMock.mockImplementationOnce(() => {
      throw new Error(
        "Failed to fetch dynamically imported module: /assets/run-llm-match-a1b2c3.js",
      );
    });
    mount();
    await setJd(JD_A);
    await toggleOptIn();
    await settle();

    expect(showsKeywordColumns()).toBe(true);
    expect(text()).not.toContain("Failed to fetch dynamically imported module");
    expect(text()).not.toContain("run-llm-match-a1b2c3");
  });
});

// ── The tailor handoff derives from semantic verdicts when displayed (#867) ──

describe("PasteJdPanel — tailor steering with semantic opt-in (#867)", () => {
  it("hands over semantic-derived steering when semantic verdicts are on screen", async () => {
    const onTailor = vi.fn();
    mount({ onTailor });
    await setJd(JD_A);

    expect(tailorButton()).toBeTruthy();
    act(() => tailorButton()?.click());
    const keywordSteering = onTailor.mock.calls[0][0] as string;
    expect(keywordSteering).toContain("Kubernetes");

    // Once a semantic verdict has replaced the columns, the rewrite steering
    // is built from the semantic verdicts (#867).
    await toggleOptIn();
    const sem = semanticResult();
    act(() => runs[0].resolve(sem));
    await settle();
    expect(showsSemanticVerdicts()).toBe(true);

    act(() => tailorButton()?.click());
    expect(onTailor).toHaveBeenCalledTimes(2);
    const expectedSemanticSteering = buildJdRewriteContextFromVerdicts(
      sem.path === "semantic" ? sem.verdicts : [],
    );
    expect(expectedSemanticSteering).toBeTruthy();
    expect(onTailor.mock.calls[1][0]).toBe(expectedSemanticSteering);
    expect(onTailor.mock.calls[1][0]).toContain("Five years of Go");
    expect(onTailor.mock.calls[1][0]).not.toContain("Run Kubernetes");
  });

  it("renders the Tailor button for semantic missing requirements even when keyword coverage was 100%", async () => {
    const onTailor = vi.fn();
    const coveringResume: HeuristicParsedResume = {
      skills: ["Kubernetes", "Terraform", "Go"],
      experience: [
        {
          title: "Platform Engineer",
          company: "Acme",
          description:
            "Ran production infrastructure with Kubernetes, Terraform, and Go",
        },
      ],
      education: [],
    } as unknown as HeuristicParsedResume;

    mount({ parsed: coveringResume, onTailor });
    await setJd(JD_A);

    // Keyword coverage is 100% covered -> no tailor button initially
    expect(tailorButton()).toBeUndefined();

    // Opt into semantic analysis -> returns missing requirement "Five years of Go"
    await toggleOptIn();
    const sem = semanticResult();
    act(() => runs[0].resolve(sem));
    await settle();
    expect(showsSemanticVerdicts()).toBe(true);

    // Now Tailor button appears based on semantic gaps!
    expect(tailorButton()).toBeTruthy();
    act(() => tailorButton()?.click());
    expect(onTailor).toHaveBeenCalledTimes(1);
    const steering = onTailor.mock.calls[0][0] as string;
    expect(steering).toContain("Five years of Go");
    expect(steering).not.toContain("Run Kubernetes");
  });

  it("hides the Tailor button when all semantic verdicts are met", async () => {
    mount();
    await setJd(JD_A);

    expect(tailorButton()).toBeTruthy();

    await toggleOptIn();
    const allMetResult: JdMatchResult = {
      path: "semantic",
      verdicts: [
        {
          requirement: { id: "r1", kind: "skill", text: "React" },
          status: "met",
          reason: "Has React experience.",
        },
      ],
      summary: { met: 1, partial: 0, missing: 0, total: 1 },
    };
    act(() => runs[0].resolve(allMetResult));
    await settle();
    expect(showsSemanticVerdicts()).toBe(true);

    // All semantic requirements are met -> button is hidden
    expect(tailorButton()).toBeUndefined();
  });
});
