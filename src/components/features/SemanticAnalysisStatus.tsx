// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SemanticAnalysisStatus — the lifecycle line under the "Analyze with on-device
 * AI" checkbox (#204, extracted in the #866 review follow-up).
 *
 * Split out of `SemanticAnalysisOptIn`, which had grown past CLAUDE.md's ~200
 * LOC decomposition guideline with this six-branch state machine as the obvious
 * seam — the same split #204 itself applied when `JdMatch` became a router over
 * `KeywordMatch`/`SemanticMatch`. The sibling keeps the control and the
 * composition; this file holds the "what is happening right now" rendering and
 * nothing else. No new props were invented to make the split work: it takes the
 * two values it already read, and the `checked` gate stayed with the component
 * that owns `checked`.
 *
 * ## Ordering is load-bearing
 *
 * `capability` is checked BEFORE the status switch, and inverting the two is a
 * real defect rather than a style choice. With the probe unresolved OR resolved
 * to something other than `available`, the controller's `status` is `ready`
 * holding the KEYWORD result — the same shape a semantic run that degraded
 * produces. Switch on `status` first and a no-WebGPU browser gets told the
 * model "didn't return a verdict", which is a failure report for a run that was
 * never attempted.
 *
 * ## Exhaustiveness
 *
 * The status branches are a `switch` with a `never`-typed default, not the
 * if-chain this started as (#866 review). A sixth `JdMatchStatus` variant used
 * to fall through to a bare `return null` with no compiler signal — the new
 * state would silently render nothing. Now it fails `tsc`. Same fail-closed
 * property `SemanticMatch`'s `Record<VerdictStatus, …>` lookups have.
 *
 * ## No-WebGPU is not an error
 *
 * `WebGpuUnavailableNotice` is the repo's other answer to "no WebGPU", and it
 * is the wrong one here: it renders a warning-toned strip with a how-to-enable
 * dialog and fires `webllm_notice_shown`. #204 asks for the opposite — the
 * keyword columns keep rendering, with at most one muted line saying why the
 * box did nothing. A user whose browser can't run this still has the whole
 * panel they came for, so nothing is in a failed state.
 *
 * ## Known limitation: the progress bar can sit at 0% (#804)
 *
 * `loadEngine`'s "already pending" fast path returns the shared promise
 * without registering the new caller's `onProgress`, so only the FIRST caller
 * for a model id ever receives progress. The reachable case here is
 * self-inflicted rather than the cross-consumer one #804 describes — that one
 * cites `job-search/sector.ts`'s `classifySector`, which has no production
 * caller, and `/jobs/` has no other `loadEngine` caller at all. What IS
 * reachable: opt in, then edit the JD while the weight download is still in
 * flight. The superseded run owns `initProgressCallback`, its writes are
 * dropped by the controller's id guard, and the new run joined a load it can't
 * hear — so the bar reads 0% until the load resolves, then moves on to
 * running → ready normally.
 *
 * Cosmetic, not functional, and deliberately NOT worked around here: the fix
 * is a progress fan-out inside `web-llm.ts`, shared by every WebLLM surface in
 * the repo, which is #804's scope and not this component's. The reason it is
 * tolerable meanwhile is the keyword floor — the result card below keeps
 * showing full coverage throughout, so a stalled bar costs the user a progress
 * readout, never the answer they came for.
 */

import type { ReactNode } from "react";
import { ModelLoadProgress } from "@design-system";
import type { JdMatchStatus } from "../../hooks/useJdMatch.ts";
import type { WebGpuCapability } from "../../lib/webllm/types.ts";

interface SemanticAnalysisStatusProps {
  /** The controller's semantic status. */
  status: JdMatchStatus;
  /** The controller's WebGPU probe result; `null` until it resolves, and
   *  `null` again once the user opts back out (the hook clears it). */
  capability: WebGpuCapability | null;
}

/** Muted one-liner — the tone for "this is information, not a problem". */
function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-sm text-content-tertiary">
      {children}
    </p>
  );
}

export function SemanticAnalysisStatus({
  status,
  capability,
}: SemanticAnalysisStatusProps) {
  // No JD yet (or one that extracted no terms) — there is nothing to analyze,
  // so a progress line would be describing work that isn't happening. Narrows
  // `status` for the switch below, which is why the switch needs no `idle` arm.
  if (status.kind === "idle") return null;

  // Capability first — see the docblock. Not foldable into the switch.
  if (capability === null) {
    return <Note>Checking whether this browser can run on-device analysis…</Note>;
  }
  if (capability !== "available") {
    return (
      <Note>
        This browser can't run on-device analysis (it needs WebGPU) — the
        keyword coverage below is unaffected.
      </Note>
    );
  }

  switch (status.kind) {
    case "loading":
      return (
        <ModelLoadProgress
          progress={status.progress.progress}
          text={status.progress.text}
          label="Loading the on-device model (one-time download)"
          // No `showExplainer`: the checkbox hint directly above already states
          // that the model downloads and that the text stays in the tab, and
          // `ModelLoadProgress`'s own docblock makes the explainer opt-in so
          // that a caller with its own context doesn't double up.
        />
      );

    case "running":
      // Generic on purpose. #204's example copy ("Judging requirement 4 of 9…")
      // has nothing behind it: `judgeEvidence` takes no progress callback and
      // `runLlmMatch` reports only engine load + a single `onInferenceStart`, so
      // a count here would be invented. Adding a batch-progress API to the LLM
      // layer to satisfy one string is not warranted; truthful copy is.
      return (
        <p role="status" className="text-sm text-content-secondary">
          Reading this JD and checking it against your résumé…
        </p>
      );

    case "error":
      // Not reachable from today's controller — a semantic run only starts when
      // a keyword result already exists, and the hook's catch degrades to that
      // rather than to `error` (see its state-machine docblock). Rendered anyway
      // because the state is public API, and a UI that dropped it would blank
      // the panel the day a semantic-only consumer reaches it. So the copy
      // promises no keyword fallback: in that consumer there wouldn't be one.
      //
      // The controller's `message` is deliberately NOT rendered: its realistic
      // source is a chunk-loader failure after a deploy, whose text is a hashed
      // asset URL rather than anything a user can act on. The retry it offers is
      // real — the hook clears an `error` slot on the way out of the semantic
      // path, so re-ticking starts a fresh run.
      return (
        <p role="alert" className="text-sm text-feedback-warning-text">
          On-device analysis couldn't start. Untick the box and tick it again to
          retry.
        </p>
      );

    case "ready":
      // A KEYWORD result here means the run completed and `runLlmMatch` degraded
      // internally (engine load failure, unparseable extraction, or a JD it
      // found no requirements in). Note that a CANCELLED run never lands here —
      // `useJdMatch` bumps its request id before aborting, so the abandoned
      // run's keyword fallback fails the write guard and is never shown. That is
      // what keeps this line off the screen on every opt-out, JD edit and model
      // change (#803).
      //
      // A semantic result needs no line: the verdicts are in the card below.
      return status.result.path === "keyword" ? (
        <Note>
          On-device analysis didn't return a verdict for this JD — showing
          keyword coverage instead.
        </Note>
      ) : null;

    default: {
      // Compile-time exhaustiveness (#866 review). A sixth `JdMatchStatus`
      // variant makes this assignment an error instead of silently rendering
      // nothing. Returned rather than merely declared because `noUnusedLocals`
      // is on; `never` is assignable to `ReactNode`, and the branch is
      // unreachable for the five variants that exist, so this adds no runtime
      // behaviour — the repo has no `assertNever` helper to reuse, and one
      // call site does not justify minting a shared one.
      const unhandled: never = status;
      return unhandled;
    }
  }
}
