// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `useJdMatch` — controller for the paste-a-JD → JD-match flow (#203).
 *
 * The keyword path is derived SYNCHRONOUSLY via `useMemo` — same shape as the
 * pre-#203 inline pipeline that lived in `PasteJdPanel`. When the debounced
 * JD text changes, the keyword result lands on the SAME commit as the input
 * change; no effect flush is needed to observe it. This is the invariant
 * the issue's "synchronous keyword fast-resolve" wording protects.
 *
 * The keyword arm adds no RUNTIME WebLLM work over pre-#203 — no engine probe,
 * no capability detection, no WebLLM analytics event on the mount of a
 * keyword-only consumer. `detectWebGpu` is called only when `semanticOptIn`
 * flips true; the capability effect is gated on that same input.
 *
 * It is NOT a zero-cost import, and the gap is worth stating exactly rather
 * than rounding to "touches nothing": `useModelSelection` is a hook, so it
 * cannot be called conditionally, which means a keyword-only consumer still
 * pays (a) its module-load `readPersistedModelId()` + `readAllConsent()`
 * localStorage reads, (b) a page-lifetime `storage` listener registered on
 * first subscribe, and (c) a static `capability.ts` → `analytics.ts` edge in
 * the `/jobs/` entry chunk (measured: +0.71 kB gzip, and `run-llm-match` stays
 * a lazy chunk). No analytics EVENT fires — that is the part that would have
 * polluted the WebLLM funnel's top event. Making the imports conditional too
 * would mean moving the semantic machinery into a child hook mounted only on
 * opt-in; #204 can restructure if it turns out to matter.
 *
 * The semantic path (`semanticOptIn === true` AND WebGPU available) delegates
 * to `runLlmMatch` — the same orchestrator #202 landed — through a slot bound
 * to the input values it was computed for. The slot is compared to current
 * inputs BY VALUE, not by `useMemo` reference identity: React documents
 * `useMemo` as a cache it MAY discard (`<Activity>` / offscreen already does),
 * which would invalidate a completed slot on a byte-identical new reference
 * and restart a full LLM run. Value comparison is immune.
 *
 * `status` is the semantic-refinement channel; `keyword` is the floor. The
 * controller returns BOTH because `status` cannot express "engine still
 * loading AND keyword coverage already available" — the semantic arm has to
 * occupy `loading`/`running` for the whole engine-load window, which on a cold
 * cache is minutes. Render `keyword` and layer `status` over it; that is what
 * makes "keyword is always available" true of the API and not just of the
 * prose.
 *
 * State machine — one input, one status object:
 *
 *   idle
 *     · debounced JD is empty (post-trim), or extract yielded zero terms.
 *   ready (keyword, synchronous, render-time)
 *     · semantic opt-in is off, OR WebGPU is unavailable, OR still detecting.
 *       Result is `{ path: "keyword", coverage, terms, nounsDropped }`.
 *   loading → running → ready (semantic, async)
 *     · semantic opt-in is on AND WebGPU is available.
 *       - `loading` while `loadEngine` streams progress (or as a placeholder
 *         on the first render for a fresh input tuple).
 *       - `running` after engine load, during extract + judge.
 *       - `ready` with the assembled JdMatchResult.
 *   error
 *     · Kept in the union for #204's opt-in UI to consume, but not reachable
 *       today: a semantic run only starts when `takingSemanticPath` is true,
 *       which requires `keywordResult !== null`; the catch snapshots that
 *       non-null value into `fallbackKeyword` and always writes `ready` on
 *       an unexpected rejection. A future consumer where the semantic path
 *       runs without a keyword fallback (a "semantic-only" mode) would
 *       reach this branch; keeping it here means the surface for that is
 *       already public.
 *
 * Stale-request protection has TWO layers plus a THIRD one for the WORK, not
 * the writes. All three are load-bearing on DIFFERENT scenarios:
 *   1. `requestIdRef` — a monotonic counter bumped on every semantic run
 *      start AND on every exit from the semantic path (opt-out, JD cleared,
 *      capability change). The exit ALSO clears the slot unless it holds a
 *      `ready` result: a finished answer for unchanged inputs is worth
 *      caching across an opt-out → opt-in toggle (otherwise the toggle
 *      re-runs a full engine load + extract + judge for a byte-identical
 *      result), while a partial slot would strand a spinner and an `error`
 *      slot would deny a retry. Every callback (`onProgress`, `onInferenceStart`,
 *      final resolve, catch) checks the id captured at start against the
 *      current one and drops its own write on a mismatch. This is what stops
 *      WebLLM's per-tick `onProgress` from re-rendering the panel through a
 *      hundreds-of-megabytes weight download after the user opted out.
 *      (`mountedRef` piggybacks on the same gate, but unlike the id it is
 *      unverifiable intent rather than tested behaviour — see the note on
 *      `setSlotIfCurrent`.)
 *   2. Slot-vs-current-input VALUE comparison in the derived status memo.
 *      A slot whose stored `jdText`/`modelId` don't match current values, or
 *      whose stored `parsed` reference no longer matches, is invisible to
 *      the render. This is what stops a stale slot from flashing over a
 *      newer render even if a late write slipped past layer 1.
 *   3. `controllerRef` — an `AbortController` per semantic run (#803).
 *      Aborted whenever the id would be bumped: run supersession, opt-out,
 *      JD change to a new value or empty, model change, capability going
 *      false, unmount. The id guard prevents stale WRITES from becoming
 *      visible; the abort controller stops the WORK — extract's coercion
 *      pass, and every judge batch after the currently in-flight one. The
 *      residual bound is one loadEngine await plus one currently-in-flight
 *      completion (extract OR one judge batch); every downstream stage is
 *      cancelled. See `runLlmMatch`'s docblock for the boundary map.
 *
 *      Unmount abort is deferred by ONE microtask, guarded by `mountedRef`.
 *      This is a BELT, not a fix for a reachable bug, and the distinction is
 *      worth stating because the shape looks like one. The mount effect has
 *      `[]` deps, so its cleanup fires exactly twice: at StrictMode's
 *      simulated unmount on the initial mount, and at real unmount. At the
 *      initial one, `debouncedJdText` is still `""` (a 200 ms timeout away)
 *      and `capability` is still `null` (a promise away), so
 *      `takingSemanticPath` is false through the whole synchronous
 *      double-invoke and `controllerRef.current` is null — there is no run
 *      to kill. A synchronous abort here would be a no-op TODAY.
 *
 *      What the hop buys: if a future change ever lets a run start before
 *      the first commit settles, StrictMode's synchronous re-mount body
 *      re-sets `mountedRef.current = true` before the queued microtask runs,
 *      so the live run survives; on a REAL unmount no re-mount runs,
 *      `mountedRef` stays false, and the abort fires. It also keeps a stale
 *      microtask queued by the double-invoke from later killing the real
 *      run. Same synchronous-commit-then-microtask ordering that makes
 *      #203's own `mountedRef.current = true` re-set pattern work.
 *
 * `parsed` identity contract: the hook treats `parsed` by REFERENCE, and the
 * failure mode is worse than a wasted recompute. A caller that builds `parsed`
 * inline in render hands over a fresh reference every render, so the slot
 * never matches, so the effect starts a run and writes the slot, which
 * re-renders, which mismatches again — an unbounded update loop, not a bounded
 * "restart once per render". Today's producer is safe: `JobsApp.tsx` reads the
 * handoff through a lazy `useState` initializer, so the reference is stable for
 * the whole session, and `FindJobsPanel` passes it straight through. A future
 * consumer that derives `parsed` MUST memoize it before handing it here.
 *
 * WebGPU detection uses `detectWebGpu`, which caches the result for the page
 * lifetime — the same signal `useResumeRewrite` reads. `useModelSelection`
 * supplies the persisted model id, so the picker on the WebLLM surfaces
 * drives which model this hook loads.
 *
 * Live since #204: `PasteJdPanel` owns an "Analyze with on-device AI" checkbox
 * (default OFF) and passes it as `semanticOptIn`. With the box unticked every
 * gate above still holds — no probe, no engine, no WebLLM event — so an
 * untouched panel is byte-identical to pre-#203. #204 added one thing to this
 * hook's surface: `capability` on the return, because the UI cannot otherwise
 * tell "WebGPU is unavailable" from "the semantic run degraded".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectWebGpu } from "../lib/webllm/capability.ts";
import { computeCoverage } from "../lib/jd-match/coverage.ts";
import { extractJdTerms } from "../lib/jd-match/extract-jd-terms.ts";
import type {
  JdMatchResult,
  KeywordJdMatchResult,
} from "../lib/jd-match";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type {
  ProgressUpdate,
  WebGpuCapability,
} from "../lib/webllm/types.ts";
import { useModelSelection } from "./useModelSelection.ts";

/** Debounce interval for the JD text — matches the pre-#203 200ms value
 *  `PasteJdPanel` used inline. Under the perceptual threshold for a "typed a
 *  character, saw the panel react" loop while still coalescing a 10-key
 *  burst into one compute. */
export const JD_MATCH_DEBOUNCE_MS = 200;

export type JdMatchStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "running" }
  | { kind: "ready"; result: JdMatchResult }
  | { kind: "error"; message: string };

export interface UseJdMatchOptions {
  /** The parsed résumé the coverage check runs against.
   *
   *  Treated by REFERENCE for semantic-run freshness: a fresh object every
   *  render will restart the semantic run. Memoize at the caller side; the
   *  producers this hook has today (`FindJobsPanel` fed from `JobsApp`'s
   *  handoff, itself a lazy `useState` initializer) already do. */
  parsed: HeuristicParsedResume;
  /** Raw JD text; the hook debounces internally. */
  jdText: string;
  /**
   * Opt into the semantic (WebLLM) path. Default `false` → keyword-only,
   * no engine load, no WebGPU probe, no WebLLM analytics event, byte-
   * identical to pre-#203 behavior.
   *
   * Even when `true`, the hook still resolves to keyword when WebGPU is
   * unavailable or still being detected — the semantic path is a
   * best-effort enhancement, not a requirement.
   */
  semanticOptIn?: boolean;
}

export interface JdMatchController {
  status: JdMatchStatus;
  /**
   * The synchronous keyword result for the current debounced JD, whenever one
   * exists — INDEPENDENT of what `status` is showing.
   *
   * `status` alone cannot express "the engine is loading AND keyword coverage
   * is already available", because the semantic arm has to occupy `loading` /
   * `running` for the whole engine-load window. On a cold cache that is
   * minutes, and `keywordResult` is non-null the entire time (it is a
   * precondition of taking the semantic path at all). A consumer that read
   * only `status` would have to render an empty progress spinner over
   * coverage it already had.
   *
   * So the docblock's "keyword is always available" is a property of the
   * CONTROLLER, not of `status`: render `keyword` as the floor and let
   * `status` layer the semantic refinement on top. `null` only when the JD is
   * empty/degenerate — exactly when `status` is `idle`.
   *
   * Typed as the KEYWORD ARM, not the whole union (#866 review). `keywordResult`
   * below can only ever build `{ path: "keyword", … }` or `null`, so declaring
   * the union let the compiler forget an invariant the code guarantees — and
   * `PasteJdPanel` paid for it with a `keyword?.path === "keyword" ? … : null`
   * re-narrowing that could never take its false branch. Naming the arm moves
   * that from a runtime check to a compile-time fact.
   */
  keyword: KeywordJdMatchResult | null;
  /**
   * The detected WebGPU capability, or `null` while detection has not run or
   * has not resolved. Read-only view of the hook's own probe — the consumer
   * must NOT call `detectWebGpu` itself (that would fire the WebLLM funnel's
   * top analytics event outside this hook's opt-in gate).
   *
   * Exposed for #204: with `semanticOptIn` on and WebGPU unavailable, `status`
   * settles on `ready` with the KEYWORD result — indistinguishable from
   * opt-in-off, and from a semantic run that degraded. The UI needs the
   * difference to explain, in one muted line, why ticking the box changed
   * nothing. Stays `null` for a keyword-only consumer, since the probe is
   * gated on the opt-in.
   */
  capability: WebGpuCapability | null;
}

/** Module-level constants so a keyword-path render's `status` doesn't produce
 *  a new `{ kind: "idle" }` object identity on every derive (React's setState
 *  bail-out is reference-based).
 *
 *  Frozen because these are shared singletons handed straight to consumers —
 *  a consumer that wrote to `status.progress` would corrupt the constant for
 *  every later render and every other consumer on the page. */
const IDLE_STATUS: JdMatchStatus = Object.freeze({ kind: "idle" });
/** Typed as the narrower `SemanticSubState` variant so it can seed the
 *  semantic slot without a widening cast; assignable to `JdMatchStatus`
 *  since the sub-state is a subset. */
const LOADING_START: { kind: "loading"; progress: ProgressUpdate } =
  Object.freeze({
    kind: "loading",
    progress: Object.freeze({ progress: 0, text: "Starting…" }),
  });

/** The tuple the slot's freshness is checked against. Compared by VALUE for
 *  the primitive fields and by REFERENCE for `parsed` (see the docblock's
 *  caller-obligation note). */
interface SemanticInputs {
  jdText: string;
  parsed: HeuristicParsedResume;
  modelId: string;
}

function semanticInputsMatch(
  slot: SemanticInputs,
  jdText: string,
  parsed: HeuristicParsedResume,
  modelId: string,
): boolean {
  return (
    slot.jdText === jdText &&
    slot.parsed === parsed &&
    slot.modelId === modelId
  );
}

/** The semantic sub-state the async orchestration produces. `ready` here is
 *  the semantic-arm ready (arm chosen by `runLlmMatch`, which may itself
 *  degrade to a keyword result on internal failure — the arm is still
 *  determined by the orchestrator, not by the hook). */
type SemanticSubState =
  | { kind: "loading"; progress: ProgressUpdate }
  | { kind: "running" }
  | { kind: "ready"; result: JdMatchResult }
  | { kind: "error"; message: string };

interface SemanticSlot {
  /** Snapshot of the inputs the run was started for. Compared BY VALUE
   *  against current inputs during render — a mismatch means this slot is
   *  stale. Immune to `useMemo` cache discards, unlike a reference check. */
  inputs: SemanticInputs;
  state: SemanticSubState;
}

export function useJdMatch(options: UseJdMatchOptions): JdMatchController {
  const { parsed, jdText, semanticOptIn = false } = options;

  const [debouncedJdText, setDebouncedJdText] = useState("");
  const [capability, setCapability] = useState<WebGpuCapability | null>(null);
  const [semanticSlot, setSemanticSlot] = useState<SemanticSlot | null>(null);
  const { selectedModelId } = useModelSelection();

  // Canonical trimmed JD. Both keyword extraction and semantic freshness key
  // off THIS value, so a trailing-space edit that trims to the same text
  // never restarts the LLM run (was: `debouncedJdText` deps produced a fresh
  // `semanticInputs` reference for byte-identical trimmed content).
  const trimmedJdText = useMemo(
    () => debouncedJdText.trim(),
    [debouncedJdText],
  );

  // WebGPU capability detection — GATED on `semanticOptIn`. Keyword-only
  // consumers never call `detectWebGpu`, so no `webllm_capability_detected`
  // event fires (the WebLLM funnel's top event) and no
  // `navigator.gpu.requestAdapter()` runs on the `/jobs/` page. `detectWebGpu`
  // caches its result per page, so an opted-in flip re-uses a cached probe
  // if one exists. `cancelled` guards against a write after unmount.
  //
  // Opting out CLEARS the value rather than merely stopping (#866 review).
  // Leaving it set made `capability`'s own docblock false the moment a user
  // toggled off — it claims the field stays `null` for a keyword-only
  // consumer, and every consumer that doesn't replicate `SemanticAnalysisOptIn`'s
  // "check `checked` before reading `capability`" gate would have shown a
  // stale probe result to an opted-out user. Now the field means what it says
  // on its own, without a companion flag.
  //
  // Three things this deliberately does NOT do:
  //   - It does not probe. `setCapability(null)` is a state write; the
  //     `detectWebGpu()` call is on the other side of the early return, so
  //     opting out still touches no WebGPU and fires no analytics.
  //   - It does not re-render on mount. React bails out of a `setState` that
  //     is `Object.is`-equal to the current value, and the initial value is
  //     already `null`, so the keyword-only path costs one bail-out and no
  //     commit.
  //   - It does not race the in-flight probe. Cleanup sets `cancelled` before
  //     the next effect run's write, so an opt-out mid-probe cancels the
  //     pending `.then` first and clears second — a late resolve cannot
  //     restore a value after opt-out. Re-opting in calls `detectWebGpu()`
  //     again, which returns its cached promise: no second `requestAdapter()`
  //     and no duplicate funnel event.
  useEffect(() => {
    if (!semanticOptIn) {
      setCapability(null);
      return;
    }
    let cancelled = false;
    void detectWebGpu().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, [semanticOptIn]);

  // JD text debounce. Only the debounced value drives the pipeline, so a
  // fast typist runs one compute instead of ten — same 200ms interval
  // `PasteJdPanel` used inline before this hook existed.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedJdText(jdText), JD_MATCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [jdText]);

  // SYNCHRONOUS keyword result — render-time, no effect. Identical shape and
  // trimming rules to the pre-#203 `PasteJdPanel` inline `useMemo`, so a
  // keyword-only consumer's status becomes `ready` on the SAME commit as
  // `debouncedJdText` changes.
  const keywordResult = useMemo<KeywordJdMatchResult | null>(() => {
    if (trimmedJdText.length === 0) return null;
    const extracted = extractJdTerms(trimmedJdText);
    if (extracted.all.length === 0) return null;
    return {
      path: "keyword",
      coverage: computeCoverage(parsed, extracted.all),
      terms: extracted.all,
      nounsDropped: extracted.nounsDropped,
    };
  }, [trimmedJdText, parsed]);

  // We take the semantic path iff opt-in AND WebGPU available AND we have a
  // non-null keyword result (empty/degenerate JDs skip semantic entirely,
  // matching the pre-#203 no-op branch).
  const takingSemanticPath =
    semanticOptIn && capability === "available" && keywordResult !== null;

  // Derived status — the single source of truth the consumer reads. Every
  // branch is a render-time compute; no effect flush is needed for the
  // keyword arm to become `ready`.
  const status = useMemo<JdMatchStatus>(() => {
    if (keywordResult === null) return IDLE_STATUS;
    if (!takingSemanticPath) {
      return { kind: "ready", result: keywordResult };
    }
    // Semantic path. Compare slot inputs BY VALUE, not by reference — a
    // useMemo cache discard would invalidate a byte-identical slot otherwise.
    if (
      semanticSlot !== null &&
      semanticInputsMatch(
        semanticSlot.inputs,
        trimmedJdText,
        parsed,
        selectedModelId,
      )
    ) {
      return semanticSlot.state;
    }
    return LOADING_START;
  }, [
    keywordResult,
    takingSemanticPath,
    semanticSlot,
    trimmedJdText,
    parsed,
    selectedModelId,
  ]);

  // ── Semantic orchestration ─────────────────────────────────────────────
  //
  // The effect below is the ONLY source of async state; the keyword arm and
  // all synchronous transitions bypass it entirely. Everything below runs
  // only when a semantic run must be started or is in flight.

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  /** Per-run AbortController (#803). Non-null from run-start until the run is
   *  superseded or aborted — a COMPLETED run's controller is deliberately left
   *  in place (nothing in the `.then`/`.catch` nulls it) and is harmlessly
   *  re-aborted later, since `abort()` on a settled controller is a spec no-op.
   *  That no-op is exactly what makes the opt-out branch safe against a `ready`
   *  slot. Nulled on abort so a stray follow-up abort call can't hit a fresh
   *  run that has since reused the ref slot. */
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // Re-set on every mount, not just at hook creation: under React
    // StrictMode the first effect-cleanup fires between the two effect
    // runs, so a bare `useRef(true)` initializer would leave the ref
    // stale-`false` on the real mount and every in-flight write would
    // be dropped as if the component had unmounted.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Unmount abort (#803, requirement §5). Deferred by one microtask,
      // gated on `mountedRef.current` still being false — see the
      // Layer-3 rationale in the module docblock for why the defer is a
      // belt against a future ordering rather than a live bug fix.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        controllerRef.current?.abort();
        controllerRef.current = null;
      });
    };
  }, []);

  // Guarded slot writer: `myId` is the request-id snapshot the caller took
  // at run-start, `inputs` is the snapshot the run was started for.
  //
  // The id guard is the load-bearing one — it blocks late writes from a run
  // whose caller left the semantic path or moved to a newer run, and it is
  // covered by the stale-progress test.
  //
  // The `mountedRef` guard is intent, not verified behaviour: React 19 makes
  // a setState on an unmounted root a no-op and emits no warning, so no test
  // can tell it from its own absence (both oracles were tried — see the note
  // in the test file). It stays because that no-op is an implementation
  // detail rather than a contract; do not add a test claiming to pin it.
  const setSlotIfCurrent = useCallback(
    (myId: number, inputs: SemanticInputs, state: SemanticSubState) => {
      if (!mountedRef.current) return;
      if (requestIdRef.current !== myId) return;
      setSemanticSlot({ inputs, state });
    },
    [],
  );

  useEffect(() => {
    // Not on the semantic path. Invalidate any in-flight run so its per-tick
    // `onProgress` writes stop re-rendering the panel through the rest of a
    // weight download.
    //
    // Whether the SLOT survives depends on what is in it, and the two cases
    // pull in opposite directions:
    //   - A partial (`loading`/`running`) slot must go. Kept, it would be a
    //     stuck spinner on opt-back-in: the effect would see inputs that
    //     still match and early-return, so nothing would ever restart the
    //     run that the id bump just orphaned.
    //   - A `ready` slot must stay. It is a finished answer for these exact
    //     inputs, and clearing it means an opt-out → opt-in toggle throws
    //     away a multi-minute engine load plus a full extract + judge and
    //     re-runs all of it for a byte-identical result. Discarding real
    //     inference on a toggle that changed no input is the expensive half
    //     of this branch, so it is the half worth keeping.
    //   - An `error` slot must ALSO go, for a different reason than the
    //     partial ones: kept, it would early-return on opt-back-in and pin
    //     the user to a failure with no way to retry short of editing the JD.
    //     Only `ready` is worth caching; a failure should get another try.
    // The id bump happens either way — orphaning late writes is what stops
    // the download-progress re-renders, and it is independent of the slot.
    if (!takingSemanticPath) {
      // Gated on the CONTROLLER as well as the slot, not the slot alone. The
      // controller is installed synchronously at run-start while the matching
      // `setSemanticSlot` is only scheduled, so "slot non-null" is a proxy for
      // "a run exists" that holds only because `semanticSlot` is itself a dep
      // of this effect — React therefore applies the run-start state update
      // before any commit can observe `takingSemanticPath === false` against
      // the pre-run slot. That is true under React 18/19 automatic batching
      // and has no reachable counterexample today, but a refactor that moved
      // the kickoff behind a promise would silently strand a live, un-aborted
      // controller. Reading the ref directly makes the branch not depend on
      // the ordering at all.
      if (semanticSlot !== null || controllerRef.current !== null) {
        requestIdRef.current += 1;
        // Layer-3 (#803): stop the WORK, not just the writes. Aborting here
        // prevents the abandoned run's `extractRequirements` coercion pass
        // and every subsequent judge batch from executing on the shared
        // engine. The id bump above still handles late writes independently
        // — the two guards protect different things. Null the ref after so
        // a later duplicate exit isn't misread as an in-flight controller.
        controllerRef.current?.abort();
        controllerRef.current = null;
        if (semanticSlot !== null && semanticSlot.state.kind !== "ready") {
          setSemanticSlot(null);
        }
      }
      return;
    }

    // Slot is already fresh for these inputs — either from a completed
    // prior run whose inputs still match (memoized result) or from an
    // in-flight run this effect already kicked off. Either way, nothing
    // new to do. Value comparison, per the layer-2 rationale in the docblock.
    if (
      semanticSlot !== null &&
      semanticInputsMatch(
        semanticSlot.inputs,
        trimmedJdText,
        parsed,
        selectedModelId,
      )
    ) {
      return;
    }

    // New run. Bump the id so any older in-flight run's writes will fail
    // the guard, and reset the slot to a fresh `loading` bound to these
    // inputs so the derived status stops rendering LOADING_START (which
    // was the render-time placeholder while slot was stale/null).
    const myId = ++requestIdRef.current;
    // Layer-3 abort (#803): install a fresh controller and abort the
    // previous run's, so its `extractRequirements` and every subsequent
    // judge batch stop scheduling. Store BEFORE aborting so `controllerRef`
    // always points at the current run for any concurrent read; a stale
    // reader will see the new controller, never a null gap.
    const previousController = controllerRef.current;
    const myController = new AbortController();
    controllerRef.current = myController;
    previousController?.abort();
    const myInputs: SemanticInputs = {
      jdText: trimmedJdText,
      parsed,
      modelId: selectedModelId,
    };
    setSemanticSlot({
      inputs: myInputs,
      state: LOADING_START,
    });

    // Snapshot the keyword result the run should degrade to on unexpected
    // failure. Captured at effect-start; if it changes mid-run, the effect
    // re-fires (via `takingSemanticPath`/`keywordResult` deps), bumps the
    // id, and this closure's late writes fail the guard — so a stale
    // fallback never reaches the slot.
    const fallbackKeyword = keywordResult;

    // Dynamic import mirrors the discipline in `run-llm-match.ts`'s
    // docblock: the WebLLM chunk stays out of the entry bundle until a
    // user actually opts into semantic matching. Same lazy-load pattern
    // `useResumeRewrite` relies on transitively through `rewrite-resume.ts`.
    void import("../lib/jd-match/llm/run-llm-match.ts")
      .then(({ runLlmMatch }) =>
        runLlmMatch(
          myInputs.jdText,
          myInputs.parsed,
          myInputs.modelId,
          (progress) =>
            setSlotIfCurrent(myId, myInputs, { kind: "loading", progress }),
          () => setSlotIfCurrent(myId, myInputs, { kind: "running" }),
          myController.signal,
        ),
      )
      .then((result) => {
        setSlotIfCurrent(myId, myInputs, { kind: "ready", result });
      })
      .catch((err: unknown) => {
        // `runLlmMatch` is contracted to never reject (every failure falls
        // back to keyword internally). The realistic trigger here is a
        // dynamic-import failure after a deploy replaces hashed chunks
        // (`jobs/main.tsx`'s `vite:preloadError` reload is one-shot; the
        // second such failure in a session falls straight through). We
        // preserve the keyword coverage the user was already looking at
        // rather than replacing it with a raw error string — the docblock
        // states "keyword is always available" and this catch honors it.
        console.warn(
          "[useJdMatch] semantic path failed unexpectedly; preserving keyword:",
          err,
        );
        if (fallbackKeyword !== null) {
          setSlotIfCurrent(myId, myInputs, {
            kind: "ready",
            result: fallbackKeyword,
          });
          return;
        }
        setSlotIfCurrent(myId, myInputs, {
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Couldn't run the semantic JD match.",
        });
      });
    // `keywordResult` is not in the deps: `useMemo`'s inputs (`trimmedJdText`,
    // `parsed`) are already listed, so any value that would change
    // `keywordResult` re-fires this effect and starts a fresh run with a fresh
    // `fallbackKeyword` closure — no stale fallback can reach the slot.
  }, [
    takingSemanticPath,
    trimmedJdText,
    parsed,
    selectedModelId,
    semanticSlot,
    setSlotIfCurrent,
  ]);

  return { status, keyword: keywordResult, capability };
}
