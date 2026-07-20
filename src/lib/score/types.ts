// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared resume data shapes. The heuristic kernel produces a partial
 * `ParsedResume`; the anonymous scorer consumes one. Both keep their inputs
 * standalone — no DB or remote-store assumptions reach this layer.
 */

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

// ── Profile links (JSON Resume basics.profiles pattern, #335) ───────────────
// A contributor-extensible replacement for the four hardcoded link slots
// (`linkedin_url`, `github_url`, `portfolio_url`, `website_url`). Each detected
// contact link becomes one `ProfileLink`, classified against the host registry
// in `src/lib/contact/profile-registry.ts`. Phase 1 (#335) populates this
// additively — the four legacy keys stay the source of truth for scoring and
// corpus snapshots; #334's `toJsonResume()` maps this to `basics.profiles`.

/** The four legacy `*_url` contact slots a profile can be the primary entry
 *  for (#427). A profile carrying one of these is the source of that legacy
 *  getter's value; a secondary/extra link carries `undefined`. */
export type LegacyLinkKey =
  | "linkedin_url"
  | "github_url"
  | "portfolio_url"
  | "website_url";

/** A single classified contact/identity link. */
export interface ProfileLink {
  /** Normalized canonical href (via the shared `normalizeUrl`). */
  url: string;
  /** Registry label ("GitHub") or the bare hostname when the host is unknown. */
  network: string;
  /** Coarse category used for grouping/UI. Unknown hosts fall to "other". */
  kind: "code" | "social" | "portfolio" | "academic" | "writing" | "other";
  /**
   * Per-entry confidence in [0, 1], mirrored from the source field's
   * `fieldConfidence` at build time (#427). This is what lets the consolidated
   * profile list be the SINGLE contact-link model without moving scores: the
   * scorer + contact display gate a link at the 0.5 confidence floor by reading
   * THIS, exactly as they gated the legacy `*_url` slot's `fieldConfidence`
   * before consolidation. Absent ⇒ treat as trusted (1) — back-compat for
   * profiles built before this field (e.g. persisted JSON-Resume exports).
   */
  confidence?: number;
  /**
   * Which legacy `*_url` slot this profile is the primary entry for (#427), or
   * absent for a secondary/extra link (a second GitHub, a GitLab, ORCID, …).
   * The primary entry per legacy key derives that key's back-compat getter and
   * is what the scorer's contact-completeness check reads, so the consolidated
   * list reproduces the pre-consolidation slot semantics byte-for-byte.
   */
  legacyKey?: LegacyLinkKey;
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
  /** Role location extracted from header — "City, ST" or "City, Country".
   *  Distinct from top-level `ResumeData.location` (candidate address). */
  location?: string;
  /** Verbatim heading of the experience-category section this role came from
   *  (#311) — e.g. "Performance Experience" vs "Teaching Experience" when a
   *  résumé carries more than one experience section. Display/round-trip only;
   *  scoring pools every role flat regardless of group. ABSENT for the common
   *  single-experience-section case (back-compat): consumers fall back to the
   *  canonical "Experience" heading, so output is unchanged when unset. Present
   *  only when ≥2 distinct experience-category sections were detected. */
  section_label?: string;
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
  /** Subject / field of study parsed from the degree line — the "Computer
   *  Science" in "B.S. in Computer Science" or "Bachelor of Technology in
   *  Computer Science & Engineering". `degree` keeps only the bare credential
   *  ("B.S.", "Bachelor of Technology"); the subject lives here. Absent when the
   *  degree line carries no parseable field. */
  field?: string;
  institution: string;
  /** Institution location ("City, ST" / "City, Country") peeled off the
   *  institution line so `institution` is free of trailing location text.
   *  Mirrors `ResumeExperience.location`; distinct from top-level candidate
   *  address. */
  location?: string;
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
  /** Relevant-coursework items recovered from bullet lines inside the education
   *  section (e.g. a "Relevant Coursework" block, #164). Section-level by nature
   *  — attribution to a specific degree is ambiguous, so the heuristic parser
   *  attaches the whole list to the first (primary) entry. */
  coursework?: string[];
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
// The deterministic parser cannot CLASSIFY an achievement into the closed
// `AchievementType` enum (patent vs. award vs. talk) — that requires the LLM
// path, which populates the structured `Achievement[]` above. Rather than
// fabricate a classification (and the `custom_emoji`/`custom_label` that
// `type: "custom"` mandates), the heuristic path emits this honest,
// structure-free shape: a title-led item with an optional VERBATIM type label,
// year, url, and a bullet body, mirroring `ResumeProject`. Issue #96.

export interface HeuristicAchievement {
  /** The verbatim leading label the header carried before its first `" · "`
   *  ("Patent", "Best Paper Award"), when short enough to read as a label
   *  rather than prose — see `splitAchievementType`. NOT the classified
   *  `AchievementType` enum: free text, exactly as written.
   *
   *  A real field, not a run of `title` (#456). It was briefly modelled as the
   *  leading `" · "` segment of a composed `title` (#454, design model (a)),
   *  but `decompose ∘ join` is not the identity — every consumer holding only
   *  the composed title re-split it differently from what the user typed (the
   *  PDF bolded the wrong run; `/jd-fit` showed the wrong halves). Storing the
   *  label makes the split happen exactly once, at parse. */
  type?: string;
  /** Item title, WITHOUT the leading {@link type} label. Empty string only when
   *  the block carried no usable header line. */
  title: string;
  /** Lead year when the header carried a date (achievements show a single year,
   *  not a range — we keep the first year of any range the header carried). */
  year?: string;
  /** The punctuation the source put between {@link title} and {@link year}
   *  ("Globex Engineering Excellence, 2021" → `","`), when it used any.
   *
   *  The header is stored decomposed (type / title / year) and RE-COMPOSED by
   *  every consumer that shows it — the edit surface and the PDF exporter — so
   *  each of them has to emit some separator. Without the source's own, they
   *  hardcoded a middot and rewrote the résumé's comma into "Globex Engineering
   *  Excellence · 2021" (#380). Absent (whitespace-separated in the source) is
   *  NOT the same as "no separator": consumers fall back to the middot, which is
   *  the only thing that keeps the year legible as a distinct field. */
  year_separator?: string;
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
  /** Professional headline as it appears standalone in the résumé's header
   *  block — a job-title tagline the candidate placed under their name
   *  ("Engineering Lead"), distinct from `current_title` (derived from the
   *  most-recent experience role). Surfaced so the ATS export can redraw it
   *  under the name instead of silently dropping it (#425 follow-up). */
  headline?: string;
  location?: string;
  linkedin_url?: string;
  portfolio_url?: string;
  github_url?: string;
  website_url?: string;
  /** Contributor-extensible classified contact links (#335). Additive in
   *  Phase 1 — mirrors the four legacy `*_url` keys above (which remain the
   *  scoring/snapshot source of truth). #334 maps this to `basics.profiles`. */
  profiles?: ProfileLink[];
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
