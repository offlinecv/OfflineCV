// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useResumeAnalysisLlm — the single controller driving both opt-in WebLLM
 * tabs ("What an ATS misses" #242 and "Resume quality" #244) from one
 * combined inference pass (issue #262).
 *
 * Replaces the previous `useParseDisagreement` + `useResumeCritique` pair
 * (each of which owned its own inference). One controller means:
 *   - One model load (already shared via `loadEngine`).
 *   - One acquire/release bracket around the whole run (the #148 contract).
 *   - One CTA the user clicks; both panels populate from the same status.
 *
 * The single-inference part of that story (`analyzeResumeWithLlm` returning
 * both halves) held until #1036: its `parse`/`critique` halves need to read
 * DIFFERENT text once the user has edited a bullet (see the docblock on the
 * hook below), so a run now also calls `critiqueResumeWithLlm` and discards
 * `analyzeResumeWithLlm`'s own critique half. Still one model load and one
 * acquire/release bracket — just no longer one inference call.
 *
 * The escape hatch (#243) stays a separate, degenerate-case pass (different
 * trigger + provenance) — see `useLlmEscapeHatch`.
 *
 * Telemetry: the controller emits `llm_parse_ran`, `disagreements_found`, and
 * `llm_critique_ran`. The three still fire in a single user action because they
 * describe distinct facts (LLM ran, gaps detected, critique completed). The
 * first was once a `cascade_parse_completed` re-emit; it now has its own name so
 * counting completed parses does not also count LLM passes — see the docblock on
 * `trackLlmParseRan` in `lib/analytics.ts`.
 *
 * Pure React/engine glue. The combined parse+diff logic lives in
 * `lib/webllm/analyze-resume.ts`; the critique logic lives in
 * `lib/webllm/critique-resume.ts`; the diff lives in
 * `lib/heuristics/disagreement.ts`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import {
  loadEngine,
  acquireInference,
  releaseInference,
} from "../lib/webllm/web-llm.ts";
import { analyzeResumeWithLlm } from "../lib/webllm/analyze-resume.ts";
import {
  critiqueResumeWithLlm,
  type ResumeCritique,
} from "../lib/webllm/critique-resume.ts";
import {
  diffParses,
  type ParseDisagreement,
} from "../lib/heuristics/disagreement.ts";
import { projectLlmDiff } from "../lib/heuristics/projections.ts";
import {
  trackAnalysisAborted,
  trackCritiqueRan,
  trackDisagreementsFound,
  trackLlmParseRan,
} from "../lib/analytics.ts";
import { requestModelConsent } from "./useModelConsent.ts";
import { SHIPPED_MODEL } from "../lib/webllm/models.ts";
import type {
  AnalysisPhase,
  ProgressUpdate,
  WebGpuCapability,
} from "../lib/webllm/types.ts";
import type {
  CascadeResult,
  LayoutTrigger,
} from "../lib/heuristics/types.ts";

// ── Status discriminator ──────────────────────────────────────────────────────

export interface AnalysisDone {
  /** Heuristic-vs-LLM diff (feeds the "What an ATS misses" tab). */
  disagreements: readonly ParseDisagreement[];
  /** Quality findings (feeds the "Resume quality" tab). */
  critique: ResumeCritique;
}

export type AnalysisStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  /**
   * `phase` + `tokens` (#1095) replace the old static "Analyzing…" line: the
   * panel shows which of the two passes is running and a token count that
   * visibly climbs, so a slow-but-alive run reads differently from a hung
   * one. `tokens` resets to 0 at the start of each phase.
   */
  | { kind: "running"; phase: AnalysisPhase; tokens: number }
  | ({ kind: "done" } & AnalysisDone)
  | { kind: "error"; message: string };

// ── Controller interface ──────────────────────────────────────────────────────

export interface AnalysisController {
  status: AnalysisStatus;
  /**
   * `false` hides the live analysis surface (no WebGPU, or no text to
   * analyze). When it's false *because* WebGPU is unavailable, the tab now
   * renders `WebGpuUnavailableNotice` instead of vanishing (#276) — the caller
   * distinguishes the two via `capability` + `hasText` below.
   */
  isAvailable: boolean;
  /**
   * WebGPU detection outcome (`null` until it resolves). Exposed so the tab can
   * tell "browser can't run on-device AI" (show the explainer) from "no résumé
   * text to analyze" (show nothing). See #276.
   */
  capability: WebGpuCapability | null;
  /** Whether there's extractable text to analyze (independent of WebGPU). */
  hasText: boolean;
  /** True while the model is loading or the inference is in flight. */
  isBusy: boolean;
  /** Start the opt-in combined analysis. No-op while already busy. */
  run: () => Promise<void>;
  /**
   * Cancel a `running` pass (#1095) — stops consuming the current phase's
   * stream and returns `status` to `idle`. No-op outside `kind: "running"`
   * (in particular, it does not cancel the model load — `loading` has no
   * cancel path today). The already-in-flight engine call may keep running
   * in the background; see `stream-completion.ts`'s docblock for why this
   * deliberately does NOT call the engine-wide `interruptGenerate()`.
   */
  stop: () => void;
}

// ── CTA copy ──────────────────────────────────────────────────────────────────

const ANALYSIS_LABELS: Record<AnalysisStatus["kind"], string> = {
  idle: "Analyze with on-device model",
  loading: "Loading model…",
  running: "Analyzing…",
  done: "Analyze again",
  error: "Try again",
};

/** Label for the shared CTA across the status lifecycle. */
export function labelForAnalysis(status: AnalysisStatus): string {
  return ANALYSIS_LABELS[status.kind];
}

// ── Disagreement tally (telemetry) ────────────────────────────────────────────

interface KindTally {
  droppedRole: number;
  droppedSection: number;
  missingField: number;
  mergedRoles: number;
}

const TALLY_FIELD: Record<ParseDisagreement["kind"], keyof KindTally> = {
  dropped_role: "droppedRole",
  dropped_section: "droppedSection",
  missing_field: "missingField",
  merged_roles: "mergedRoles",
};

function tallyKinds(disagreements: readonly ParseDisagreement[]): KindTally {
  const tally: KindTally = {
    droppedRole: 0,
    droppedSection: 0,
    missingField: 0,
    mergedRoles: 0,
  };
  for (const d of disagreements) tally[TALLY_FIELD[d.kind]]++;
  return tally;
}

// ── Cancellation + deadline (#1095) ───────────────────────────────────────────

/**
 * Wall-clock budget for ONE phase (parse OR critique), not the whole run.
 * The issue's field report: a swapping 8 GB M1 took 10–15 minutes total for
 * both passes combined on the shipped 2B model (~3–5k tokens at ~5 tok/s);
 * a healthy machine finishes both in 1–3 minutes. 4 minutes gives a single
 * phase roughly the healthy-machine's full-run budget again before treating
 * it as hung, without making a genuinely slow-but-alive device wait through
 * the full 10–15 minute worst case with zero feedback.
 */
const PHASE_DEADLINE_MS = 4 * 60 * 1000;

const DEADLINE_MESSAGE =
  "This is taking longer than expected — the on-device model may be short on memory. Close other tabs and try again.";

type AbortReason = "user" | "deadline";

/**
 * Thrown by `runPhase` (below) when its `AbortController` fires — either the
 * user clicked Stop or the phase's own deadline timer elapsed. Distinct from
 * every other error `run()` can catch so the `catch` block can route the two
 * outcomes differently: `"user"` returns to `idle` silently, `"deadline"`
 * surfaces `kind: "error"` with a memory hint.
 */
class PhaseAbortedError extends Error {
  constructor(
    readonly phase: AnalysisPhase,
    readonly reason: AbortReason,
    readonly durationMs: number,
  ) {
    super(`Analysis aborted during ${phase} (${reason})`);
    this.name = "PhaseAbortedError";
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * `resetKey` is the parse identity (`useAnalyzedResume.parseKey`): a new résumé
 * returns the panel to idle, an edit does not. `result` is edit-folded and
 * changes on every keystroke, so it cannot be the key — keyed on it, the first
 * edit discarded a finished critique, including the findings Fix It steps
 * through (#1008).
 *
 * A run drives TWO passes over one loaded engine, deliberately reading two
 * different texts (#1036):
 *   - `analyzeResumeWithLlm` reads `result.rawText` / `result.markdown` — the
 *     extractor's ORIGINAL text, unedited by `foldEditedIntoResult` on
 *     purpose (#445) — because its `parse` half feeds `diffParses`, which
 *     answers "what did the extractor misread", not "what did the user
 *     rewrite". Its `critique` half is discarded.
 *   - `critiqueResumeWithLlm` reads `result.canonical.fields` — which IS
 *     edited, since `foldEditedIntoResult` folds overrides onto exactly that
 *     — so a run made after an edit grades the wording on the page, and a
 *     finding for an edited bullet matches it in Fix It (`matchCritiqueFindings`,
 *     #1008).
 */
export function useResumeAnalysisLlm(
  result: CascadeResult,
  resetKey: unknown,
): AnalysisController {
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [status, setStatus] = useState<AnalysisStatus>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void detectWebGpu().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A fresh parse (new file) resets the panels — keyed on the parse identity,
  // never on `result` (see the docblock).
  useEffect(() => {
    setStatus({ kind: "idle" });
  }, [resetKey]);

  // Whether there is any text for the LLM to analyze. A scanned/empty PDF has
  // none, so the combined pass would be vacuous — treat as unavailable.
  const hasText = (result.markdown ?? result.rawText).trim().length > 0;

  const isBusy = status.kind === "loading" || status.kind === "running";

  // Set synchronously, before the consent await: `status` only turns busy
  // after the dialog is answered, so without this a double-click queues two
  // runs behind one consent. Released on decline and on every finish.
  const inFlightRef = useRef(false);

  // The active run's cancellation handle (#1095) — one `AbortController` per
  // `run()` call, shared by both phases so `stop()` cancels whichever is
  // current. `null` outside a run (including during model load, which has no
  // cancel path yet — see `stop`'s docblock).
  const abortControllerRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortControllerRef.current?.abort("user" satisfies AbortReason);
  }, []);

  const run = useCallback(async () => {
    if (inFlightRef.current || isBusy) return;
    inFlightRef.current = true;
    const modelId = SHIPPED_MODEL.id;
    try {
      // Consent first (#1015): a decline leaves the panel as it was.
      if (!(await requestModelConsent())) return;
      // #148 contract — acquire before the engine await.
      acquireInference(modelId);
      try {
        setStatus({
          kind: "loading",
          progress: { progress: 0, text: "Starting…" },
        });
        const engine = await loadEngine(modelId, (progress) => {
          setStatus({ kind: "loading", progress });
        });

        const controller = new AbortController();
        abortControllerRef.current = controller;

        // Runs `fn` under its own `PHASE_DEADLINE_MS` timer, on the shared
        // `controller` so `stop()` (fired from either phase) always hits the
        // one that's current. Streamed token progress lands on `setStatus`
        // via `fn`'s own `onProgress` callback; this wrapper only owns the
        // phase's start marker, its deadline, and turning an abort into a
        // `PhaseAbortedError` the outer `catch` can route.
        const runPhase = async <T,>(
          phase: AnalysisPhase,
          fn: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          setStatus({ kind: "running", phase, tokens: 0 });
          const phaseStart = Date.now();
          const timer = setTimeout(() => {
            controller.abort("deadline" satisfies AbortReason);
          }, PHASE_DEADLINE_MS);
          try {
            return await fn(controller.signal);
          } catch (err) {
            if (controller.signal.aborted) {
              const reason: AbortReason =
                controller.signal.reason === "user" ? "user" : "deadline";
              throw new PhaseAbortedError(
                phase,
                reason,
                Date.now() - phaseStart,
              );
            }
            throw err;
          } finally {
            clearTimeout(timer);
          }
        };

        const combined = await runPhase("parse", (signal) =>
          analyzeResumeWithLlm(
            {
              rawText: result.rawText,
              ...(result.markdown ? { markdown: result.markdown } : {}),
            },
            engine,
            {
              signal,
              onProgress: (info) =>
                setStatus({ kind: "running", ...info }),
            },
          ),
        );

        // The critique must grade the wording on the page, not the extractor's
        // original text `combined` was built from (#1036) — re-run it over the
        // current (possibly edited) canonical fields. `combined.critique` is
        // discarded.
        const critiqueStart = Date.now();
        const critique = await runPhase("critique", (signal) =>
          critiqueResumeWithLlm(result.canonical.fields, engine, {
            signal,
            onProgress: (info) => setStatus({ kind: "running", ...info }),
          }),
        );

        // ── Telemetry: the LLM pass ran (sets llm_ran:true downstream). ──
        trackLlmParseRan({ model: modelId });

        // ── Diff the LLM parse against the heuristic parse. ──
        // Both sides are canonical shapes: the cascade canonical and the LLM
        // parse coerced through `projectLlmDiff`. `diffParses` derives its
        // whole-section-drop gate from the heuristic canonical's own section
        // headers, so the call site no longer computes `presentSections` (#445).
        // `groundingText` is the EXACT prompt body `analyzeResumeWithLlm` was
        // given above (#1093) — never a re-derived or edited text — so a card
        // is shown only for content demonstrably on the page the model read.
        const triggers = result.triggers as LayoutTrigger[];
        const groundingText = result.markdown ?? result.rawText;
        const { disagreements, rejectedUngrounded } = diffParses(
          result.canonical,
          projectLlmDiff(combined.parse),
          triggers,
          groundingText,
        );
        const tally = tallyKinds(disagreements);
        trackDisagreementsFound({
          model: modelId,
          count: disagreements.length,
          triggers,
          rejectedUngrounded,
          ...tally,
        });

        // ── Critique telemetry: anonymized — no bullet text, no PII. ──
        const flaggedCount = critique.bulletFindings.filter(
          (f) => f.issue !== "ok",
        ).length;
        trackCritiqueRan({
          model: modelId,
          bulletCount: critique.bulletFindings.length,
          flaggedCount,
          missingSectionCount: critique.missingSections.length,
          metricOverrides: critique.metricOverrides ?? 0,
          durationMs: Date.now() - critiqueStart,
        });

        setStatus({
          kind: "done",
          disagreements,
          critique,
        });
      } catch (err) {
        if (err instanceof PhaseAbortedError) {
          trackAnalysisAborted({
            model: modelId,
            phase: err.phase,
            reason: err.reason,
            durationMs: err.durationMs,
          });
          setStatus(
            err.reason === "user"
              ? { kind: "idle" }
              : { kind: "error", message: DEADLINE_MESSAGE },
          );
        } else {
          setStatus({
            kind: "error",
            message:
              err instanceof Error
                ? err.message
                : "Couldn't load the on-device model",
          });
        }
      } finally {
        abortControllerRef.current = null;
        releaseInference(modelId);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [result, isBusy]);

  const isAvailable = capability === "available" && hasText;

  return { status, isAvailable, capability, hasText, isBusy, run, stop };
}
