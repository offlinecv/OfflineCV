// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Verdict recommendation — turns a computed {@link AnonymousAtsScore} into one
 * actionable sentence (#42). The band label tells the user *where they landed*;
 * this tells them *what to do next*, keyed off the same breakdown we already
 * compute so the copy round-trips to real fields (no vibes, no LLM):
 *
 *   1. A scanned PDF is a hard blocker — nothing else matters until the text is
 *      selectable, so it short-circuits first.
 *   2. A layout penalty (`multiplier < 1`: two-column / unmappable fonts) is the
 *      dominant drag even when the underlying content scores well, so it comes
 *      before the dimension advice and names the actual triggers.
 *   3. Otherwise lead with the band and point at the weakest *gradable*
 *      dimension — the same lowest-`score/max` pick `VerdictHeader` used for its
 *      "biggest gap" — with the concrete next step for that dimension.
 */

import type { AnonymousAtsScore } from "./score.ts";
import { getScoreTier } from "./score.ts";
import type { ScoreTier } from "./types.ts";

/** Band-opening clause (no trailing punctuation — the caller appends the step). */
const BAND_OPENER: Record<ScoreTier, string> = {
  high: "Most generic parsers should read this cleanly",
  medium: "A generic parser gets most of this",
  low: "A generic extractor struggles here",
};

/** Short, friendly names for the layout triggers we penalize. Kept terse for
 *  inline use — the full explanation lives in `LayoutFlagsList`. */
const TRIGGER_PHRASE: Record<string, string> = {
  two_column: "multi-column layout",
  fonts_unmappable: "font encoding the parser can't read",
};

function describeTriggers(triggers: readonly string[]): string {
  const phrases = triggers
    .filter((t) => t !== "scanned")
    .map((t) => TRIGGER_PHRASE[t] ?? t.replace(/_/g, " "));
  if (phrases.length === 0) return "the flagged layout";
  if (phrases.length === 1) return phrases[0];
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

interface GradableDimension {
  key: "specificity" | "structure" | "completeness";
  label: string;
  ratio: number;
}

/** Lowest score/max among gradable dimensions — mirrors the math VerdictHeader
 *  used for "biggest gap" so the recommendation points at the same dimension. */
function weakestDimension(score: AnonymousAtsScore): GradableDimension | null {
  const dims: GradableDimension[] = [];
  if (score.specificity.gradable && score.specificity.max > 0) {
    dims.push({
      key: "specificity",
      label: "Specificity",
      ratio: score.specificity.score / score.specificity.max,
    });
  }
  if (score.structure.gradable && score.structure.max > 0) {
    dims.push({
      key: "structure",
      label: "Structure",
      ratio: score.structure.score / score.structure.max,
    });
  }
  if (score.completeness.gradable && score.completeness.max > 0) {
    dims.push({
      key: "completeness",
      label: "Completeness",
      ratio: score.completeness.score / score.completeness.max,
    });
  }
  if (dims.length === 0) return null;
  return dims.reduce((worst, d) => (d.ratio < worst.ratio ? d : worst));
}

/** The concrete next step for the weakest dimension (lowercase imperative). */
function dimensionStep(
  weakest: GradableDimension,
  score: AnonymousAtsScore,
): string {
  switch (weakest.key) {
    case "specificity":
      return "add metrics like numbers, %, or $ to more bullets so each one shows measurable impact";
    case "structure":
      return "tighten each bullet to a single line that opens with an action verb";
    case "completeness": {
      if (score.completeness.redactedDates) {
        return "use real 4-digit years on your roles — the dates currently read as redaction stubs";
      }
      const missing = score.completeness.missing;
      if (missing.length === 0) {
        return "round out the remaining contact and section fields";
      }
      const list = missing.slice(0, 2).join(" and ");
      const verb = missing.length === 1 ? "extracts" : "extract";
      return `check that ${list} ${verb} as plain text`;
    }
  }
}

/**
 * Build the single actionable recommendation sentence shown beneath the verdict
 * band. Deterministic — the same input always yields the same sentence.
 */
export function getScoreRecommendation(score: AnonymousAtsScore): string {
  // 1. Scanned — a plain-text extractor reads nothing; fix this before all else.
  if (score.layout.scanned) {
    return "This reads as a scanned image, not selectable text — export a real text-based PDF before anything else.";
  }

  // 2. Layout penalty dominates even when the content itself scores well.
  if (score.layout.multiplier < 1) {
    return `Your content scored ${score.preLayoutOverall}/100, but a ${describeTriggers(
      score.layout.triggers,
    )} will scramble it for many parsers — fix that layout first.`;
  }

  // 3. Lead with the band, point at the weakest gradable dimension.
  const opener = BAND_OPENER[getScoreTier(score.overall)];
  const weakest = weakestDimension(score);
  if (!weakest) {
    return `${opener} — add a few quantified bullets under your roles so there's something to grade.`;
  }
  return `${opener} — ${dimensionStep(weakest, score)}.`;
}
