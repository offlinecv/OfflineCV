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
 * The narrowing is real, not a cast. The `keyword` early return leaves the
 * semantic arm as the only remaining type on the fall-through, so
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
 */

import type { JdMatchResult } from "../../lib/jd-match";
import { KeywordMatch } from "./KeywordMatch.tsx";
import { SemanticMatch } from "./SemanticMatch.tsx";

interface JdMatchProps {
  result: JdMatchResult;
}

export function JdMatch({ result }: JdMatchProps) {
  if (result.path === "keyword") return <KeywordMatch result={result} />;
  return <SemanticMatch result={result} />;
}
