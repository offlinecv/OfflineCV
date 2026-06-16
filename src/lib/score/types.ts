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
  /**
   * Lead year of the education entry, kept for back-compat with consumers that
   * only show a single year (`looksLikeStudent`, the reconstructed view). When a
   * date range is parsed, this is the year of `end_date` (graduation), falling
   * back to `start_date`.
   */
  year?: string;
  /** Start of an attendance range, e.g. "Sep 2024" in "Sep 2024 - July 2025".
   *  Absent for a single graduation date ("Expected Graduation: May 2027"). */
  start_date?: string;
  start_date_precision?: "day" | "month" | "year" | null;
  /** End / graduation date. For a single date the date lands here, not in
   *  `start_date`. */
  end_date?: string;
  end_date_precision?: "day" | "month" | "year" | null;
  description?: string;
}

// ── Projects ───────────────────────────────────────────────────────────────
// A standalone Projects section (personal / academic / side projects). Unlike
// Experience, a project entry is name-led and its date is optional — many
// projects carry no date at all. Bullets describe what was built; the scorer
// reads `description` the same way it reads `ResumeExperience.description`.

export interface ResumeProject {
  /** Project name — the header line that leads the entry. Empty string only
   *  when the block carried no usable header line. */
  name: string;
  /** Start of the date range, when the header carried one. */
  start_date?: string;
  /** End of the date range, when present. */
  end_date?: string;
  /** True when the header's date range ended in "Present"/"Current". */
  is_current?: boolean;
  /** Bullet body joined with "\n", mirroring `ResumeExperience.description`. */
  description?: string;
  /** A URL on the header line (repo / live demo), when one was detected. */
  url?: string;
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

// ── Heuristic achievements ──────────────────────────────────────────────────
// The deterministic parser cannot classify an achievement's TYPE (patent vs.
// award vs. talk) — that requires the LLM path, which populates the structured
// `Achievement[]` above. Rather than fabricate a `type` (and the
// `custom_emoji`/`custom_label` that `type: "custom"` mandates), the heuristic
// path emits this honest, structure-free shape: a name-led item with optional
// year/url and a bullet body, mirroring `ResumeProject`. A name-led item is the
// most a regex parser can truthfully assert about an Achievements / Activities
// / Awards block. Issue #96, design option (a).

export interface HeuristicAchievement {
  /** Item title — the header line that leads the entry. Empty string only when
   *  the block carried no usable header line. */
  title: string;
  /** Lead year when the header carried a date (achievements show a single year,
   *  not a range — we keep the first year of any range the header carried). */
  year?: string;
  /** A URL on the header line (e.g. a publication / patent link), when found. */
  url?: string;
  /** Bullet body joined with "\n", mirroring `ResumeProject.description`, so the
   *  scorer reads it the same way it reads experience and project bullets. */
  description?: string;
}

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
  projects?: ResumeProject[];
  certifications?: string[];
  achievements?: Achievement[];
  /** Heuristic-path achievements (#96): honest, structure-free items the
   *  deterministic parser can assert without classifying a type. The LLM path
   *  populates the structured `achievements` above instead. */
  heuristic_achievements?: HeuristicAchievement[];
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
