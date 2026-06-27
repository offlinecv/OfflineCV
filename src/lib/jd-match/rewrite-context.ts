// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * JD-driven rewrite steering (issue #226).
 *
 * `/jd-fit` reuses the SAME rewrite engine as `/` — it does not fork it. The
 * only difference is an extra steering instruction naming the JD terms the
 * résumé is currently missing, so the model is nudged to surface genuine,
 * already-present evidence of those skills rather than fabricate them.
 *
 * The output is plain text folded into `RewriteSteering.userInstructions` via
 * `buildSteeringSuffix` (steering.ts), so it inherits the same guardrails
 * (number preservation, no fabrication) and never bypasses them. On `/` no JD
 * context is passed → the prompt is byte-identical to today's generic rewrite.
 */

import type { CoverageResult } from "./coverage.ts";

/** Cap so the suffix stays short enough for a small instruct model to follow. */
const MAX_TERMS = 12;

/**
 * Build a JD-driven rewrite instruction from coverage, or null when there's
 * nothing useful to steer with (no missing terms). Null → the caller passes no
 * jdContext and the rewrite is generic.
 *
 * The instruction is deliberately conservative: "where the experience genuinely
 * demonstrates" — it must not invite fabrication, mirroring the base prompt's
 * no-fabrication guardrail.
 */
export function buildJdRewriteContext(
  coverage: CoverageResult,
): string | null {
  const missing = coverage.missing
    .map((t) => t.display.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_TERMS);
  if (missing.length === 0) return null;

  return (
    "This résumé is being tailored to a specific job description. " +
    "Where the existing experience genuinely demonstrates them, prefer wording " +
    "that surfaces these job-relevant skills and phrases: " +
    `${missing.join(", ")}. ` +
    "Do not invent experience the résumé doesn't already support."
  );
}
