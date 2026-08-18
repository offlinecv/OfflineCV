// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SemanticAnalysisOptIn — the "Analyze with on-device AI" control and the
 * lifecycle line that belongs under it (#204).
 *
 * Display-only and fully controlled: the checked state lives in `PasteJdPanel`
 * (which feeds it to `useJdMatch` as `semanticOptIn`), so the boolean has a
 * single owner. This component holds no state, starts no work, and imports
 * nothing from `webllm/` but a type — `detectWebGpu`, `loadEngine` and
 * `runLlmMatch` are all upstream of it.
 *
 * The control and its progress sit together because that is the house pattern
 * for every WebLLM surface in the repo: `ResumeQualityPanel`, `ResumeRewrite`
 * and `SectionRewrite` each render `ModelLoadProgress` directly under the
 * trigger that started the load, not inside the result panel. Keeping it out
 * of `JdMatch` is also what keeps the keyword floor visible: the result card
 * below goes on rendering keyword coverage for the whole engine load instead
 * of being replaced by a spinner.
 *
 * ## Why the multi-GB download is opt-in and defaults OFF
 *
 * Per #172's stance and #204's scope: the instant keyword coverage is the
 * return hook, and a panel that starts a hundreds-of-megabytes fetch because a
 * user pasted a JD would be spending their bandwidth on a guess. OFF also
 * carries a privacy property, not just a bandwidth one — with the box unticked
 * `useJdMatch` never calls `detectWebGpu`, so no `webllm_capability_detected`
 * event enters the funnel for a user who only ever wanted keyword coverage.
 * The gate lives in the hook; this component's job is to make it a user's
 * decision rather than a hardwired `false`.
 *
 * ## What this is NOT
 *
 * Not a model picker, and not a licence-consent gate. Those are separate,
 * already-built mechanisms (`useModelSelection` supplies the selected id;
 * `ConsentDialog` covers restricted-licence downloads on the surfaces that
 * offer them). This is one boolean: "may this panel use the on-device model at
 * all". It deliberately does not persist — a session-scoped `useState` in the
 * panel, no `localStorage` — because #204 asks for an opt-in toggle and
 * nothing in the issue or the repo asks a JD panel to remember it.
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
import { Checkbox, ModelLoadProgress } from "@design-system";
import type { JdMatchStatus } from "../../hooks/useJdMatch.ts";
import type { WebGpuCapability } from "../../lib/webllm/types.ts";

interface SemanticAnalysisOptInProps {
  /** Controlled opt-in state; owned by `PasteJdPanel`. */
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The controller's semantic status. */
  status: JdMatchStatus;
  /** The controller's WebGPU probe result; `null` until it resolves (and
   *  forever while `checked` is false, since the probe is gated on opt-in). */
  capability: WebGpuCapability | null;
}

export function SemanticAnalysisOptIn({
  checked,
  onChange,
  status,
  capability,
}: SemanticAnalysisOptInProps) {
  return (
    <div className="flex flex-col gap-2">
      <Checkbox
        checked={checked}
        onChange={onChange}
        label="Analyze with on-device AI"
        hint="Judges each requirement against your résumé instead of matching terms by name. One-time model download; your JD text still never leaves this tab."
      />
      <StatusLine checked={checked} status={status} capability={capability} />
    </div>
  );
}

/** Muted one-liner — the tone for "this is information, not a problem". */
function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-sm text-content-tertiary">
      {children}
    </p>
  );
}

function StatusLine({
  checked,
  status,
  capability,
}: {
  checked: boolean;
  status: JdMatchStatus;
  capability: WebGpuCapability | null;
}) {
  // Unticked: render nothing at all, so the default panel is unchanged from
  // its pre-#204 self down to the DOM.
  if (!checked) return null;
  // No JD yet (or one that extracted no terms) — there is nothing to analyze,
  // so a progress line would be describing work that isn't happening.
  if (status.kind === "idle") return null;

  // Capability first: with the probe unresolved OR resolved-unavailable, the
  // hook's `status` is `ready` holding the KEYWORD result, which is
  // indistinguishable from a semantic run that degraded. Only `capability`
  // separates them, which is why the controller exposes it.
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

  if (status.kind === "loading") {
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
  }

  if (status.kind === "running") {
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
  }

  if (status.kind === "error") {
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
  }

  // `ready` on the semantic path with a KEYWORD result: the run completed and
  // `runLlmMatch` degraded internally (engine load failure, unparseable
  // extraction, or a JD it found no requirements in). Note that a CANCELLED
  // run never lands here — `useJdMatch` bumps its request id before aborting,
  // so the abandoned run's keyword fallback fails the write guard and is never
  // shown. That is what keeps this line off the screen on every opt-out, JD
  // edit and model change (#803).
  if (status.result.path === "keyword") {
    return (
      <Note>
        On-device analysis didn't return a verdict for this JD — showing keyword
        coverage instead.
      </Note>
    );
  }
  // Semantic verdicts are on screen in the card below; nothing to add.
  return null;
}
