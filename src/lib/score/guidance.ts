// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Deterministic ATS score guidance — pure TypeScript, zero dependencies (#810).
 *
 * Maps scoring dimension gaps (Specificity, Structure, Completeness) to concrete,
 * actionable guidance items tied to individual fields or bullets.
 *
 * Invariants:
 *  - Deterministic: Derived solely from existing score inputs (no LLM, no WebGPU).
 *  - Precise location: Points at a specific target (e.g. "Experience → Role → bullet 2").
 *  - House copy rules: No vendor implications, no false precision, no self-serving negation.
 *  - Algo version untouched: This interprets the score, it does not alter ATS_SCORE_ALGO_VERSION.
 */

import {
  BULLET_LENGTH_MAX_WORDS,
  BULLET_LENGTH_MIN_WORDS,
  COMPLETENESS_SKILLS_MIN_COUNT,
  metricBulletsToFullSpecificity,
  type AnonymousAtsScore,
  type BulletObservation,
} from "./score.ts";
import {
  buildEntryGroups,
  roleLabel,
  type AccomplishmentEntry,
  type BulletGroup,
} from "./group-bullets.ts";
import { SECTION_IDS } from "../anchors.ts";
import { firstUndatedRoleIndex } from "../edit/role-display.ts";

export type GuidanceDimension = "specificity" | "structure" | "completeness";

/** The per-bullet check an issue reports — set only on bullet issues. */
export type BulletCheck = "metric" | "verb" | "length";

export interface GuidanceIssue {
  dimension: GuidanceDimension;
  title: string;
  suggestion: string;
  /** Which bullet check failed, so a caller can tally issues by kind without
   *  matching on `title` (whose length copy carries the word count). */
  check?: BulletCheck;
}

export interface GuidanceItem {
  /** Unique stable key for this target. */
  id: string;
  /** Primary dimension for filtering / badging. */
  dimension: GuidanceDimension;
  /** All dimensions involved on this target. */
  dimensions: GuidanceDimension[];
  /** Human-readable location breadcrumb: e.g. "Experience → Senior Dev · Acme → bullet 2". */
  location: string;
  /** DOM element ID to scroll to and focus. */
  targetAnchor: string;
  targetType: "bullet" | "contact_field" | "section" | "role_header";
  bulletId?: string;
  fieldName?: string;
  /** Concrete issues detected on this target. */
  issues: GuidanceIssue[];
  /** One-line summary for rapid skimming. */
  summary: string;
}

export interface ResumeStructureInput {
  full_name?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin_url?: string;
  github_url?: string;
  summary?: string;
  skills?: string[];
  experience?: Array<{
    title?: string;
    company?: string;
    location?: string;
    start_date?: string;
    end_date?: string;
    is_current?: boolean;
    description?: string;
  }>;
  projects?: AccomplishmentEntry[];
  /** The accomplishment buckets `ReconstructedResume` renders — the heuristic
   *  ones, not the LLM path's structured `achievements`. */
  heuristic_achievements?: AccomplishmentEntry[];
  heuristic_certifications?: AccomplishmentEntry[];
  education?: Array<{
    degree?: string;
    institution?: string;
  }>;
}

/**
 * Encode an arbitrary bullet id as a DOM id. Injective, so two bullets can
 * never share an anchor: every character outside `[A-Za-z0-9-]` — `_`
 * included — becomes `_<hex code point>_`, which a literal character cannot
 * produce.
 */
export function bulletAnchorId(id: string): string {
  return `bullet-${id.replace(
    /[^a-zA-Z0-9-]/gu,
    (c) => `_${c.codePointAt(0)!.toString(16)}_`,
  )}`;
}

/** Anchor ID for a contact field. */
export function contactFieldAnchorId(field: string): string {
  return `contact-field-${field}`;
}

/**
 * One completeness gap that maps to a single fixed guidance item. Each spec
 * fires when `score.completeness.missing` contains `missingKey`.
 */
interface CompletenessSpec {
  missingKey: string;
  id: string;
  location: string;
  targetAnchor: string;
  targetType: GuidanceItem["targetType"];
  fieldName?: string;
  title: string;
  suggestion: string;
  summary: string;
}

/** Contact fields, then the summary — the document sequence above Experience. */
const LEADING_COMPLETENESS: readonly CompletenessSpec[] = [
  {
    missingKey: "name",
    id: "completeness-contact-name",
    location: "Contact → Name",
    targetAnchor: contactFieldAnchorId("full_name"),
    targetType: "contact_field",
    fieldName: "full_name",
    title: "Name not detected",
    suggestion: "Add your full name at the top of your resume.",
    summary: "Add your name",
  },
  {
    missingKey: "email",
    id: "completeness-contact-email",
    location: "Contact → Email",
    targetAnchor: contactFieldAnchorId("email"),
    targetType: "contact_field",
    fieldName: "email",
    title: "Email address missing",
    suggestion: "Add a professional email address for recruiters to contact you.",
    summary: "Add an email address",
  },
  {
    missingKey: "phone",
    id: "completeness-contact-phone",
    location: "Contact → Phone",
    targetAnchor: contactFieldAnchorId("phone"),
    targetType: "contact_field",
    fieldName: "phone",
    title: "Phone number missing or incomplete",
    suggestion: "Add a phone number with area code.",
    summary: "Add a valid phone number",
  },
  {
    missingKey: "location",
    id: "completeness-contact-location",
    location: "Contact → Location",
    targetAnchor: contactFieldAnchorId("location"),
    targetType: "contact_field",
    fieldName: "location",
    title: "Location missing",
    suggestion: "Add your city and state or country (e.g. 'San Francisco, CA' or 'Remote').",
    summary: "Add your location",
  },
  {
    missingKey: "LinkedIn",
    id: "completeness-contact-profile",
    location: "Contact → Professional profile",
    targetAnchor: contactFieldAnchorId("linkedin_url"),
    targetType: "contact_field",
    fieldName: "linkedin_url",
    title: "Professional profile missing",
    suggestion: "Add a LinkedIn or GitHub profile link.",
    summary: "Add a LinkedIn or GitHub profile",
  },
  {
    missingKey: "summary",
    id: "completeness-summary",
    location: "Summary",
    targetAnchor: SECTION_IDS.summary,
    targetType: "section",
    fieldName: "summary",
    title: "Summary missing or brief",
    suggestion: "Add a 2–3 sentence professional summary highlighting your core strengths and domain.",
    summary: "Add a professional summary",
  },
];

/** Education, then skills — the document sequence below the accomplishment sections. */
const TRAILING_COMPLETENESS: readonly CompletenessSpec[] = [
  {
    missingKey: "education",
    id: "completeness-education",
    location: "Education",
    targetAnchor: SECTION_IDS.education,
    targetType: "section",
    title: "Education not detected",
    suggestion: "Add your degree, school or institution, and graduation year.",
    summary: "Add education entry",
  },
  {
    missingKey: "skills",
    id: "completeness-skills",
    location: "Skills",
    targetAnchor: SECTION_IDS.skills,
    targetType: "section",
    fieldName: "skills",
    title: `Skills section has fewer than ${COMPLETENESS_SKILLS_MIN_COUNT} skills`,
    suggestion: "List key technical proficiencies, languages, or tools relevant to your target roles.",
    summary: `Add at least ${COMPLETENESS_SKILLS_MIN_COUNT} skills`,
  },
];

function completenessItem(spec: CompletenessSpec): GuidanceItem {
  return {
    id: spec.id,
    dimension: "completeness",
    dimensions: ["completeness"],
    location: spec.location,
    targetAnchor: spec.targetAnchor,
    targetType: spec.targetType,
    ...(spec.fieldName !== undefined ? { fieldName: spec.fieldName } : {}),
    issues: [{ dimension: "completeness", title: spec.title, suggestion: spec.suggestion }],
    summary: spec.summary,
  };
}

function completenessItems(
  specs: readonly CompletenessSpec[],
  missing: ReadonlySet<string>,
): GuidanceItem[] {
  return specs.filter((spec) => missing.has(spec.missingKey)).map(completenessItem);
}

/** The Experience-level gap: no experience at all outranks missing role dates. */
function experienceCompletenessItem(
  score: AnonymousAtsScore,
  missing: ReadonlySet<string>,
): GuidanceItem | null {
  if (missing.has("work experience")) {
    return completenessItem({
      missingKey: "work experience",
      id: "completeness-experience",
      location: "Experience",
      targetAnchor: SECTION_IDS.experience,
      targetType: "section",
      title: "Work experience not detected",
      suggestion: "Add your past work experience entries with title, company, and dates.",
      summary: "Add work experience entries",
    });
  }
  if (!missing.has("role dates")) return null;
  const isRedacted = Boolean(score.completeness.redactedDates);
  return completenessItem({
    missingKey: "role dates",
    id: "completeness-role-dates",
    location: "Experience → Dates",
    // `ExperienceSection` puts this id on the first role with no start date.
    targetAnchor: SECTION_IDS.experienceDates,
    targetType: "role_header",
    title: isRedacted ? "Role dates use placeholders" : "Role dates missing start dates",
    suggestion: isRedacted
      ? "Replace placeholder years (such as '20XX') with 4-digit calendar years."
      : "Add start dates to your work experience entries.",
    summary: isRedacted ? "Replace year placeholders with 4-digit years" : "Add role start dates",
  });
}

/** The specificity / structure issues one bullet carries, in display order.
 *  `flagMetric` is false once the metric budget is spent (see `metricBudget`). */
function bulletIssues(b: BulletObservation, flagMetric: boolean): GuidanceIssue[] {
  const issues: GuidanceIssue[] = [];
  if (!b.hasMetric && flagMetric) {
    issues.push({
      dimension: "specificity",
      check: "metric",
      title: "Missing measurable metric",
      suggestion: "Add numbers, percentages, or dollar amounts to quantify your result (e.g. 'reduced latency by 40%').",
    });
  }
  if (!b.startsWithActionVerb) {
    issues.push({
      dimension: "structure",
      check: "verb",
      title: "Weak opening verb",
      suggestion: "Start with an action verb in past tense (e.g. 'Shipped', 'Built', 'Led', 'Optimized').",
    });
  }
  if (!b.wellFormedLength) {
    const tooShort = b.wordCount < BULLET_LENGTH_MIN_WORDS;
    const window = `Aim for ${BULLET_LENGTH_MIN_WORDS}–${BULLET_LENGTH_MAX_WORDS} words.`;
    issues.push({
      dimension: "structure",
      check: "length",
      title: `${tooShort ? "Too short" : "Too long"} (${b.wordCount} words)`,
      suggestion: tooShort
        ? `${window} Expand with context on what you built, tools used, or the outcome.`
        : `${window} Tighten wording or break into two focused bullets.`,
    });
  }
  return issues;
}

/** One rendered entry's bullets, labelled the way the résumé names it. */
interface BulletRun {
  section: string;
  group: BulletGroup;
}

/**
 * The bullet runs Fix It can step through, in the order `ReconstructedResume`
 * renders them: each Experience role, then the unmatched bullets it renders at
 * the section's tail.
 *
 * Only those runs are EDITABLE on the page. Project, achievement and
 * certification bullets render as read-only rows (`ResumeBulletRow` with no
 * `onBulletChange`), so a step on one could never be resolved by an edit, and
 * the count on the score card could never reach zero. They are still
 * partitioned out by the page's own `buildEntryGroups` — without them in the
 * pass, their bullets would fall into the Experience tail here while the page
 * renders them under their own entry.
 */
function editableBulletRuns(
  score: AnonymousAtsScore,
  parsed: ResumeStructureInput,
): BulletRun[] {
  const groups = buildEntryGroups(
    parsed.experience ?? [],
    parsed.projects ?? [],
    parsed.heuristic_achievements ?? [],
    parsed.heuristic_certifications ?? [],
    score.bullets ?? [],
  );
  const roles = groups.experienceGroups.map((group) => ({
    section: "Experience",
    group,
  }));
  return groups.other
    ? [...roles, { section: "Experience", group: groups.other }]
    : roles;
}

/**
 * The run the role-dates item sits in front of: the first role with no start
 * date, which is where `ExperienceSection` puts its anchor — both read
 * `firstUndatedRoleIndex`. `parsed` already has the overrides folded in, so
 * none are passed here. 0 (the section's top) when no role qualifies.
 */
function datesRunIndex(
  runs: readonly BulletRun[],
  parsed: ResumeStructureInput,
): number {
  const role = firstUndatedRoleIndex(parsed.experience ?? []);
  const run = runs.findIndex((r) => r.group.experienceIndex === role);
  return run < 0 ? 0 : run;
}

/**
 * How many bullets may still be asked for a metric. Specificity is full once
 * `SPECIFICITY_TARGET_RATIO` of bullets carry one, and past that another
 * number moves nothing — so only the shortfall is flagged, first in document
 * order. Below the grading floor the dimension isn't scored yet; every
 * metric-less bullet stays flagged there.
 */
function metricBudget(score: AnonymousAtsScore): number {
  const { gradable, metricBullets, totalBullets } = score.specificity;
  return gradable
    ? metricBulletsToFullSpecificity(metricBullets, totalBullets)
    : Number.POSITIVE_INFINITY;
}

/** One item per bullet with at least one issue, in run order. `budget` is
 *  shared across calls so the metric shortfall is spent in document order. */
function bulletGuidanceItems(
  runs: readonly BulletRun[],
  budget: { metric: number },
): GuidanceItem[] {
  const items: GuidanceItem[] = [];
  for (const { section, group } of runs) {
    const role = roleLabel(group.experience);
    group.bullets.forEach((b: BulletObservation, bIndex: number) => {
      const flagMetric = !b.hasMetric && budget.metric > 0;
      if (flagMetric) budget.metric--;
      const issues = bulletIssues(b, flagMetric);
      if (issues.length === 0) return;
      const dimensions = new Set(issues.map((i) => i.dimension));
      items.push({
        id: `bullet-${b.id}`,
        dimension: dimensions.has("specificity") ? "specificity" : "structure",
        dimensions: Array.from(dimensions),
        location: [section, role, `bullet ${bIndex + 1}`].join(" → "),
        targetAnchor: bulletAnchorId(b.id),
        targetType: "bullet",
        bulletId: b.id,
        issues,
        summary: issues.map((i) => i.title).join(" · "),
      });
    });
  }
  return items;
}

/**
 * Derive deterministic, actionable guidance items from the anonymous ATS score and resume structure.
 * Items follow the rendered document: Contact → Summary → Experience (the
 * role-dates item in front of the role it lands on, then the section's
 * unmatched bullets) → Education → Skills. Bullets outside Experience are not
 * stepped through — see `editableBulletRuns`.
 */
export function computeScoreGuidance(
  score: AnonymousAtsScore,
  parsed: ResumeStructureInput,
): GuidanceItem[] {
  const missing = new Set(score.completeness.missing);
  const experienceItem = experienceCompletenessItem(score, missing);
  const runs = editableBulletRuns(score, parsed);
  // "No experience at all" sits at the section's top; missing dates sit in
  // front of the first undated role.
  const split =
    experienceItem?.id === "completeness-role-dates"
      ? datesRunIndex(runs, parsed)
      : 0;
  const budget = { metric: metricBudget(score) };
  const before = bulletGuidanceItems(runs.slice(0, split), budget);
  const from = bulletGuidanceItems(runs.slice(split), budget);
  return [
    ...completenessItems(LEADING_COMPLETENESS, missing),
    ...before,
    ...(experienceItem ? [experienceItem] : []),
    ...from,
    ...completenessItems(TRAILING_COMPLETENESS, missing),
  ];
}
