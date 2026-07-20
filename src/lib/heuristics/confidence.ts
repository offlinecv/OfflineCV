// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Confidence scorer + escalation router.
 *
 * Reduces Tier 0 layout probes + Tier 1 field confidences + a few
 * structural checks into a single `{ confidence, suggestedEscalation }`
 * pair.
 *
 * Hard failures force `confidence → 0` AND an escalation suggestion, even
 * if other fields look healthy. These are non-negotiable shape checks for
 * a usable resume parse.
 *
 * Soft failures subtract from confidence proportionally. Multiple soft
 * failures compound but never force escalation on their own.
 */

import type {
  HeuristicResult,
  LayoutProbes,
  EscalationSuggestion,
  FieldConfidence,
} from "./types.ts";
import type { ResumeExperience } from "../score/types.ts";
import {
  CANONICAL_CONFIDENCE_THRESHOLD,
  EXTRACTION_RATIO_FLOOR,
  NAME_CONFIDENCE_FLOOR,
  SOFT_PENALTY,
  TWO_COLUMN_CONFIDENCE_CAP,
  FIELD_WEIGHTS,
} from "./thresholds.ts";

// Re-export for back-compat with existing consumers (dashboard's
// heuristic-cascade imports this name from the package root).
export { CANONICAL_CONFIDENCE_THRESHOLD } from "./thresholds.ts";

// ── Public API ──────────────────────────────────────────────────────────────

export interface ScoreInputs {
  heuristic: HeuristicResult;
  layout: LayoutProbes;
  /** Raw character count across PDF text runs (Tier 0). */
  rawCharCount: number;
  /** Character count of the extracted parsed output (sum of visible fields). */
  extractedCharCount: number;
}

export function computeConfidence(inputs: ScoreInputs): {
  confidence: number;
  suggestedEscalation: EscalationSuggestion;
  fieldConfidence: FieldConfidence;
} {
  const { heuristic, layout, rawCharCount, extractedCharCount } = inputs;
  const fc = heuristic.fieldConfidence;
  const parsed = heuristic.parsed;

  // Scanned PDFs skip Tier 1 entirely in production (Phase 2 will run OCR
  // first). During Phase 1, flag and bail before spending any cycles on a
  // parse that can't have positional signal.
  if (layout.isScanned) {
    return {
      confidence: 0,
      suggestedEscalation: "ocr",
      fieldConfidence: fc,
    };
  }

  const hardFailures = collectHardFailures({
    parsed,
    fieldConfidence: fc,
    rawCharCount,
    extractedCharCount,
  });

  if (hardFailures.forceEscalation) {
    return {
      confidence: 0,
      suggestedEscalation: chooseEscalation(layout, hardFailures.reasons),
      fieldConfidence: fc,
    };
  }

  // Base score = mean of non-zero field confidences, weighted toward the
  // four "must-have" fields (name, email, experience, education). Weights
  // live in `thresholds.ts` so they can be tuned in one place.
  const weights: Partial<Record<keyof FieldConfidence, number>> = FIELD_WEIGHTS;
  let weightSum = 0;
  let weightedScoreSum = 0;
  for (const [field, weight] of Object.entries(weights) as Array<
    [keyof FieldConfidence, number]
  >) {
    const score = fc[field] ?? 0;
    if (score <= 0) continue; // Missing fields don't penalize here; they show up via hard/soft failures.
    weightSum += weight;
    weightedScoreSum += score * weight;
  }
  let base = weightSum > 0 ? weightedScoreSum / weightSum : 0;

  // Layout triggers don't force escalation on their own, but they cap
  // confidence — two-column layouts have higher miss rates.
  if (layout.isTwoColumn) base = Math.min(base, TWO_COLUMN_CONFIDENCE_CAP);

  // Soft penalties.
  const soft = collectSoftPenalties(
    parsed.experience ?? [],
    parsed.email,
    parsed.full_name,
  );
  base -= soft;

  const confidence = Math.max(0, Math.min(1, base));
  return {
    confidence,
    suggestedEscalation: chooseEscalation(layout, [], confidence),
    fieldConfidence: fc,
  };
}

// ── Hard failures ───────────────────────────────────────────────────────────

interface HardFailureCheck {
  parsed: HeuristicResult["parsed"];
  fieldConfidence: FieldConfidence;
  rawCharCount: number;
  extractedCharCount: number;
}

interface HardFailureResult {
  forceEscalation: boolean;
  reasons: string[];
}

function collectHardFailures(check: HardFailureCheck): HardFailureResult {
  const reasons: string[] = [];

  if (!check.parsed.email || (check.fieldConfidence.email ?? 0) < 0.5) {
    reasons.push("no_email");
  }
  // Zero-experience on a non-student resume — we assume student if there's any
  // education entry AND no "years of experience" / no experience entries AND
  // education year is within the last 5 years. Otherwise zero experience is a
  // hard failure.
  const expCount = check.parsed.experience?.length ?? 0;
  if (expCount === 0 && !looksLikeStudent(check.parsed)) {
    reasons.push("zero_experience_non_student");
  }
  if (check.rawCharCount > 0) {
    const ratio = check.extractedCharCount / check.rawCharCount;
    if (ratio < EXTRACTION_RATIO_FLOOR) {
      reasons.push("low_extraction_ratio");
    }
  }
  if ((check.fieldConfidence.full_name ?? 0) < NAME_CONFIDENCE_FLOOR) {
    reasons.push("low_name_confidence");
  }

  return { forceEscalation: reasons.length > 0, reasons };
}

function looksLikeStudent(parsed: HeuristicResult["parsed"]): boolean {
  const education = parsed.education ?? [];
  if (education.length === 0) return false;
  const currentYear = new Date().getUTCFullYear();
  for (const edu of education) {
    if (!edu.year) continue;
    const year = parseInt(edu.year, 10);
    if (!Number.isFinite(year)) continue;
    if (year >= currentYear - 5) return true;
  }
  return false;
}

// ── Soft failures ───────────────────────────────────────────────────────────

function collectSoftPenalties(
  experience: ResumeExperience[],
  email: string | undefined,
  fullName: string | undefined,
): number {
  let penalty = 0;

  if (hasDateInconsistency(experience)) penalty += SOFT_PENALTY.dateInconsistency;
  if (hasGarbledBullets(experience)) penalty += SOFT_PENALTY.garbledBullets;
  if (hasEmailDomainMismatch(experience, email, fullName))
    penalty += SOFT_PENALTY.emailDomainMismatch;
  if (hasCareerLengthMismatch(experience))
    penalty += SOFT_PENALTY.careerLengthMismatch;

  return penalty;
}

function hasDateInconsistency(experience: ResumeExperience[]): boolean {
  // A simple check: an end_date that precedes its own start_date on the same entry.
  for (const entry of experience) {
    if (!entry.start_date || !entry.end_date) continue;
    const start = Date.parse(normalizeForDate(entry.start_date));
    const end = Date.parse(normalizeForDate(entry.end_date));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end < start) return true;
  }
  return false;
}

function normalizeForDate(raw: string): string {
  // "Jan 2020" → "Jan 1, 2020" for Date.parse compatibility.
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(raw.trim());
  if (m) return `${m[1]} 1, ${m[2]}`;
  return raw;
}

function hasGarbledBullets(experience: ResumeExperience[]): boolean {
  // Symptom of column misreads: a description where > 30% of whitespace-split
  // tokens are single characters.
  for (const entry of experience) {
    const desc = entry.description ?? "";
    if (desc.length < 40) continue;
    const tokens = desc.split(/\s+/);
    const singles = tokens.filter((t) => t.length === 1).length;
    if (singles / tokens.length > 0.3) return true;
  }
  return false;
}

function hasEmailDomainMismatch(
  experience: ResumeExperience[],
  email: string | undefined,
  fullName?: string,
): boolean {
  if (!email || !email.includes("@")) return false;
  // Work-email domains often show up in experience entries. If the email is
  // an *uncommon* domain (not gmail/outlook/yahoo/icloud/proton) AND the
  // domain root doesn't appear in any parsed company, flag it.
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const freeDomains = new Set([
    "gmail.com",
    "yahoo.com",
    "outlook.com",
    "hotmail.com",
    "icloud.com",
    "proton.me",
    "protonmail.com",
    "aol.com",
    "live.com",
    "me.com",
  ]);
  if (freeDomains.has(domain)) return false;
  const root = domain.split(".").slice(-2, -1)[0] ?? "";
  if (!root || root.length < 3) return false;
  // Personal domains commonly encode the owner's name (e.g. jordan.lee@example.com).
  // Treat any overlap with a name token as a match so we don't flag a legit
  // personal domain as a "missing employer" parse error.
  if (fullName) {
    const nameTokens = fullName
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    if (nameTokens.some((t) => t.includes(root) || root.includes(t))) {
      return false;
    }
  }
  const anyMatch = experience.some((e) =>
    e.company?.toLowerCase().includes(root),
  );
  return !anyMatch;
}

function hasCareerLengthMismatch(experience: ResumeExperience[]): boolean {
  // Rough check: if there are ≥3 entries but their total date span is < 2
  // years, something is wrong (likely date parse errors).
  if (experience.length < 3) return false;
  const years = experience
    .map((e) => {
      if (!e.start_date) return null;
      const y = /(19|20)\d{2}/.exec(e.start_date)?.[0];
      return y ? parseInt(y, 10) : null;
    })
    .filter((y): y is number => y != null);
  if (years.length < 3) return false;
  const span = Math.max(...years) - Math.min(...years);
  return span < 2;
}

// ── Escalation routing ──────────────────────────────────────────────────────

function chooseEscalation(
  layout: LayoutProbes,
  hardReasons: string[],
  confidence?: number,
): EscalationSuggestion {
  if (layout.isScanned) return "ocr";
  // `low_extraction_ratio` at this point means the PDF is NOT scanned (the
  // isScanned guard above would have returned "ocr" first). A low extraction
  // ratio on a text-layer PDF means the heuristic parser failed to capture the
  // content — the right recovery is an on-device LLM pass, not OCR (#243).
  if (layout.isTwoColumn) return "ner";
  if (hardReasons.length > 0) return "llm";
  if (confidence != null && confidence < CANONICAL_CONFIDENCE_THRESHOLD) {
    return "llm";
  }
  return "none";
}
