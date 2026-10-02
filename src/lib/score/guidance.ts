// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Deterministic ATS score guidance — pure TypeScript, zero dependencies (#810).
 *
 * Maps scoring dimension gaps (Specificity, Structure, Completeness) to concrete,
 * actionable guidance items tied to individual fields or bullets.
 *
 * Invariants:
 *  - Deterministic: Derived solely from its inputs — the score, the parse, and
 *    optionally the on-device critique's bullet findings the caller already
 *    holds (#1008). This module never runs a model; with no findings passed,
 *    the output is exactly the heuristic guidance.
 *  - Precise location: Points at a specific target (e.g. "Experience → Role → bullet 2").
 *  - House copy rules: No vendor implications, no false precision, no self-serving negation
 *    (docs/CONTRIBUTING-PROCESS.md § "Copy rules (user-facing text)").
 *  - Algo version untouched: This interprets the score, it does not alter ATS_SCORE_ALGO_VERSION.
 */

import {
  ANON_MIN_BULLETS_TO_GRADE,
  BULLET_LENGTH_MAX_WORDS,
  BULLET_LENGTH_MIN_WORDS,
  COMPLETENESS_SKILLS_MIN_COUNT,
  EXPERIENCE_MISSING_LABEL,
  metricBulletsToFullSpecificity,
  type AnonymousAtsScore,
  type BulletObservation,
} from "./score.ts";
import {
  buildEntryGroups,
  computeExperienceHeadings,
  roleLabel,
  type AccomplishmentEntry,
  type BulletGroup,
} from "./group-bullets.ts";
import { matchCritiqueFindings } from "./critique-match.ts";
import type { BulletFinding } from "../webllm/critique-resume.ts";
import { CONTACT_DISPLAY_CONFIDENCE_FLOOR } from "../contact.ts";
import { SECTION_IDS } from "../anchors.ts";
import { firstUndatedRoleIndex } from "../edit/role-display.ts";

export type GuidanceDimension = "specificity" | "structure" | "completeness";

/** The per-bullet check an issue reports — set only on bullet issues. The
 *  first three are the heuristic checks; `critique` is a finding from the
 *  on-device critique, folded in by text match (#1008). */
export type BulletCheck = "metric" | "verb" | "length" | "critique";

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
  /** libphonenumber isValid() result (#1023) — plumbed straight from
   *  `HeuristicParsedResume.phoneIsValid`, not re-derived, so a present-but-
   *  invalid phone can be told apart from one that merely parsed with low
   *  confidence without adding anything to the score object itself. */
  phoneIsValid?: boolean;
  /** `fieldConfidence.phone` (#1023) — the invalid-phone check only applies
   *  once the field has cleared the confidence floor `score.ts` gates
   *  presence on (`CONTACT_DISPLAY_CONFIDENCE_FLOOR`, the same value under a
   *  separate name — see `contact-profiles.ts`'s note on the pair). Without
   *  it, a low-confidence phone that also happens to fail libphonenumber
   *  validation would get "check the number" copy instead of "hard to read",
   *  even though `score.ts` flagged it for confidence, not validity. */
  phoneConfidence?: number;
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
    /** Verbatim heading of the experience-category section this role came
     *  from (#311) — see `ResumeExperience.section_label`. Threaded through so
     *  the location breadcrumb can resolve the SAME heading `ExperienceSection`
     *  renders instead of hardcoding "Experience" (#1023). */
    section_label?: string;
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

/**
 * One contact-field completeness gap (#1023, D2). Unlike {@link CompletenessSpec}
 * this carries the ABSENT-value copy only — {@link contactCompletenessItem}
 * picks between it and the `low_confidence` / `invalid` copy from the D2 table
 * depending on whether the field round-tripped through `parsed` non-empty.
 */
interface ContactSpec {
  missingKey: string;
  id: string;
  location: string;
  targetAnchor: string;
  fieldName: "full_name" | "email" | "phone" | "location" | "linkedin_url";
  /** Noun for the low-confidence "hard to read" / "easier to read" copy —
   *  e.g. "Professional profile", not the internal `fieldName`. */
  fieldLabel: string;
  title: string;
  suggestion: string;
  summary: string;
}

/** Contact fields — the document sequence above Summary. */
const CONTACT_COMPLETENESS: readonly ContactSpec[] = [
  {
    missingKey: "name",
    id: "completeness-contact-name",
    location: "Contact → Name",
    targetAnchor: contactFieldAnchorId("full_name"),
    fieldName: "full_name",
    fieldLabel: "Name",
    title: "Name not detected",
    suggestion: "Add your full name at the top of your resume.",
    summary: "Add your name",
  },
  {
    missingKey: "email",
    id: "completeness-contact-email",
    location: "Contact → Email",
    targetAnchor: contactFieldAnchorId("email"),
    fieldName: "email",
    fieldLabel: "Email",
    title: "Email address missing",
    suggestion: "Add a professional email address for recruiters to contact you.",
    summary: "Add an email address",
  },
  {
    missingKey: "phone",
    id: "completeness-contact-phone",
    location: "Contact → Phone",
    targetAnchor: contactFieldAnchorId("phone"),
    fieldName: "phone",
    fieldLabel: "Phone",
    title: "Phone number missing or incomplete",
    suggestion: "Add a phone number with area code.",
    summary: "Add a valid phone number",
  },
  {
    missingKey: "location",
    id: "completeness-contact-location",
    location: "Contact → Location",
    targetAnchor: contactFieldAnchorId("location"),
    fieldName: "location",
    fieldLabel: "Location",
    title: "Location missing",
    suggestion: "Add your city and state or country (e.g. 'San Francisco, CA' or 'Remote').",
    summary: "Add your location",
  },
  {
    missingKey: "LinkedIn",
    id: "completeness-contact-profile",
    location: "Contact → Professional profile",
    targetAnchor: contactFieldAnchorId("linkedin_url"),
    fieldName: "linkedin_url",
    fieldLabel: "Professional profile",
    title: "Professional profile missing",
    suggestion: "Add a LinkedIn or GitHub profile link.",
    summary: "Add a LinkedIn or GitHub profile",
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

/** The value a contact spec's score.ts check reads, read here only to tell an
 *  ABSENT field apart from one that round-tripped through the parse non-empty
 *  (#1023) — never to change whether the field counts as complete, which stays
 *  entirely score.ts's call. */
function contactFieldValue(
  fieldName: ContactSpec["fieldName"],
  parsed: ResumeStructureInput,
): string | undefined {
  if (fieldName === "linkedin_url") {
    // Same brand-neutral either/or the scorer applies (score.ts, the
    // `linkedinPresent || githubSatisfies` branch).
    return parsed.linkedin_url || parsed.github_url;
  }
  return parsed[fieldName];
}

type ContactReason = "absent" | "invalid" | "low_confidence";

/**
 * Why a contact spec's key is in `score.completeness.missing` (#1023, D2). A
 * spec only fires once its check has already failed in `score.ts`; the only
 * way a NON-empty value still failed there is a confidence floor or (phone
 * only) a validity check — both already visible on `parsed` — so telling the
 * three reasons apart needs no score-object change.
 *
 * The validity check is gated on `phoneConfidence` clearing the same floor
 * `score.ts` gates presence on: `phoneIsValid` is computed independently of
 * confidence (`extract/contact.ts`), so a garbled, low-confidence phone can
 * be BOTH low-confidence and libphonenumber-invalid at once. `score.ts` only
 * ever reaches its own validity check once the field is already `present`
 * (confidence cleared) — so without this gate, a phone that failed on
 * confidence would get "check the number" copy for a reason `score.ts`
 * never actually evaluated. `phoneConfidence` is `undefined` when the caller
 * has no confidence data at all — that is not "below floor", so this
 * defaults to the invalid branch and preserves prior behaviour.
 */
function contactFieldReason(
  spec: ContactSpec,
  parsed: ResumeStructureInput,
): ContactReason {
  const value = contactFieldValue(spec.fieldName, parsed)?.trim();
  if (!value) return "absent";
  const belowConfidenceFloor =
    parsed.phoneConfidence !== undefined &&
    parsed.phoneConfidence < CONTACT_DISPLAY_CONFIDENCE_FLOOR;
  if (spec.fieldName === "phone" && !belowConfidenceFloor && parsed.phoneIsValid === false) {
    return "invalid";
  }
  return "low_confidence";
}

function contactCompletenessItem(
  spec: ContactSpec,
  parsed: ResumeStructureInput,
): GuidanceItem {
  const reason = contactFieldReason(spec, parsed);
  const issue =
    reason === "absent"
      ? { title: spec.title, suggestion: spec.suggestion, summary: spec.summary }
      : reason === "invalid"
        ? {
            title: "Phone number may not be valid",
            suggestion: "Check the number — it does not read as a valid phone number.",
            summary: "Check your phone number",
          }
        : {
            title: `${spec.fieldLabel} is hard to read`,
            suggestion: "Put it on its own line as plain text so it reads cleanly.",
            summary: `Make your ${spec.fieldLabel.toLowerCase()} easier to read`,
          };
  return {
    id: spec.id,
    dimension: "completeness",
    dimensions: ["completeness"],
    location: spec.location,
    targetAnchor: spec.targetAnchor,
    targetType: "contact_field",
    fieldName: spec.fieldName,
    issues: [{ dimension: "completeness", title: issue.title, suggestion: issue.suggestion }],
    summary: issue.summary,
  };
}

function contactCompletenessItems(
  missing: ReadonlySet<string>,
  parsed: ResumeStructureInput,
): GuidanceItem[] {
  return CONTACT_COMPLETENESS.filter((spec) => missing.has(spec.missingKey)).map(
    (spec) => contactCompletenessItem(spec, parsed),
  );
}

/** The Summary gap (#1023, D3) — branches on whether a (too-short) summary is
 *  already present, so a résumé with a brief summary is told to expand it
 *  rather than told to add one it already has. */
function summaryCompletenessItem(
  missing: ReadonlySet<string>,
  parsed: ResumeStructureInput,
): GuidanceItem | null {
  if (!missing.has("summary")) return null;
  const issue = parsed.summary?.trim()
    ? {
        title: "Summary is brief",
        suggestion:
          "Expand your summary to 2–3 sentences covering your core strengths and domain.",
        summary: "Expand your summary",
      }
    : {
        title: "Summary missing or brief",
        suggestion:
          "Add a 2–3 sentence professional summary highlighting your core strengths and domain.",
        summary: "Add a professional summary",
      };
  return {
    id: "completeness-summary",
    dimension: "completeness",
    dimensions: ["completeness"],
    location: "Summary",
    targetAnchor: SECTION_IDS.summary,
    targetType: "section",
    fieldName: "summary",
    issues: [{ dimension: "completeness", title: issue.title, suggestion: issue.suggestion }],
    summary: issue.summary,
  };
}

/** The Experience-level gap: no experience at all outranks missing role dates. */
function experienceCompletenessItem(
  score: AnonymousAtsScore,
  missing: ReadonlySet<string>,
): GuidanceItem | null {
  if (missing.has(EXPERIENCE_MISSING_LABEL)) {
    return completenessItem({
      missingKey: EXPERIENCE_MISSING_LABEL,
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

type FlaggedIssue = Exclude<BulletFinding["issue"], "ok">;

/**
 * How each critique category reads in Fix It. Titled apart from the heuristic
 * checks ("Local AI:") so the dock never presents a model's opinion as one of
 * the score's own checks; `vague` has no heuristic equivalent at all.
 * `duplicates` names the heuristic check a suggestion-less finding would only
 * repeat — see `critiqueIssue`.
 */
const CRITIQUE_ISSUE: Record<
  FlaggedIssue,
  {
    dimension: GuidanceDimension;
    title: string;
    fallback: string;
    duplicates?: BulletCheck;
  }
> = {
  no_quantification: {
    dimension: "specificity",
    title: "Local AI: no measurable result",
    fallback: "Add a number, scale, or outcome that is true for this work.",
    duplicates: "metric",
  },
  weak_verb: {
    dimension: "structure",
    title: "Local AI: weak opening verb",
    fallback: "Lead with a stronger action verb (e.g. 'Shipped', 'Built', 'Led').",
    duplicates: "verb",
  },
  vague: {
    dimension: "specificity",
    title: "Local AI: vague wording",
    fallback: "Make it specific: name the system, the scope, or the result.",
  },
};

/**
 * The Fix It issue for one matched critique finding, or null when it adds
 * nothing: an `ok` finding, or one with no suggestion that only restates a
 * heuristic check this bullet already fails. The finding stays listed in
 * `CritiqueResults` either way. A model suggestion can carry a figure the
 * user never wrote, so it is offered as wording, with the caveat, never as
 * the fix.
 */
function critiqueIssue(
  finding: BulletFinding | undefined,
  heuristic: readonly GuidanceIssue[],
): GuidanceIssue | null {
  if (!finding || finding.issue === "ok") return null;
  const spec = CRITIQUE_ISSUE[finding.issue];
  const suggestion = finding.suggestion?.trim();
  if (!suggestion && heuristic.some((i) => i.check === spec.duplicates)) {
    return null;
  }
  return {
    dimension: spec.dimension,
    check: "critique",
    title: spec.title,
    suggestion: suggestion
      ? `Suggested rewrite: "${suggestion}" Keep only details that are true.`
      : spec.fallback,
  };
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
 *
 * Each run's `section` label is resolved through the SAME
 * `computeExperienceHeadings` rule `ExperienceSection` renders headings with
 * (#1023) — not a hardcoded "Experience" — so a role under a second
 * `section_label` group (e.g. "Leadership Experience") reports that heading
 * rather than the generic one. The unmatched tail run (`groups.other`) has no
 * label of its own; per that rule it takes the section's top heading, not
 * whichever sub-heading happened to be active last.
 *
 * Returns `topHeading` alongside the runs — not just `runs[0]?.section` —
 * because it stays well-defined (falling back to `"Experience"`) even when
 * `combined` is empty, e.g. an Experience section with no bullets at all,
 * which is exactly the shape `bulletsBelowFloorItem` needs its location for.
 */
function editableBulletRuns(
  score: AnonymousAtsScore,
  parsed: ResumeStructureInput,
): { runs: BulletRun[]; topHeading: string } {
  const groups = buildEntryGroups(
    parsed.experience ?? [],
    parsed.projects ?? [],
    parsed.heuristic_achievements ?? [],
    parsed.heuristic_certifications ?? [],
    score.bullets ?? [],
  );
  const combined = groups.other
    ? [...groups.experienceGroups, groups.other]
    : groups.experienceGroups;
  const { topHeading, inlineHeadings } = computeExperienceHeadings(
    combined,
    parsed.experience?.map((e) => e.section_label),
    undefined,
  );
  let activeHeading = topHeading;
  const runs = combined.map((group, i) => {
    if (group.experienceIndex === null) return { section: topHeading, group };
    const inline = inlineHeadings[i];
    if (inline) activeHeading = inline;
    return { section: activeHeading, group };
  });
  return { runs, topHeading };
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
 * order. Only meaningful when `score.specificity.gradable` — below the
 * grading floor `bulletGuidanceItems` never consults it (#1023, D0): see
 * {@link bulletsBelowFloorItem}.
 */
function metricBudget(score: AnonymousAtsScore): number {
  const { metricBullets, totalBullets } = score.specificity;
  return metricBulletsToFullSpecificity(metricBullets, totalBullets);
}

/**
 * One item per bullet with at least one issue, in run order. `budget` is
 * shared across calls so the metric shortfall is spent in document order.
 * `critique` is the matched critique finding per bullet id — a critique issue
 * trails the bullet's heuristic ones, and can be its only one.
 *
 * `gradable` gates the heuristic (metric/verb/length) checks only (#1023,
 * D0) — below the grading floor those checks can't move a score that is
 * pinned at 0 regardless of what the bullets say, so `bulletsBelowFloorItem`
 * stands in for all of them with one step. Critique issues are NOT gated:
 * they never move the score by design (#1008), so the "can't move the score"
 * argument doesn't apply to them, and a bullet whose only issue is a critique
 * finding still gets its own step.
 */
function bulletGuidanceItems(
  runs: readonly BulletRun[],
  budget: { metric: number },
  critique: ReadonlyMap<string, BulletFinding>,
  gradable: boolean,
): GuidanceItem[] {
  const items: GuidanceItem[] = [];
  for (const { section, group } of runs) {
    const role = roleLabel(group.experience);
    group.bullets.forEach((b: BulletObservation, bIndex: number) => {
      let issues: GuidanceIssue[] = [];
      if (gradable) {
        const flagMetric = !b.hasMetric && budget.metric > 0;
        if (flagMetric) budget.metric--;
        issues = bulletIssues(b, flagMetric);
      }
      const fromCritique = critiqueIssue(critique.get(b.id), issues);
      if (fromCritique) issues.push(fromCritique);
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

/** `bulletsBelowFloorItem`'s id — exported so a caller (`ResumeTargeting`) can
 *  pick this one specific item out of `computeScoreGuidance`'s output without
 *  re-matching on a string literal it does not own. */
export const BULLETS_BELOW_FLOOR_ID = "bullets-below-grading-floor";

/**
 * The single step that replaces every per-bullet heuristic step below the
 * grading floor (#1023, D0). `score.specificity.gradable` (shared by
 * `structure`) is false below `ANON_MIN_BULLETS_TO_GRADE` bullets, and both
 * dimensions score 0 there regardless of wording — so working through
 * "add a metric" / "use an action verb" steps and watching the score stay at
 * 0 is exactly the wrong-advice failure this epic exists to remove. One
 * step asking for more bullets is the only one that can actually move the
 * number; once the third bullet lands, guidance recomputes and the
 * metric/verb/length steps appear on their own.
 *
 * Suppressed entirely when the résumé has no experience at all — matched by
 * the same `missing.has("work experience")` predicate that gates
 * `experienceCompletenessItem`'s own "work experience" item, not by that
 * item's id: stacking this on top of it would be the same double-advice
 * defect this issue exists to fix.
 *
 * `heading` is the section's own top heading, resolved by the caller through
 * the same `computeExperienceHeadings` rule `editableBulletRuns` uses — not a
 * hardcoded "Experience" — so a résumé whose Experience section is titled
 * e.g. "Career History", or split into label groups, breadcrumbs correctly.
 */
function bulletsBelowFloorItem(
  score: AnonymousAtsScore,
  missing: ReadonlySet<string>,
  heading: string,
): GuidanceItem | null {
  if (score.specificity.gradable) return null;
  if (missing.has("work experience")) return null;
  const needed = ANON_MIN_BULLETS_TO_GRADE - score.specificity.totalBullets;
  const s = needed === 1 ? "" : "s";
  return {
    id: BULLETS_BELOW_FLOOR_ID,
    dimension: "specificity",
    dimensions: ["specificity", "structure"],
    location: heading,
    targetAnchor: SECTION_IDS.experience,
    targetType: "section",
    issues: [
      {
        dimension: "specificity",
        title: "Too few bullets to grade wording",
        suggestion: `Add at least ${needed} more bullet${s} to your experience, projects, or achievements. Wording checks start at ${ANON_MIN_BULLETS_TO_GRADE} bullets.`,
      },
    ],
    summary: `Add ${needed} more bullet${s}`,
  };
}

/**
 * Derive deterministic, actionable guidance items from the anonymous ATS score and resume structure.
 * Items follow the rendered document: Contact → Summary → (bullets-below-floor,
 * when it applies) → Experience (the role-dates item in front of the role it
 * lands on, then the section's unmatched bullets) → Education → Skills.
 * Bullets outside Experience are not stepped through — see
 * `editableBulletRuns`.
 *
 * A scanned layout returns `[]` (#1023, D1): `recommendation.ts` already
 * treats scanned as a hard blocker ("nothing else matters until the text is
 * selectable"), and completeness.missing holds nearly every label on an
 * image-only PDF, so without this gate Fix It would offer "add" steps for
 * content that is already on the page.
 *
 * `critiqueFindings` — the on-device critique's per-bullet findings, when the
 * user has run it (#1008) — are matched to the SAME editable bullets by text
 * (`matchCritiqueFindings`), so a matched finding lands on the bullet's own
 * step and marker and a read-only row never gains one. Findings are not
 * budgeted: they do not move the score, and one leaves Fix It the moment its
 * bullet is edited or removed.
 */
export function computeScoreGuidance(
  score: AnonymousAtsScore,
  parsed: ResumeStructureInput,
  critiqueFindings: readonly BulletFinding[] = [],
): GuidanceItem[] {
  if (score.layout.scanned) return [];
  const missing = new Set(score.completeness.missing);
  const experienceItem = experienceCompletenessItem(score, missing);
  const { runs, topHeading } = editableBulletRuns(score, parsed);
  // "No experience at all" sits at the section's top; missing dates sit in
  // front of the first undated role.
  const split =
    experienceItem?.id === "completeness-role-dates"
      ? datesRunIndex(runs, parsed)
      : 0;
  const gradable = score.specificity.gradable;
  const budget = { metric: gradable ? metricBudget(score) : 0 };
  // Matched over every run at once, in render order, so the duplicate-text
  // pairing sees the whole section rather than one side of the dates split.
  const critique = matchCritiqueFindings(
    critiqueFindings,
    runs.flatMap((run) => run.group.bullets),
  );
  const before = bulletGuidanceItems(runs.slice(0, split), budget, critique, gradable);
  const from = bulletGuidanceItems(runs.slice(split), budget, critique, gradable);
  const summaryItem = summaryCompletenessItem(missing, parsed);
  const floorItem = bulletsBelowFloorItem(score, missing, topHeading);
  return [
    ...contactCompletenessItems(missing, parsed),
    ...(summaryItem ? [summaryItem] : []),
    ...(floorItem ? [floorItem] : []),
    ...before,
    ...(experienceItem ? [experienceItem] : []),
    ...from,
    ...completenessItems(TRAILING_COMPLETENESS, missing),
  ];
}
