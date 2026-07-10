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
  ScoreTier,
  ResumeExperience,
  ResumeData,
  ProfileLink,
} from "./types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import {
  deriveContactProfiles,
  isProfileConfident,
  primaryProfileFor,
} from "../contact/contact-profiles.ts";

// Re-export types for convenience
export type { AtsScore, ScoreTier };

// ── Scoring weights ─────────────────────────────────────────────────────────

const WEIGHTS = {
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
 * - 1.1 (2026-06-17): separator-less month-year date ranges now anchor experience entries (#119).
 * - 1.2 (2026-06-19): Word-template parsing + scoring fixes (#29/#30/#31) —
 *   stacked-name / en-dash-phone / column-skills recovery shifts completeness;
 *   bulleted skills leave the experience-bullet pool; redacted role dates earn
 *   partial completeness credit instead of zero. Also: LinkedIn/GitHub identity
 *   links are recovered document-wide; multi-degree education sections extract
 *   every entry; and wrapped-bullet tails no longer leak into the next
 *   experience entry's header.
 * - 1.3 (2026-06-20): the anonymous scorer now pools experience bullets from
 *   the accomplishment sections (experience / projects / achievements) via
 *   SectionedResume instead of walking all of rawText and subtracting skills
 *   (#133). Bullets outside those sections (e.g. in summary / education / an
 *   un-segmented "other" region) no longer enter the Specificity / Structure
 *   pool; skills are excluded by construction (skills is not an accomplishment
 *   section), so the retired "pool everything, subtract skills" side-channel is
 *   gone. The experience-completeness check now asks "is there a non-empty
 *   experience section?" rather than "did we see any bullet anywhere?".
 * - 1.4 (2026-06-23): validity-aware phone completeness credit (#70) — a
 *   parsed-but-invalid phone (libphonenumber isValid===false) earns half
 *   completeness credit instead of full; valid phones unchanged, absent
 *   unchanged.
 * - 1.5 (2026-07-10): the glyph-less-experience bullet fallback is now gated
 *   per accomplishment section instead of on the whole bullet pool (#365) — a
 *   résumé whose Experience section renders bullets as marker-less paragraphs
 *   (Google-Docs/Skia export) but whose Achievements/Projects sections still
 *   carry `•` glyphs previously lost Experience's bullets from Specificity /
 *   Structure entirely, because the old gate only backfilled when NO section
 *   had any glyph bullets. Only affects resumes with this mixed glyph/no-glyph
 *   shape; unaffected resumes score unchanged.
 */
// Internal-only: surfaced to the UI via the `algoVersion` score field, not
// imported by name anywhere — so it stays unexported to satisfy the dead-code
// gate (fallow flags exported symbols with no external consumer).
const ATS_SCORE_ALGO_VERSION = "1.5";

// ── Shared scoring rules ────────────────────────────────────────────────────
//
// Single source of truth for the rules both the authed and anonymous scorers
// apply. Hoisted out of the per-scorer functions so the two surfaces can never
// silently disagree (e.g. authed counting `-` as a bullet but anonymous also
// counting `–`). When tuning these, every consumer that calls scoreBulletPool,
// splitBullets, or extractBulletsFromSections sees the change.

/** Bullet markers we recognize at the start of a line. Wider than typical to
 *  catch en-dash / mid-dot resumes alongside the common dash/asterisk/bullet.
 *  U+FFFD (replacement char) handles PDFs whose font has the bullet glyph
 *  but ships a ToUnicode map that doesn't decode it — pdfjs surfaces these
 *  as `□`. U+F0B7 is the Symbol-font bullet glyph Microsoft Word emits
 *  in the private-use area for every default `•` bullet — extremely common
 *  in Word-exported resumes. Neither trips the `fonts_unmappable` cascade (the
 *  rest of the text decodes fine) but without them every bullet would silently
 *  disappear from the per-bullet feedback section. */
const BULLET_MARKER_RE = /^[\s ]*[-*•●–▪◦‣▶►·�]\s+/;

/** Numbered-list prefix: "1." or "1)". */
const NUMBERED_BULLET_RE = /^[\s ]*\d+[.)]\s+/;

/** Word-count window for a "well-formed" bullet (Structure dimension). */
const BULLET_LENGTH_MIN_WORDS = 8;
const BULLET_LENGTH_MAX_WORDS = 30;

/** Ratio of metric-bearing bullets that earns full Specificity credit (100). */
const SPECIFICITY_TARGET_RATIO = 0.6;

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

/** Month names (incl. "Sept"), for anchoring redaction tokens to a date slot. */
const MONTH_NAME =
  "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";

/**
 * Year-position redaction placeholders in a *date* context (#31). Résumé
 * templates ship dates as redaction stubs the parser can't read as a year:
 *   - `20XX` / `20--` (with any dash) — unambiguous year stubs, matched bare.
 *   - `XXXX` / `####` — only when anchored to a month ("August XXXX") or a
 *     range dash ("XXXX – XXXX"), so a stray `####` elsewhere doesn't trip it.
 * Detecting these lets completeness score a redacted date distinctly from a
 * wholly-missing one and surface "use 4-digit years" guidance.
 */
const REDACTED_DATE_RE = new RegExp(
  [
    "\\b20XX\\b",
    "\\b20[-\\u2012\\u2013\\u2014]{2}",
    `${MONTH_NAME}\\s+(?:XXXX|####)`,
    "(?:XXXX|####)\\s*[-\\u2012\\u2013\\u2014]\\s*(?:XXXX|####|20XX|Present|Current)",
  ].join("|"),
  "i",
);

function bulletHasMetric(text: string): boolean {
  if (STRONG_METRIC_PATTERNS.some((p) => p.test(text))) return true;
  const stripped = text.replace(YEAR_TOKEN, "");
  return ANY_DIGIT.test(stripped);
}

/**
 * Curated past-tense action verbs used to grade the user's *existing*
 * bullets. Exported so the rewrite eval (`src/lib/webllm/eval/verbs.ts`)
 * can reuse this as the base set without duplicating it — the eval set
 * adds present-tense and IC-discipline verbs on top, but the scorer's
 * specificity-dimension semantics stay anchored here.
 *
 * Kept narrow on purpose: weak generic verbs ("worked", "helped",
 * "supported", "responsible", "assisted", "participated") are deliberately
 * NOT here. A bullet leading with one of those SHOULD fail the
 * specificity check.
 */
export const ACTION_VERBS: ReadonlySet<string> = new Set([
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
 * Per-bullet observation surfaced to the UI so a low score becomes "here are
 * the three bullets to focus on changing" instead of "you're losing points on
 * Specificity." Same three checks scoreBulletPool aggregates, kept per-bullet.
 */
export interface BulletObservation {
  /** Original text of the bullet, as extracted from the accomplishment sections. */
  text: string;
  /** Index in the order bullets were extracted from the accomplishment sections.
   *  Stable for UI lists. */
  index: number;
  hasMetric: boolean;
  startsWithActionVerb: boolean;
  wellFormedLength: boolean;
  /** Word count after marker strip — useful for the "two words — expand it" copy. */
  wordCount: number;
}

/**
 * Per-bullet view of the same three checks scoreBulletPool aggregates. Kept
 * parallel to scoreBulletPool (not folded into its return shape) so the
 * authed scorer in ~/recruidea that consumes the math signature stays stable
 * and only the anonymous surface pays the per-bullet cost.
 */
function analyzeBullets(bullets: string[]): BulletObservation[] {
  return bullets.map((text, index) => {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return {
      text,
      index,
      hasMetric: bulletHasMetric(text),
      startsWithActionVerb: startsWithActionVerb(text),
      wellFormedLength:
        wordCount >= BULLET_LENGTH_MIN_WORDS &&
        wordCount <= BULLET_LENGTH_MAX_WORDS,
      wordCount,
    };
  });
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
  extraSources: { description?: string }[] = [],
): { score: number; flagged_bullets: string[] } {
  if (experience.length === 0 && extraSources.length === 0)
    return { score: 0, flagged_bullets: [] };

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

  // Project (#95) and achievement (#96) bullets feed the same pool as experience
  // bullets. These extra sources carry no per-entry id, so they contribute to the
  // aggregate math but not to the per-role flagged-bullets list.
  for (const src of extraSources) {
    if (src.description) allBullets.push(...splitBullets(src.description));
  }

  return { score: scoreBulletPool(allBullets).specificity, flagged_bullets: flagged };
}

// ── Structure scoring (authed) ─────────────────────────────────────────────

function scoreStructure(
  experience: ResumeExperience[],
  extraSources: { description?: string }[] = [],
): number {
  if (experience.length === 0 && extraSources.length === 0) return 0;
  const allBullets: string[] = [];
  for (const exp of experience) {
    if (exp.description) allBullets.push(...splitBullets(exp.description));
  }
  // Project (#95) and achievement (#96) bullets pool alongside experience bullets.
  for (const src of extraSources) {
    if (src.description) allBullets.push(...splitBullets(src.description));
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
  // Projects (#95) and heuristic achievements (#96) both contribute their bullet
  // bodies to the same pool as experience bullets — pooled here as extra sources.
  const extraSources = [
    ...(data.projects ?? []),
    ...(data.heuristic_achievements ?? []),
  ];
  const specificity = scoreSpecificity(data.experience, extraSources);
  const structure = scoreStructure(data.experience, extraSources);
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
// the authed scorer walks `experience[i].description` per role; we pool bullets
// from the accomplishment sections (experience / projects / achievements) of
// the typed `SectionedResume` and treat them as a single pool (#133). This
// loses the per-role flagging but keeps the aggregate score honest, and — by
// pooling from the sections rather than walking all of rawText and subtracting
// skills — keeps skills out of the pool by construction.
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
    /** True when at least one role's date is a redaction stub (e.g. "20XX")
     *  rather than wholly absent (#31). Drives the "use 4-digit years" UI
     *  hint; the date check still counts as incomplete. */
    redactedDates?: boolean;
  };
  layout: {
    triggers: readonly string[];
    /** Multiplier applied to the additive score (1.0 = no penalty). */
    multiplier: number;
    /** Set when the resume is image-only — the score is forced to 0. */
    scanned: boolean;
  };
  /** Per-bullet observations from the same pool that fed Specificity and
   *  Structure. Empty array when no bullet-shaped lines were detected.
   *  Optional so callers persisting the shape (e.g. session storage) can
   *  omit it. */
  bullets?: BulletObservation[];
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
    /** libphonenumber isValid() result plumbed from extraction (#70). When
     *  present and false, the phone earns half completeness credit. When absent
     *  or undefined with a present phone, backward-compatible full credit. */
    phoneIsValid?: boolean;
    location?: string;
    /** Legacy contact-link slots. Since #427 the scorer reads these through the
     *  consolidated `deriveContactProfiles` list (which stamps each with its
     *  `fieldConfidence`), not directly — a code profile (GitHub) still
     *  satisfies the brand-neutral "Professional profile" check just like
     *  LinkedIn (#421 Blocking #2), now expressed over the list. */
    linkedin_url?: string;
    github_url?: string;
    portfolio_url?: string;
    website_url?: string;
    /** Consolidated contact-link list (#427). Extra links beyond the four legacy
     *  slots ride here; the derivation folds the slots + these into one list. */
    profiles?: ProfileLink[];
    summary?: string;
    skills?: string[];
    experience?: {
      title?: string;
      company?: string;
      start_date?: string;
      end_date?: string;
      is_current?: boolean;
      /** Role body. Used as a fallback bullet source for glyph-less prose
       *  templates whose accomplishment sections yield no marker bullets. */
      description?: string;
    }[];
    education?: { degree?: string; institution?: string }[];
  };
  /** Per-field confidence (0..1). Contact fields below the floor aren't
   *  credited — we don't want to reward a name we couldn't parse. */
  fieldConfidence: Partial<
    Record<
      "full_name" | "email" | "phone" | "location" | "linkedin_url" | "github_url",
      number
    >
  >;
  /** Layout triggers from Tier 0 — typically "two_column" / "scanned" /
   *  "fonts_unmappable". A scanned (or fonts_unmappable) PDF is treated as
   *  a layout failure regardless of other triggers because the parser can't
   *  read image-only / un-decodable text. */
  triggers: readonly string[];
  /** Concatenated text from Tier 0. No longer the bullet pool source (#133 —
   *  bullets now come from `sections`); retained only for the redacted-date
   *  scan (`REDACTED_DATE_RE`), which checks the whole document for year-stub
   *  tokens like "August 20XX" regardless of section. */
  rawText: string;
  /** Typed view of the detected section structure, supplied by the cascade
   *  (which owns section detection). The scorer pools experience bullets from
   *  `sections.accomplishmentSections` (experience / projects / achievements)
   *  via `extractBulletsFromSections` (#133). Skills are excluded by
   *  construction — skills is not an accomplishment section, so its lines are
   *  never in the pool and never judged by the action-verb / metric / length
   *  rules. The pure scorer does not re-derive sections from `rawText`. */
  sections: SectionedResume;
}

const ANON_CONTACT_CONFIDENCE_FLOOR = 0.5;
/** Completeness credit for a phone that parsed but failed libphonenumber isValid(). */
const PHONE_INVALID_CREDIT = 0.5;
const ANON_MIN_BULLETS_TO_GRADE = 3;
/** Word-count floor for section bullet extraction. Set to 1 so the displayed
 *  bullet count matches what the user can see in the PDF — every line that
 *  begins with a recognised marker AND has at least one non-empty word is a
 *  bullet. Quality grading (well-formed length window, action verb, metric)
 *  is handled downstream by `scoreBulletPool` and `analyzeBullets`, which
 *  naturally penalise short bullets without hiding them from the count.
 *  Issue #9 — previously set to 4, which silently dropped legitimate short
 *  bullets like "• Everything that matters." and caused bullet count to
 *  under-report vs. the visible PDF. */
const ANON_BULLET_MIN_WORDS = 1;

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

/** A line that is *only* a bullet glyph (no text after it). Word tables can
 *  place the glyph and its text in separate cells, so pdfjs/pdftotext emit the
 *  marker on its own line followed by the text on the next — see #30. Dash-style
 *  markers are excluded here: a lone "-"/"–" line is far more often a divider
 *  than a bullet whose text wandered onto the next line. */
const LONE_BULLET_RE = /^\s*[•●▪◦‣▶►·�]\s*$/;

/**
 * Pull bullet-like lines out of one section's line array. A line counts as a
 * bullet when it starts with a recognized bullet marker (`-`, `•`, etc.) or a
 * numbered list prefix and the stripped line contains at least one word. The
 * displayed count is meant to match what a reader sees in the PDF — short or
 * low-quality bullets are still bullets, they just get flagged by the
 * downstream length / verb / metric checks in `scoreBulletPool` and
 * `analyzeBullets`.
 *
 * `lines` is one section's already trimmed, non-empty text lines (as produced
 * by `toSectionedResume` in sections.ts), so we don't skip blanks — but the
 * lone-bullet merge still looks at the NEXT element in the same array.
 *
 * We deliberately do NOT grade unmarked lines — pooling unmarked lines would
 * over-count narrative role-summary lines. The section boundary is what scopes
 * the pool to accomplishment content; marker detection scopes it to bullets.
 */
function extractBulletsFromLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let rawLine = lines[i];
    // Lone-bullet merge (#30): a marker-only line adopts the next line in this
    // same section as its text, recovering Word-table layouts that split the
    // glyph and its text into separate cells (and thus separate extracted
    // lines). The section lines are already non-empty, so the next element is
    // the text — no blank-skipping needed.
    if (LONE_BULLET_RE.test(rawLine)) {
      const j = i + 1;
      if (j >= lines.length) break;
      rawLine = `${rawLine.trimEnd()} ${lines[j].trim()}`;
      i = j;
    }
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

/**
 * Pool experience bullets from the accomplishment sections (experience /
 * projects / achievements) of the typed {@link SectionedResume}, in canonical
 * policy order (#133). This is what the authed scorer already does per-role
 * (`scoreSpecificity` walks `experience[i].description` then pools project /
 * achievement bullets); pooling directly from the sections aligns the two
 * surfaces and removes the last raw-text re-derivation.
 *
 * Skills are excluded by construction — skills is not an accomplishment
 * section, so its lines never enter the pool and are never judged by the
 * action-verb / metric / length rules. This is the structural replacement for
 * the retired "pool all of rawText, subtract a skills-line set" shape (#30 /
 * #132), which was the reason a skills side-channel was needed at all.
 */
function extractBulletsFromSections(sections: SectionedResume): string[] {
  const out: string[] = [];
  for (const name of sections.accomplishmentSections) {
    const lines = sections.byName.get(name);
    if (lines && lines.length > 0) out.push(...extractBulletsFromLines(lines));
  }
  return out;
}

/** Marker-bullet lines pooled from the `experience` section ALONE (#365) — the
 *  subset of {@link extractBulletsFromSections} scoped to one accomplishment
 *  section, so the caller can tell "experience carries no glyph bullets" apart
 *  from "no accomplishment section carries glyph bullets". See
 *  {@link poolExperienceDescriptions} for why that distinction matters. */
function extractExperienceSectionBullets(sections: SectionedResume): string[] {
  const lines = sections.byName.get("experience");
  return lines && lines.length > 0 ? extractBulletsFromLines(lines) : [];
}

/**
 * Fallback bullet pool for marker-less prose templates: each parsed role's
 * `description` (one paragraph per line, the shape the entry-block parser folds
 * wrapped prose into) becomes one or more bullets via `splitBullets`.
 *
 * Gated on the EXPERIENCE section's own marker-bullet pool being empty (#365),
 * not the whole-résumé pool: a Google-Docs / Skia export can render Experience
 * bullets as glyph-less paragraphs while Achievements/Projects in the SAME
 * résumé keep their `•` glyphs, so the old "only when the whole pool is empty"
 * gate never fired — Achievements' non-empty pool silently swallowed
 * Experience's already-correctly-parsed bullets from both the score and the
 * `groupBulletsByExperience` UI attribution (every role showed "No
 * bullet-shaped lines detected"). Gating per-section instead means a glyph
 * résumé (experience section pool non-empty) never double-counts, while a
 * glyph-less experience section always gets backfilled regardless of what
 * other sections carry.
 *
 * Scope note: pools experience descriptions only — not project (#95) or
 * achievement (#96) descriptions, which the authed scorer also pools. A
 * glyph-less template whose prose lives solely in a projects/achievements
 * section (with an empty accomplishment-section pool) still grades 0; broaden
 * the fallback source if such a fixture surfaces.
 */
function poolExperienceDescriptions(
  experience: { description?: string }[] | undefined,
): string[] {
  const out: string[] = [];
  for (const e of experience ?? []) {
    if (e.description) out.push(...splitBullets(e.description));
  }
  return out;
}

export function computeAnonymousAtsScore(
  input: AnonymousAtsScoreInput,
): AnonymousAtsScore {
  // ── Bullet-level dimensions (Specificity 40, Structure 30) ─────────────
  // Same scoreBulletPool the authed scorer uses — guarantees the two
  // surfaces apply identical per-bullet rules.
  // Primary bullet source: marker-bearing lines pooled from the accomplishment
  // sections. Fallback (#365): glyph-less prose templates (Word / Office,
  // Google-Docs/Skia exports) write each role's description as a marker-less
  // paragraph, so the EXPERIENCE section's own pool comes back empty — pool the
  // parsed per-role descriptions instead (mirrors the authed scorer's per-role
  // `splitBullets`). The description lines split exactly as
  // `groupBulletsByExperience` keys on them, so the UI attributes each pooled
  // bullet to its role. Gated on the experience section alone, not the whole
  // pool, so a résumé whose OTHER accomplishment sections (e.g. Achievements)
  // still carry glyph bullets doesn't mask a glyph-less Experience section —
  // see `poolExperienceDescriptions` for the full rationale.
  const bullets = extractBulletsFromSections(input.sections);
  if (extractExperienceSectionBullets(input.sections).length === 0) {
    bullets.push(...poolExperienceDescriptions(input.parsed.experience));
  }
  const pool = scoreBulletPool(bullets);
  const observations = analyzeBullets(bullets);
  const gradable = pool.total >= ANON_MIN_BULLETS_TO_GRADE;
  const specScore = gradable ? Math.round((pool.specificity / 100) * 40) : 0;
  const structScore = gradable ? Math.round((pool.structure / 100) * 30) : 0;

  // ── Completeness (30 pts) ──────────────────────────────────────────────
  // Mirrors scoreCompleteness in spirit but works on cascade-shaped data.
  // 5 contact fields (10 pts), summary (3), experience+dates (10), education (4),
  // skills (3). Contact fields are gated by confidence; the rest by presence.
  // `credit` defaults to 1 when passed, 0 when not — but a partially-satisfied
  // check (e.g. a redacted date, #31) can earn fractional credit while still
  // counting as "not passed" so it surfaces in `missing`.
  const completenessChecks: {
    key: string;
    passed: boolean;
    label: string;
    credit?: number;
  }[] = [];
  // Contact-link presence is read from the ONE consolidated profile list (#427)
  // — `deriveContactProfiles` stamps each legacy slot with its `fieldConfidence`,
  // so gating the list entry at the confidence floor is byte-identical to the
  // pre-#427 `Boolean(slot) && fieldConfidence[slot] >= floor` read. A code
  // profile (GitHub) satisfies the brand-neutral "Professional profile"
  // requirement just like LinkedIn — same rule the ContactCard applies, so
  // score + display agree that a GitHub-but-no-LinkedIn résumé has no
  // professional-profile gap (#421 Blocking #2).
  const contactProfiles = deriveContactProfiles(
    input.parsed,
    input.fieldConfidence,
  );
  const linkedinPrimary = primaryProfileFor(contactProfiles, "linkedin_url");
  const githubPrimary = primaryProfileFor(contactProfiles, "github_url");
  const githubSatisfies = githubPrimary
    ? isProfileConfident(githubPrimary)
    : false;

  for (const f of ANON_CONTACT_FIELDS) {
    let present: boolean;
    if (f.key === "linkedin_url") {
      // The brand-neutral "Professional profile" row: the confident primary
      // LinkedIn entry, OR a confident code profile (GitHub) satisfying it.
      const linkedinPresent = linkedinPrimary
        ? isProfileConfident(linkedinPrimary)
        : false;
      present = linkedinPresent || githubSatisfies;
    } else {
      const value = input.parsed[f.key];
      const conf = input.fieldConfidence[f.key] ?? 0;
      present = Boolean(value) && conf >= ANON_CONTACT_CONFIDENCE_FLOOR;
    }
    if (f.key === "phone") {
      // Validity-aware phone credit (#70):
      //   present + valid (or validity unknown) → full credit (passed: true)
      //   present + explicitly invalid           → half credit (passed: false, credit: 0.5)
      //   absent or below conf floor             → zero credit (passed: false)
      const phoneInvalid = present && input.parsed.phoneIsValid === false;
      completenessChecks.push({
        key: `contact.${f.key}`,
        passed: present && !phoneInvalid,
        label: f.label,
        ...(phoneInvalid ? { credit: PHONE_INVALID_CREDIT } : {}),
      });
    } else {
      completenessChecks.push({
        key: `contact.${f.key}`,
        passed: present,
        label: f.label,
      });
    }
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
    // Pass when the parser found experience entries OR there is a non-empty
    // experience section (#133, spike §1.5 — ask the typed section structure
    // directly instead of guessing from the global bullet count, the same
    // re-derive-from-rawText anti-pattern this PR retires).
    passed:
      expEntries.length > 0 ||
      (input.sections.byName.get("experience")?.length ?? 0) > 0,
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
  let redactedDates = false;
  if (expEntries.length > 0) {
    const withStart = expEntries.filter((e) => !!e.start_date).length;
    const datesPass = withStart / expEntries.length >= 0.5;
    // A failing date check is "redacted" rather than wholly-missing when the
    // text carries a year-position redaction stub (#31). It stays incomplete
    // but earns half credit and triggers "use 4-digit years" guidance.
    redactedDates = !datesPass && REDACTED_DATE_RE.test(input.rawText);
    completenessChecks.push({
      key: "dates",
      passed: datesPass,
      label: "role dates",
      credit: datesPass ? 1 : redactedDates ? 0.5 : 0,
    });
  }

  const completenessRatio =
    completenessChecks.reduce(
      (sum, c) => sum + (c.credit ?? (c.passed ? 1 : 0)),
      0,
    ) / completenessChecks.length;
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
      ...(redactedDates ? { redactedDates: true } : {}),
    },
    layout: {
      triggers: input.triggers.slice(),
      multiplier,
      scanned: isScanned,
    },
    bullets: observations,
    algoVersion: ATS_SCORE_ALGO_VERSION,
  };
}
