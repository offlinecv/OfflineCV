// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared types for the JD-match eval harness (issue #205, sibling of #65's
 * rewrite harness).
 *
 * Mirrors the rewrite harness's seam shape (`RewriteFn` / `RewriteFixture` in
 * `types.ts`) over the semantic JD-match API instead: a `JdMatchFn`
 * implementation (real `runLlmMatch` in the browser, a canned-output stub in
 * Node/CI) produces a `JdMatchResult`, and `jd-rubric.ts` scores it
 * deterministically. The rewrite types in `types.ts` are untouched — this is
 * a parallel seam, not a generalization of the existing one, because the two
 * domains share no fields (bullets/numbers vs. requirements/verdicts).
 *
 * A fixture carries its JD and résumé as plain TEXT (not a PDF, not a parsed
 * `HeuristicParsedResume`) — per fixture policy (PII-safe, inline, auditable
 * in a code review) and because the deterministic keyword path
 * (`computeCoverageFromCorpus`) only ever needs a lowercased corpus string, so
 * there is nothing to parse. A real `JdMatchFn` wraps the résumé text in the
 * minimal valid `HeuristicParsedResume` shape (`summary: resumeText`) only at
 * the point it calls `runLlmMatch`, which does require that type.
 */

import type { JdMatchResult } from "../../jd-match/types.ts";
import type { JdRequirement } from "../../jd-match/llm/extract-requirements.ts";
import type { RequirementVerdict } from "../../jd-match/llm/judge-evidence.ts";

/**
 * A hand-labeled expectation, keyed by normalized requirement text + kind
 * rather than by position — the model's own requirement wording will not
 * equal the label's, so `jd-rubric.ts`'s gold-agreement check joins the two
 * with a fuzzy (token-overlap) match, not an index or an id.
 */
export interface JdGoldLabel {
  /** The requirement as a human would phrase it, for fuzzy-joining to the
   *  model's `JdRequirement.text`. */
  text: string;
  kind: JdRequirement["kind"];
  expectedStatus: RequirementVerdict["status"];
}

/**
 * One fixture: a JD + résumé pair (inline text), the gold labels an
 * expected-verdict agreement check joins against, and the CANNED semantic
 * result the Node stub returns in place of a real model call — the same
 * canned-output pattern `RawRewriteOutput` uses for the rewrite harness,
 * scaled up to a whole `JdMatchResult` since there is no smaller unit to
 * stub here (the seam is "did the match pipeline produce a good result",
 * not "did one completion parse").
 */
export interface JdEvalFixture {
  /** Stable identifier used in report tables. Kebab-case. */
  id: string;
  /** What this fixture stresses, for the report's prose. */
  description: string;
  /** The job description text, exactly as pasted by a user. */
  jd: string;
  /** The résumé text, exactly as a parse's reconstructed text would read. */
  resume: string;
  /** The posting's own title, when the fixture wants the noun-pass title
   *  exclusion exercised (mirrors `ExtractOptions.postingTitle`). */
  postingTitle?: string;
  /** Hand-labeled expectations the gold-agreement check joins against. */
  gold: readonly JdGoldLabel[];
  /** The canned semantic result the stub `JdMatchFn` returns for this
   *  fixture — stands in for what a real model call would have produced. */
  canned: JdMatchResult;
  /**
   * An injected-instruction payload the JD text carries, when this fixture
   * is a prompt-injection probe. The rubric's injection check asserts the
   * canned result does not echo it. Absent on every other fixture.
   */
  injectionPayload?: string;
}

/**
 * The pluggable match seam. The Node scoring tests pass a stub that returns
 * each fixture's `canned` result (no model, no WebGPU); the browser entry
 * passes a real implementation that dynamic-imports `runLlmMatch` (the
 * `jd-match/llm` chunk-discipline pattern — see `run-llm-match.ts`'s own
 * docblock on why it is not reachable from the static `jd-match` barrel).
 */
export type JdMatchFn = (input: {
  modelId: string;
  fixture: JdEvalFixture;
}) => Promise<JdMatchResult>;
