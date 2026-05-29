// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Tunable thresholds for the heuristic resume cascade.
 *
 * Every knob that decides "is this good enough to skip the LLM?" lives here.
 * The aim is to reserve the LLM parse for genuinely messy inputs — most
 * providers don't offer LLM-based resume parsing at all, so we mirror that
 * default and keep the LLM as a rare escalation path. Tier gating (free vs
 * pro) may further restrict LLM availability for some users; the cascade
 * must therefore be able to produce canonical output on its own for the
 * common case.
 *
 * Rough tuning rules:
 * - Lower `CANONICAL_CONFIDENCE_THRESHOLD` → MORE resumes skip the LLM
 *   (more lenient). Hard-fail guards below still catch genuine garbage, so
 *   lowering doesn't accept junk — it accepts "plausible-but-not-perfect."
 * - Raise it → fewer resumes skip the LLM (stricter); guard against false
 *   canonical acceptances when the cascade is new / under-tested.
 * - Hard-fail floors (`EXTRACTION_RATIO_FLOOR`, `NAME_CONFIDENCE_FLOOR`)
 *   are independent of confidence — they force escalation regardless of
 *   the numeric score. Keep them strict even when lowering the overall
 *   threshold.
 * - Soft penalties subtract from confidence additively; they never force
 *   escalation on their own but can tip a marginal case into the LLM path.
 *
 * Per-branch overrides are supported via `getThresholdsFor(branch)`. Today
 * DOCX and PDF share the same values — the structure exists so we can
 * diverge later (e.g., PDF deserves stricter guards because layout probes
 * are stronger, DOCX can be looser because mammoth markdown is cleaner).
 */

// ── Overall gate ────────────────────────────────────────────────────────────

/**
 * Cascade output ≥ this is accepted as canonical by the dashboard —
 * `preParsed.parsedData` is populated and the downstream LLM parse is
 * skipped. Default `0.85` mirrors the PDF cascade's original tuning.
 *
 * Lower to loosen the gate (more common-case LLM skips) once we have
 * telemetry showing the cascade output is reliable. Raise while the
 * parser is new or an eval shows a regression.
 */
export const CANONICAL_CONFIDENCE_THRESHOLD = 0.85;

// ── Hard-fail floors ────────────────────────────────────────────────────────

/**
 * Extracted text length divided by raw PDF text length. Below this the
 * parser likely missed major content (column mis-reads, embedded images,
 * encrypted glyphs) and we force escalation regardless of confidence.
 *
 * Only meaningful for PDF — DOCX cascades set `rawCharCount = 0` which
 * disables this check.
 */
export const EXTRACTION_RATIO_FLOOR = 0.5;

/**
 * Name must score at least this high for the cascade to accept. A missing
 * or low-confidence name is the single strongest signal that something is
 * wrong with the parse (layout weirdness, header stripped, etc.).
 */
export const NAME_CONFIDENCE_FLOOR = 0.5;

// ── Per-field confidence targets ────────────────────────────────────────────

/**
 * Floor per field used by eval fixtures. Not gating production — production
 * uses the weighted-mean in `confidence.ts` — but tests reference these to
 * catch regressions in extractor quality.
 */
export const FIELD_CONFIDENCE_TARGETS = {
  full_name: 0.8,
  email: 0.8,
  experience: 0.7,
} as const;

// ── Soft penalties ──────────────────────────────────────────────────────────

/**
 * Each penalty subtracts from the base confidence. Multiple soft penalties
 * compound but never force escalation on their own.
 */
export const SOFT_PENALTY = {
  /** An entry's end_date precedes its own start_date. */
  dateInconsistency: 0.1,
  /** >30% of whitespace-split description tokens are single characters —
   *  a symptom of column mis-reads in PDF extraction. */
  garbledBullets: 0.12,
  /** Email domain looks like a work email but doesn't match any parsed
   *  company — often a Tier 1 experience-section miss. */
  emailDomainMismatch: 0.06,
  /** 3+ entries but total date span under 2 years — likely date parse errors. */
  careerLengthMismatch: 0.08,
} as const;

// ── Layout caps (PDF-only) ──────────────────────────────────────────────────

/**
 * Two-column layouts reading top-to-bottom of each column cleanly is rare
 * for PDFs; this cap prevents us from accepting canonical on a layout that
 * commonly misreads.
 */
export const TWO_COLUMN_CONFIDENCE_CAP = 0.7;

// ── Weighted-mean weights ───────────────────────────────────────────────────

/**
 * Per-field weights used to compute the overall cascade confidence. The
 * four "must-have" fields (name, email, experience, education) dominate;
 * optional fields contribute when present but don't penalize when missing
 * (missing fields score 0 and are excluded from the weighted mean — see
 * `confidence.ts` for the exact formula).
 *
 * Rebalance with care: changing a weight shifts the overall confidence
 * distribution, which interacts with `CANONICAL_CONFIDENCE_THRESHOLD`.
 */
export const FIELD_WEIGHTS = {
  full_name: 2,
  email: 2,
  experience: 2.5,
  education: 1,
  skills: 1,
  phone: 0.5,
  location: 0.5,
  linkedin_url: 0.5,
  summary: 0.5,
} as const;

// ── Per-branch override mechanism ───────────────────────────────────────────

/**
 * Source branch for the cascade — today PDF and DOCX share all thresholds,
 * but `getThresholdsFor(branch)` exists so we can diverge later without
 * hunting through extractor files.
 */
export type CascadeBranch = "pdf" | "docx_markdown";

export interface CascadeThresholds {
  canonicalConfidenceThreshold: number;
  extractionRatioFloor: number;
  nameConfidenceFloor: number;
  softPenalty: typeof SOFT_PENALTY;
  twoColumnCap: number;
  fieldWeights: typeof FIELD_WEIGHTS;
}

const SHARED: CascadeThresholds = {
  canonicalConfidenceThreshold: CANONICAL_CONFIDENCE_THRESHOLD,
  extractionRatioFloor: EXTRACTION_RATIO_FLOOR,
  nameConfidenceFloor: NAME_CONFIDENCE_FLOOR,
  softPenalty: SOFT_PENALTY,
  twoColumnCap: TWO_COLUMN_CONFIDENCE_CAP,
  fieldWeights: FIELD_WEIGHTS,
};

export function getThresholdsFor(_branch: CascadeBranch): CascadeThresholds {
  // Today: identical values. Override points in this function later when
  // production telemetry suggests a branch-specific tuning is warranted.
  return SHARED;
}
