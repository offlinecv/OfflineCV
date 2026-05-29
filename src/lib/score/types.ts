// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Shared resume data shapes. The heuristic kernel produces a partial
 * `ParsedResume`; the anonymous scorer consumes one. Both keep their inputs
 * standalone — no DB or remote-store assumptions reach this layer.
 */

// ── Ambiguity types ────────────────────────────────────────────────────────

export type AmbiguityCategory =
  | "employment_gap"
  | "employment_overlap"
  | "title_normalization"
  | "date_unclear"
  | "content_vague"
  | "format_suggestion"
  | "tenure_structure"
  | "graduation_year_visible"
  | "explicit_tenure_claim"
  | "dated_summary_language"
  | "early_career_date_leak";

export type AmbiguitySeverity = "error" | "warning" | "info";

export interface AmbiguityFieldRef {
  company?: string;
  team?: string;
  title?: string;
  start_date?: string;
  field: string;
}

export interface StructuredAmbiguity {
  category: AmbiguityCategory;
  severity: AmbiguitySeverity;
  description: string;
  field_ref?: AmbiguityFieldRef;
  suggested_value?: string;
}

// ── ATS score types ────────────────────────────────────────────────────────

export interface AtsScoreDimensions {
  specificity: {
    score: number;
    flagged_bullets: string[];
  };
  structure: {
    score: number;
  };
  completeness: {
    score: number;
    missing: string[];
  };
  keyword_match?: {
    score: number;
    jd_id: string;
    gaps: string[];
    matches: string[];
  };
}

export interface AtsScore {
  overall: number;
  dimensions: AtsScoreDimensions;
  mode: "deterministic" | "full";
  scored_at: string;
  /** Scoring algorithm version stamp (see ATS_SCORE_ALGO_VERSION). Optional
   *  for forward-compat with persisted scores that predate the field. */
  algoVersion?: string;
}

export type ScoreTier = "low" | "medium" | "high";

// ── Skill types ────────────────────────────────────────────────────────────

export type ProficiencySignal = "mentioned" | "used" | "led" | "expert";

export interface SkillExplicit {
  skill: string;
  context: string;
  proficiency_signal: ProficiencySignal;
}

export interface SkillInferred {
  skill: string;
  confidence: number;
}

// ── Resume data shapes ─────────────────────────────────────────────────────

export type CareerTrajectory =
  | "climbing"
  | "lateral"
  | "pivoting"
  | "returning"
  | "early_career";

/**
 * Minimal resume experience — used by scoring and ambiguity detection.
 * `ParsedResume.experience` entries extend this with additional LLM fields.
 */
export interface ResumeExperience {
  id?: string;
  title: string;
  company: string;
  team?: string;
  start_date?: string;
  /** Precision the source carried for `start_date`. Consumers that care about
   *  honest rendering ("Apr 2021" vs "Apr 1, 2021") honor this. */
  start_date_precision?: "day" | "month" | "year" | null;
  end_date?: string;
  end_date_precision?: "day" | "month" | "year" | null;
  description?: string;
  is_current?: boolean;
  metrics_na?: boolean;
  title_normalized?: string;
  duration_months?: number;
  seniority_level?: string;
  /** Optional extraction-quality score in [0, 1]. Missing means "trust it". */
  confidence?: number;
}

export interface ResumeEducation {
  id?: string;
  degree: string;
  institution: string;
  year?: string;
  end_date_precision?: "day" | "month" | "year" | null;
  description?: string;
}

// ── Achievements ───────────────────────────────────────────────────────────
// Cross-employer items that don't fit inside an Experience entry's bullets —
// patents, books, publications, founding events, exits, awards, talks,
// fellowships, press, open-source maintainership.

export type AchievementType =
  | "patent"
  | "book"
  | "publication"
  | "founded"
  | "sold"
  | "acquired"
  | "award"
  | "talk"
  | "fellowship"
  | "press"
  | "open_source"
  | "custom";

export interface Achievement {
  type: AchievementType;
  /** One-line freeform title. UI enforces a ~120-char soft cap. */
  title: string;
  year?: number;
  url?: string;
  /** Required when type === "custom". */
  custom_emoji?: string;
  /** Required when type === "custom". One word, used as the label. */
  custom_label?: string;
}

export type AchievementsPlacement = "default" | "above_experience";

/**
 * Minimal resume data shape used by ATS scoring. `ParsedResume` extends this
 * with richer fields.
 */
export interface ResumeData {
  full_name: string;
  email?: string;
  phone?: string;
  current_title?: string;
  location?: string;
  linkedin_url?: string;
  portfolio_url?: string;
  github_url?: string;
  website_url?: string;
  summary?: string;
  skills: string[];
  experience: ResumeExperience[];
  education: ResumeEducation[];
  certifications?: string[];
  achievements?: Achievement[];
  /** "default" renders the Achievements section between Education and Skills;
   *  "above_experience" promotes it between Summary and Experience. */
  achievements_placement?: AchievementsPlacement;
}

/**
 * Full parsed resume — extends `ResumeData` with skill detail and
 * career-trajectory metadata.
 */
export interface ParsedResume extends ResumeData {
  given_name?: string;
  family_name?: string;
  current_company?: string;
  seniority_level?: string;
  years_of_experience?: number;
  skills_explicit: SkillExplicit[];
  skills_inferred: SkillInferred[];
  career_trajectory?: CareerTrajectory;
  domain_classification?: string[];
}
