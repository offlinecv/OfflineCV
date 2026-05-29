// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Deterministic ATS scoring — pure TypeScript, zero dependencies.
 *
 * Scores a ParsedResume across three dimensions: specificity, structure, completeness.
 * Keyword match is a fourth dimension but requires a JD — handled separately.
 */

import type {
  AtsScore,
  AtsScoreDimensions,
  ScoreTier,
  ResumeExperience,
  ResumeData,
} from "./types.ts";

// Re-export types for convenience
export type { AtsScore, AtsScoreDimensions, ScoreTier };

// ── Scoring weights ─────────────────────────────────────────────────────────

export const WEIGHTS = {
  specificity: 0.4,
  structure: 0.3,
  completeness: 0.3,
} as const;

/**
 * Scoring algorithm version. Bump when ANY change can cause the displayed
 * 0–100 score to differ for the same input PDF — including weight tuning,
 * threshold changes, formula changes, layout-multiplier changes, AND
 * cascade changes that affect what bullets/fields the score sees.
 *
 * Surface this next to the score (e.g. "Algo v{X}" caption) so a returning
 * visitor can tell "the algorithm changed under me" apart from "my resume
 * changed" between sessions.
 *
 * Changelog:
 * - 1.0 (2026-04-28): initial release.
 */
export const ATS_SCORE_ALGO_VERSION = "1.0";

// ── Shared scoring rules ────────────────────────────────────────────────────
//
// Single source of truth for the rules both the authed and anonymous scorers
// apply. Hoisted out of the per-scorer functions so the two surfaces can never
// silently disagree (e.g. authed counting `-` as a bullet but anonymous also
// counting `–`). When tuning these, every consumer that calls scoreBulletPool,
// splitBullets, or extractBulletsFromText sees the change.

/** Bullet markers we recognize at the start of a line. Wider than typical to
 *  catch en-dash / mid-dot resumes alongside the common dash/asterisk/bullet. */
const BULLET_MARKER_RE = /^[\s ]*[-*•●–▪◦‣▶►·]\s+/;

/** Numbered-list prefix: "1." or "1)". */
const NUMBERED_BULLET_RE = /^[\s ]*\d+[.)]\s+/;

/** Word-count window for a "well-formed" bullet (Structure dimension). */
const BULLET_LENGTH_MIN_WORDS = 8;
const BULLET_LENGTH_MAX_WORDS = 30;

/** Ratio of metric-bearing bullets that earns full Specificity credit (100). */
export const SPECIFICITY_TARGET_RATIO = 0.6;

/** Completeness sub-thresholds — match the authed scorer historically. */
const COMPLETENESS_SUMMARY_MIN_CHARS = 20;
const COMPLETENESS_SKILLS_MIN_COUNT = 3;

// ── Bullet detection helpers ───────────────────────────────────────────────

// Strong-signal patterns — always count as a metric when matched, regardless of
// surrounding text (e.g. years). `$2M in 2023` still counts as a metric bullet.
const STRONG_METRIC_PATTERNS = [
  /\d+(\.\d+)?%/,
  /\$[\d,.]+[KMBkmb]?\b/,
  /\d+(\.\d+)?[KMBkmb]\+?\b/i,
  /\d+\s*[x×]\b/i,
];

// Four-digit year tokens (1900–2099) are stripped before the bare-digit
// fallback so that date-only bullets like "From 2013 to 2021 …" don't falsely
// register as quantified outcomes.
const YEAR_TOKEN = /\b(19|20)\d{2}\b/g;
const ANY_DIGIT = /\d/;

function bulletHasMetric(text: string): boolean {
  if (STRONG_METRIC_PATTERNS.some((p) => p.test(text))) return true;
  const stripped = text.replace(YEAR_TOKEN, "");
  return ANY_DIGIT.test(stripped);
}

const ACTION_VERBS = new Set([
  "led", "managed", "developed", "built", "designed", "implemented",
  "created", "launched", "drove", "increased", "reduced", "improved",
  "delivered", "established", "optimized", "architected", "scaled",
  "automated", "streamlined", "coordinated", "negotiated", "achieved",
  "spearheaded", "mentored", "transformed", "pioneered", "orchestrated",
  "accelerated", "consolidated", "eliminated", "enhanced", "executed",
  "facilitated", "generated", "integrated", "migrated", "overhauled",
  "redesigned", "refactored", "resolved", "revamped", "simplified",
  "supervised", "trained", "unified", "upgraded",
]);

function startsWithActionVerb(bullet: string): boolean {
  const firstWord = bullet.split(/\s/)[0]?.toLowerCase().replace(/[^a-z]/g, "");
  return ACTION_VERBS.has(firstWord);
}

/**
 * Split a per-role description string into bullet lines. Used by the authed
 * scorer where each ResumeExperience.description holds the bullets for that
 * role only. Filter is a sanity check (>5 chars) — descriptions are already
 * reliably bulleted by the LLM parser.
 */
function splitBullets(description: string): string[] {
  return description
    .split(/\n/)
    .map((line) =>
      line.replace(BULLET_MARKER_RE, "").replace(NUMBERED_BULLET_RE, "").trim(),
    )
    .filter((line) => line.length > 5);
}

/**
 * Single source of truth for the per-bullet math both scorers run. Returns
 * the raw 0..100 sub-scores; the caller maps them into whatever weighted
 * dimension shape it owns (authed: Specificity 0..100; anonymous: out of 40).
 */
function scoreBulletPool(bullets: string[]): {
  total: number;
  metric: number;
  goodStructure: number;
  /** 0..100 — Specificity using SPECIFICITY_TARGET_RATIO. */
  specificity: number;
  /** 0..100 — Structure averaging verb + length half-credits. */
  structure: number;
} {
  if (bullets.length === 0) {
    return {
      total: 0,
      metric: 0,
      goodStructure: 0,
      specificity: 0,
      structure: 0,
    };
  }
  let metric = 0;
  let goodStructure = 0;
  for (const b of bullets) {
    if (bulletHasMetric(b)) metric++;
    let bulletScore = 0;
    if (startsWithActionVerb(b)) bulletScore += 0.5;
    const wc = b.split(/\s+/).filter(Boolean).length;
    if (wc >= BULLET_LENGTH_MIN_WORDS && wc <= BULLET_LENGTH_MAX_WORDS) {
      bulletScore += 0.5;
    }
    goodStructure += bulletScore;
  }
  const ratio = metric / bullets.length;
  return {
    total: bullets.length,
    metric,
    goodStructure,
    specificity: Math.min(
      100,
      Math.round((ratio / SPECIFICITY_TARGET_RATIO) * 100),
    ),
    structure: Math.round((goodStructure / bullets.length) * 100),
  };
}

// ── Specificity scoring (authed) ───────────────────────────────────────────

function scoreSpecificity(
  experience: ResumeExperience[],
): { score: number; flagged_bullets: string[] } {
  if (experience.length === 0) return { score: 0, flagged_bullets: [] };

  // Walk per-role to build the flagged-bullets list (entries with no metric
  // bullet of their own), then pool all bullets and let scoreBulletPool do
  // the math. Keeps per-role flagging — which the anonymous tier doesn't
  // need — while sharing the formula.
  const flagged: string[] = [];
  const allBullets: string[] = [];
  for (const exp of experience) {
    if (exp.metrics_na) continue;
    if (!exp.description) {
      if (exp.id) flagged.push(exp.id);
      continue;
    }
    const bullets = splitBullets(exp.description);
    if (bullets.length === 0) {
      if (exp.id) flagged.push(exp.id);
      continue;
    }
    if (!bullets.some(bulletHasMetric) && exp.id) flagged.push(exp.id);
    allBullets.push(...bullets);
  }

  return { score: scoreBulletPool(allBullets).specificity, flagged_bullets: flagged };
}

// ── Structure scoring (authed) ─────────────────────────────────────────────

function scoreStructure(experience: ResumeExperience[]): number {
  if (experience.length === 0) return 0;
  const allBullets: string[] = [];
  for (const exp of experience) {
    if (exp.description) allBullets.push(...splitBullets(exp.description));
  }
  return scoreBulletPool(allBullets).structure;
}

// ── Completeness scoring (authed) ──────────────────────────────────────────

function scoreCompleteness(data: ResumeData): { score: number; missing: string[] } {
  const missing: string[] = [];
  let totalChecks = 0;
  let passed = 0;

  totalChecks += 3;
  if (data.email) passed++;
  else missing.push("email");
  if (data.phone) passed++;
  else missing.push("phone");
  if (data.location) passed++;
  else missing.push("location");

  totalChecks++;
  if (data.summary && data.summary.length >= COMPLETENESS_SUMMARY_MIN_CHARS) {
    passed++;
  } else {
    missing.push("summary");
  }

  totalChecks++;
  if (data.skills.length >= COMPLETENESS_SKILLS_MIN_COUNT) passed++;
  else missing.push("skills");

  totalChecks++;
  if (data.experience.length > 0) passed++;
  else missing.push("experience");

  for (let i = 0; i < data.experience.length; i++) {
    const exp = data.experience[i];
    totalChecks++;
    if (exp.start_date) {
      passed++;
    } else {
      missing.push(`experience.${i}.start_date`);
    }

    if (!exp.is_current) {
      totalChecks++;
      if (exp.end_date) {
        passed++;
      } else {
        missing.push(`experience.${i}.end_date`);
      }
    }
  }

  for (let i = 0; i < data.experience.length; i++) {
    totalChecks++;
    if (data.experience[i].description && data.experience[i].description!.length > 20) {
      passed++;
    } else {
      missing.push(`experience.${i}.description`);
    }
  }

  totalChecks++;
  if (data.education.length > 0) passed++;
  else missing.push("education");

  if (totalChecks === 0) return { score: 0, missing };
  return {
    score: Math.round((passed / totalChecks) * 100),
    missing,
  };
}

// ── Main scoring function ───────────────────────────────────────────────────

export function computeAtsScore(data: ResumeData): AtsScore {
  const specificity = scoreSpecificity(data.experience);
  const structure = scoreStructure(data.experience);
  const completeness = scoreCompleteness(data);

  const overall = Math.round(
    specificity.score * WEIGHTS.specificity +
    structure * WEIGHTS.structure +
    completeness.score * WEIGHTS.completeness,
  );

  return {
    overall,
    dimensions: {
      specificity,
      structure: { score: structure },
      completeness,
    },
    mode: "deterministic",
    scored_at: new Date().toISOString(),
    algoVersion: ATS_SCORE_ALGO_VERSION,
  };
}

// ── Score tier helpers ──────────────────────────────────────────────────────

export function getScoreTier(score: number): ScoreTier {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  return "low";
}

export function getScoreLabel(tier: ScoreTier): string {
  switch (tier) {
    case "high":
      return "Strong";
    case "medium":
      return "Getting There";
    case "low":
      return "Needs Work";
    default:
      return "Needs Work";
  }
}

// ── Anonymous tier scoring ─────────────────────────────────────────────────
//
// Mirrors the authed `computeAtsScore` dimensions and weights (Specificity 40
// / Structure 30 / Completeness 30) so the anonymous /ats-resume-check page produces
// a number close to what a signed-in user would see. The only inputs we don't
// have without the LLM are per-role bullet attribution and skill extraction —
// the authed scorer walks `experience[i].description` per role; we walk the
// raw text once and treat all detected bullets as a single pool. This loses
// the per-role flagging but keeps the aggregate score honest.
//
// Layout becomes a multiplier (penalty), not a free additive dimension:
// scanned PDFs zero the score, one non-scanned trigger applies a 15% cap,
// two or more applies 30%. Contact and section presence are folded into
// Completeness, matching the authed scorer.

export interface AnonymousAtsScoreDimension {
  score: number;
  max: number;
  /** False when there wasn't enough signal to grade (e.g. no bullets detected
   *  for Specificity). Consumers can render a "—" instead of a misleading 0. */
  gradable: boolean;
}

export interface AnonymousAtsScore {
  overall: number;
  /** The score dimensions before the layout penalty was applied. Useful for
   *  showing "your bullets scored 78 but layout dropped you to 66." */
  preLayoutOverall: number;
  specificity: AnonymousAtsScoreDimension & {
    metricBullets: number;
    totalBullets: number;
  };
  structure: AnonymousAtsScoreDimension & {
    goodBullets: number;
    totalBullets: number;
  };
  completeness: AnonymousAtsScoreDimension & {
    missing: string[];
  };
  layout: {
    triggers: readonly string[];
    /** Multiplier applied to the additive score (1.0 = no penalty). */
    multiplier: number;
    /** Set when the resume is image-only — the score is forced to 0. */
    scanned: boolean;
  };
  /** Scoring algorithm version stamp. Optional so callers persisting the
   *  shape can omit it; current builds always populate via
   *  ATS_SCORE_ALGO_VERSION. */
  algoVersion?: string;
}

export interface AnonymousAtsScoreInput {
  parsed: {
    full_name?: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedin_url?: string;
    summary?: string;
    skills?: string[];
    experience?: {
      title?: string;
      company?: string;
      start_date?: string;
      end_date?: string;
      is_current?: boolean;
    }[];
    education?: { degree?: string; institution?: string }[];
  };
  /** Per-field confidence (0..1). Contact fields below the floor aren't
   *  credited — we don't want to reward a name we couldn't parse. */
  fieldConfidence: Partial<
    Record<
      "full_name" | "email" | "phone" | "location" | "linkedin_url",
      number
    >
  >;
  /** Layout triggers from Tier 0 — typically "two_column" / "scanned" /
   *  "fonts_unmappable". A scanned (or fonts_unmappable) PDF is treated as
   *  a layout failure regardless of other triggers because the parser can't
   *  read image-only / un-decodable text. */
  triggers: readonly string[];
  /** Concatenated text from Tier 0. Used for bullet-level analysis. */
  rawText: string;
}

const ANON_CONTACT_CONFIDENCE_FLOOR = 0.5;
const ANON_MIN_BULLETS_TO_GRADE = 3;
/** Word-count floor for raw-text bullet extraction. The authed splitBullets
 *  uses a char floor instead because its input is already a curated
 *  description string; raw-text extraction needs to skip headers / one-line
 *  section labels that share a leading marker. */
const ANON_BULLET_MIN_WORDS = 4;

const ANON_CONTACT_FIELDS: readonly {
  key: "full_name" | "email" | "phone" | "location" | "linkedin_url";
  label: string;
}[] = [
  { key: "full_name", label: "name" },
  { key: "email", label: "email" },
  { key: "phone", label: "phone" },
  { key: "location", label: "location" },
  { key: "linkedin_url", label: "LinkedIn" },
];

/**
 * Pull bullet-like lines out of raw resume text. A line counts as a bullet
 * when it starts with a recognized bullet marker (`-`, `•`, etc.) or a
 * numbered list prefix and contains 4+ words after the marker is stripped.
 *
 * We deliberately do NOT try to grade unmarked indented lines — most modern
 * resumes use markers, and grading paragraphs would either over-count
 * narrative summary lines or require the experience-section detection we
 * don't have without an LLM.
 */
function extractBulletsFromText(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let stripped = rawLine.replace(BULLET_MARKER_RE, "");
    if (stripped === rawLine) {
      stripped = rawLine.replace(NUMBERED_BULLET_RE, "");
      if (stripped === rawLine) continue;
    }
    const trimmed = stripped.trim();
    if (trimmed.split(/\s+/).filter(Boolean).length < ANON_BULLET_MIN_WORDS) continue;
    out.push(trimmed);
  }
  return out;
}

export function computeAnonymousAtsScore(
  input: AnonymousAtsScoreInput,
): AnonymousAtsScore {
  // ── Bullet-level dimensions (Specificity 40, Structure 30) ─────────────
  // Same scoreBulletPool the authed scorer uses — guarantees the two
  // surfaces apply identical per-bullet rules.
  const bullets = extractBulletsFromText(input.rawText);
  const pool = scoreBulletPool(bullets);
  const gradable = pool.total >= ANON_MIN_BULLETS_TO_GRADE;
  const specScore = gradable ? Math.round((pool.specificity / 100) * 40) : 0;
  const structScore = gradable ? Math.round((pool.structure / 100) * 30) : 0;

  // ── Completeness (30 pts) ──────────────────────────────────────────────
  // Mirrors scoreCompleteness in spirit but works on cascade-shaped data.
  // 5 contact fields (10 pts), summary (3), experience+dates (10), education (4),
  // skills (3). Contact fields are gated by confidence; the rest by presence.
  const completenessChecks: { key: string; passed: boolean; label: string }[] =
    [];
  for (const f of ANON_CONTACT_FIELDS) {
    const value = input.parsed[f.key];
    const conf = input.fieldConfidence[f.key] ?? 0;
    completenessChecks.push({
      key: `contact.${f.key}`,
      passed: Boolean(value) && conf >= ANON_CONTACT_CONFIDENCE_FLOOR,
      label: f.label,
    });
  }
  const expEntries = input.parsed.experience ?? [];
  const eduEntries = input.parsed.education ?? [];
  completenessChecks.push({
    key: "summary",
    passed:
      !!input.parsed.summary &&
      input.parsed.summary.length >= COMPLETENESS_SUMMARY_MIN_CHARS,
    label: "summary",
  });
  completenessChecks.push({
    key: "skills",
    passed:
      (input.parsed.skills?.length ?? 0) >= COMPLETENESS_SKILLS_MIN_COUNT,
    label: "skills",
  });
  completenessChecks.push({
    key: "experience",
    passed: expEntries.length > 0,
    label: "work experience",
  });
  completenessChecks.push({
    key: "education",
    passed: eduEntries.length > 0,
    label: "education",
  });
  // Date completeness — pass if the majority of experience entries carry a
  // start date. We don't know which entry is current vs past at the cascade
  // tier so we don't penalize missing end_date.
  if (expEntries.length > 0) {
    const withStart = expEntries.filter((e) => !!e.start_date).length;
    completenessChecks.push({
      key: "dates",
      passed: withStart / expEntries.length >= 0.5,
      label: "role dates",
    });
  }

  const completenessRatio =
    completenessChecks.filter((c) => c.passed).length /
    completenessChecks.length;
  const completenessScore = Math.round(completenessRatio * 30);
  const completenessMissing = completenessChecks
    .filter((c) => !c.passed)
    .map((c) => c.label);

  // ── Layout penalty ─────────────────────────────────────────────────────
  const isScanned = input.triggers.includes("scanned");
  const nonScannedTriggers = input.triggers.filter((t) => t !== "scanned");
  const multiplier = isScanned
    ? 0
    : nonScannedTriggers.length === 0
      ? 1
      : nonScannedTriggers.length === 1
        ? 0.85
        : 0.7;

  const preLayoutOverall = specScore + structScore + completenessScore;
  const overall = Math.round(preLayoutOverall * multiplier);

  return {
    overall,
    preLayoutOverall,
    specificity: {
      score: specScore,
      max: 40,
      gradable,
      metricBullets: pool.metric,
      totalBullets: pool.total,
    },
    structure: {
      score: structScore,
      max: 30,
      gradable,
      goodBullets: Math.round(pool.goodStructure),
      totalBullets: pool.total,
    },
    completeness: {
      score: completenessScore,
      max: 30,
      gradable: true,
      missing: completenessMissing,
    },
    layout: {
      triggers: input.triggers.slice(),
      multiplier,
      scanned: isScanned,
    },
    algoVersion: ATS_SCORE_ALGO_VERSION,
  };
}
