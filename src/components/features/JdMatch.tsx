// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JdMatch — the path router for the diagnostic JD-match panel (#204).
 *
 * `JdMatchResult` is a discriminated union (#199) with two arms, and this file
 * is the ONE place that narrows it: `keyword` → `<KeywordMatch>`, `semantic` →
 * `<SemanticMatch>`. Before #204 the semantic arm returned `null`, so a
 * finished on-device match rendered a blank panel; that is the hole this
 * closes.
 *
 * The narrowing is real, not a cast. The ternary's `keyword` branch leaves the
 * semantic arm as the only remaining type in the `else`, so
 * `<SemanticMatch result={result} />` type-checks solely because TypeScript
 * has already proved it. Adding a third arm to the union breaks THIS file at
 * compile time rather than silently falling into the semantic view.
 *
 * Deliberately not here: any state, any effect, any WebLLM call. The opt-in
 * lives in `PasteJdPanel`, the async state machine in `useJdMatch`, the engine
 * work in `runLlmMatch`. This component receives a finished result and picks a
 * view — which is what lets `JobResultCard` reuse it for a `RankedJob`'s
 * keyword coverage with no controller in sight.
 *
 * The loading / running / degraded affordances are NOT here either: they
 * belong beside the control that started the work, which is what every other
 * WebLLM surface in the repo does (`ResumeQualityPanel`, `ResumeRewrite`,
 * `SectionRewrite` all render `ModelLoadProgress` under their own trigger).
 * See `SemanticAnalysisOptIn`. Keeping them out is also what keeps the keyword
 * floor visible for the whole multi-minute engine load: the result card below
 * the control keeps rendering keyword coverage while the semantic arm is still
 * resolving.
 *
 * `EligibilityFindings` (#793) renders ABOVE the arm-specific card, since the
 * findings are JD-derived, not arm-derived — both `keyword` and `semantic`
 * carry the same `eligibility` array for the same JD text. It only ever
 * reports what the JD states, quoted verbatim; it never scores, gates, or
 * judges the reader against it.
 */

import type { EligibilityFinding, JdMatchResult } from "../../lib/jd-match";
import { InlineResult } from "@design-system";
import { KeywordMatch } from "./KeywordMatch.tsx";
import { SemanticMatch } from "./SemanticMatch.tsx";

interface JdMatchProps {
  result: JdMatchResult;
}

/**
 * `kind` encodes a polarity guess ("no-sponsorship"), but the DETECTOR can
 * guess wrong — "Sponsorship is not an issue for us; we sponsor H-1B." and
 * "We provide visa sponsorship at no cost to you." both land on
 * `no-sponsorship` (review on #1175). A headline that stated the guessed
 * polarity ("No visa sponsorship") would then say the OPPOSITE of what the
 * JD actually says, on top of a quoted snippet that already says it
 * correctly. So every label below names the TOPIC, never the polarity — the
 * verbatim quote underneath is what carries the actual statement, and a
 * wrong guess can at worst mis-route which topic groups the quote, never
 * invert its meaning.
 */
const ELIGIBILITY_LABEL: Record<EligibilityFinding["kind"], string> = {
  "no-sponsorship": "Visa sponsorship",
  "work-authorization": "Work authorization",
  "e-verify": "E-Verify",
};

function EligibilityFindings({
  findings,
}: {
  findings: readonly EligibilityFinding[];
}) {
  if (findings.length === 0) return null;
  return (
    <InlineResult tone="warning" className="mb-4 flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-feedback-warning-text">
        Eligibility language in this JD
      </h3>
      <ul className="flex flex-col gap-2 list-none">
        {findings.map((finding) => (
          <li key={finding.kind} className="flex flex-col gap-1">
            <span className="w-fit text-2xs font-semibold uppercase tracking-wider text-feedback-warning-text">
              {ELIGIBILITY_LABEL[finding.kind]}
            </span>
            <p className="text-sm text-content-secondary">
              "{finding.snippet}"
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-content-tertiary">
        Quoted from the JD as written. We don't know your status, so we don't
        judge whether this affects you — only that the posting says it.
      </p>
    </InlineResult>
  );
}

export function JdMatch({ result }: JdMatchProps) {
  return (
    <>
      <EligibilityFindings findings={result.eligibility ?? []} />
      {result.path === "keyword" ? (
        // A JD with only eligibility language extracts zero skill/noun terms
        // (coverage denominator 0), so the card had nothing to show but "0 of
        // 0 terms", "0/100", and an empty-state line for every column — noise
        // below the eligibility block above, which already said the one thing
        // the JD actually stated. Suppress the card rather than render that.
        result.terms.length > 0 && <KeywordMatch result={result} />
      ) : (
        <SemanticMatch result={result} />
      )}
    </>
  );
}
