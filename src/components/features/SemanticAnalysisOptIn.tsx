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
 * The lifecycle line itself — every state it can be in, why the capability
 * check has to precede the status switch, and the #804 progress-fidelity
 * limitation — lives in `SemanticAnalysisStatus`, extracted in the #866 review
 * follow-up so this file stays inside CLAUDE.md's ~200 LOC guideline.
 */

import { Checkbox } from "@design-system";
import type { JdMatchStatus } from "../../hooks/useJdMatch.ts";
import type { WebGpuCapability } from "../../lib/webllm/types.ts";
import { SemanticAnalysisStatus } from "./SemanticAnalysisStatus.tsx";

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
      {/* The `checked` gate stays HERE rather than moving into the status
          component: this file owns `checked`, and passing it down only to
          have the child early-return would be prop plumbing for nothing.
          Unticked therefore renders no line at all, so the default panel is
          unchanged from its pre-#204 self down to the DOM. */}
      {checked && (
        <SemanticAnalysisStatus status={status} capability={capability} />
      )}
    </div>
  );
}
