// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * guidance.ts — dimension score → concrete, located action (#810).
 *
 * The score already says WHICH dimension is low. `recommendation.ts` says what
 * to do about the single weakest one, in one résumé-global sentence. Neither
 * says WHERE: a user reading "add metrics to more bullets" still has to find
 * the bullets. This module closes that gap for all three gradable dimensions
 * at once, and it is deliberately the only new derivation — every signal it
 * reads is already on the score.
 *
 * Division of labour with {@link getScoreRecommendation} (`recommendation.ts`),
 * which this does NOT replace:
 *   - `recommendation.ts` is the verdict's one-line lead, beside the ring. It
 *     picks the weakest dimension and speaks about the résumé as a whole, and
 *     it owns the two branches this module has nothing to say about (a scanned
 *     PDF, and a layout penalty) because those are document-level faults with
 *     no bullet or field to point at.
 *   - This module is the itemised follow-through, rendered where the bullets
 *     are. It names a place per finding and never re-states the band.
 * Keeping the second one out of `recommendation.ts` is what stops two
 * deterministic answers to "what should I change about Specificity" from
 * drifting apart: that file answers it once, globally; this one answers it per
 * location, and neither restates the other's copy.
 *
 * DETERMINISTIC AND UNGATED, both load-bearing (#810):
 *   - Same inputs as `computeAnonymousAtsScore`, so one PDF always yields one
 *     set of advice. No LLM, no new parse, no second analysis pass.
 *   - Nothing here is behind WebGPU. That is a decision the tree has already
 *     made twice — the #544 skills-ordering finding was moved OUT of
 *     `CritiqueResults` (see `SkillsOrderFinding.tsx`, `CritiquePanel.tsx`)
 *     because advice a visitor can reach only by owning a WebGPU browser and
 *     opting into a model download is, to that visitor, indistinguishable from
 *     output they declined to run. The population that gets a bare number
 *     today is exactly the population without WebGPU.
 *
 * It reports ON the score and never feeds it: nothing here is an input to
 * `computeAnonymousAtsScore`, so `ATS_SCORE_ALGO_VERSION` is untouched by
 * anything in this file.
 */

import type { BulletObservation } from "./score.ts";
import { BULLET_LENGTH_MIN_WORDS, BULLET_LENGTH_MAX_WORDS } from "./score.ts";
import { roleLabel, type BulletGroup } from "./group-bullets.ts";
import type { ContactDisplayField } from "../contact.ts";

/** The three gradable dimensions guidance can speak to. Layout is absent on
 *  purpose — it is a multiplier, not a dimension, and `recommendation.ts`
 *  already names its triggers. */
export type GuidanceDimension = "specificity" | "structure" | "completeness";

/** One bullet, plus where in the résumé it lives. */
export interface LocatedBullet {
  bullet: BulletObservation;
  /** `"Experience → Staff Engineer — Acme → bullet 3"`. */
  path: string;
}

/** One actionable statement: a place, and what to change there. */
export interface ScoreGuidanceItem {
  dimension: GuidanceDimension;
  /** Where the change goes, in the user's own section/entry vocabulary. */
  where: string;
  /** What to change, as an imperative. Never names a vendor or an outcome. */
  action: string;
}

/** One résumé section's grouped bullets, as `ReconstructedResume` already
 *  resolves them through `buildEntryGroups`. */
export interface GuidanceSection {
  /** The section's own heading, as rendered ("Experience", "Projects", or
   *  whatever heading the source document used). */
  heading: string;
  groups: readonly BulletGroup[];
}

/**
 * Longest entry name carried in a path before it is elided.
 *
 * Deliberately the same 60 as `MAX_ENTRY_LABEL` in `lib/pdf/render-findings.ts`,
 * and the path format below (`Section → Entry → bullet N`) deliberately mirrors
 * that file's `entryPathLabel` / `→ bullet ${b + 1}`. The two are not shared
 * because they walk different models — `render-findings.ts` walks the EXPORT
 * model (`AtsResumeModel`) and states outright that its findings never reach
 * the scorer, while this walks the graded bullet pool — but a user reading a
 * score finding and an export finding about one role must see that role named
 * the same way, so the format is matched on purpose rather than by accident.
 */
const MAX_ENTRY_LABEL = 60;

function elide(text: string): string {
  return text.length <= MAX_ENTRY_LABEL
    ? text
    : `${text.slice(0, MAX_ENTRY_LABEL - 1).trimEnd()}…`;
}

/**
 * Flatten grouped sections into one located-bullet list, in document order.
 *
 * `roleLabel` supplies the entry name — the one role-naming format the tree
 * already shares between `ReconstructedResume`'s headings and the per-role
 * rewrite copy — so this does not mint a second way to say "which role". It
 * also answers `"Other bullets"` for the unmatched group, which is the honest
 * label: those bullets are real and gradable but the grouper could not attach
 * them to a parsed entry, and claiming a role for them would be worse than
 * naming the bucket.
 */
export function locateBullets(
  sections: readonly GuidanceSection[],
): LocatedBullet[] {
  const out: LocatedBullet[] = [];
  for (const section of sections) {
    const heading = section.heading.trim() || "Section";
    for (const group of section.groups) {
      const entry = elide(roleLabel(group.experience));
      group.bullets.forEach((bullet, i) => {
        out.push({ bullet, path: `${heading} → ${entry} → bullet ${i + 1}` });
      });
    }
  }
  return out;
}

/**
 * The length advice for one bullet, e.g. `"Too short — aim 8–30 words (5)"`.
 *
 * Exported so `ResumeBulletRow`'s inline length chip and this module's prose
 * cannot disagree about the window. The numbers interpolate from the scorer's
 * own constants rather than being written out, so widening the window in
 * `score.ts` cannot leave the advice quoting the old bounds.
 */
export function lengthAdvice(bullet: BulletObservation): string {
  const aim = `aim ${BULLET_LENGTH_MIN_WORDS}–${BULLET_LENGTH_MAX_WORDS} words`;
  return bullet.wordCount < BULLET_LENGTH_MIN_WORDS
    ? `Too short — ${aim} (${bullet.wordCount})`
    : `Too long — ${aim} (${bullet.wordCount})`;
}

/**
 * Non-contact completeness labels, keyed by the exact strings
 * `computeAnonymousAtsScore` pushes into `completeness.missing`.
 *
 * Keyed by label rather than by check key because the label is what the score
 * ships — `completenessMissing` maps the checks to `c.label` before it leaves
 * the scorer, so the key is not on the wire. A label renamed in `score.ts`
 * drops out of this map and simply yields no guidance row, which is the safe
 * direction: silence, never a stale instruction.
 *
 * The five CONTACT labels (`name`, `email`, `phone`, `location`, `LinkedIn`)
 * are absent on purpose — they come in through `contactMissing` instead, which
 * carries the same gaps with the display labels the contact card itself uses,
 * so the two surfaces cannot name one field differently.
 */
const COMPLETENESS_ADVICE: Record<string, { where: string; action: string }> = {
  summary: {
    where: "Summary",
    action: "add a short summary at the top so the résumé opens with your focus",
  },
  skills: {
    where: "Skills",
    action: "list at least three skills so the section reads as a list",
  },
  "work experience": {
    where: "Experience",
    action: "add at least one role, with what you did under it",
  },
  education: {
    where: "Education",
    action: "add your education entry",
  },
  "role dates": {
    where: "Experience → dates",
    action: "give each role a start date",
  },
};

/** Default cap per dimension. Three is enough to show the shape of the problem
 *  and to point at real places, without turning a weak résumé into a wall of
 *  text — the busy-page failure mode #680 is about. */
const DEFAULT_MAX_PER_DIMENSION = 3;

export interface ScoreGuidanceInput {
  /** Bullets with their résumé location, from {@link locateBullets}. */
  located: readonly LocatedBullet[];
  /** Missing contact fields, from `contactCompleteness(...).missing`. */
  contactMissing?: readonly ContactDisplayField[];
  /** `score.completeness` — the non-contact presence checks and the
   *  redacted-dates flag. Optional: without it, Completeness guidance is the
   *  contact gaps alone. */
  completeness?: {
    missing: readonly string[];
    redactedDates?: boolean;
  };
  /** Cap per dimension. Defaults to {@link DEFAULT_MAX_PER_DIMENSION}. */
  maxPerDimension?: number;
}

/** Specificity (0.4) — bullets carrying no quantified outcome. */
function specificityItems(
  located: readonly LocatedBullet[],
): ScoreGuidanceItem[] {
  return located
    .filter(({ bullet }) => !bullet.hasMetric)
    .map(({ path }) => ({
      dimension: "specificity" as const,
      where: path,
      action:
        "add a number — an amount, a percentage, or a count — so the result is measurable",
    }));
}

/**
 * Structure (0.3) — weak opening verb, then length.
 *
 * Both checks are half the dimension's credit and one bullet can fail both; it
 * earns a row per failing check, because they are two different edits. The two
 * kinds are concatenated rather than interleaved per bullet so a reader fixes
 * one kind of thing at a time.
 */
function structureItems(
  located: readonly LocatedBullet[],
): ScoreGuidanceItem[] {
  const weakVerb = located
    .filter(({ bullet }) => !bullet.startsWithActionVerb)
    .map(({ path }) => ({
      dimension: "structure" as const,
      where: path,
      action: "open with an action verb — lead with what you did",
    }));
  const badLength = located
    .filter(({ bullet }) => !bullet.wellFormedLength)
    .map(({ bullet, path }) => ({
      dimension: "structure" as const,
      where: path,
      // Lower-cased to sit in the same imperative register as the other
      // actions; the string carries no proper noun, so this is lossless.
      action: lengthAdvice(bullet).toLowerCase(),
    }));
  return [...weakVerb, ...badLength];
}

/** Completeness (0.3) — contact gaps, then the section presence checks. */
function completenessItems(
  contactMissing: readonly ContactDisplayField[],
  completeness: ScoreGuidanceInput["completeness"],
): ScoreGuidanceItem[] {
  const contact = contactMissing.map((field) => ({
    dimension: "completeness" as const,
    where: `Contact → ${field.label}`,
    action: "add it, as plain text on its own line",
  }));

  const redacted: ScoreGuidanceItem[] = completeness?.redactedDates
    ? [
        {
          dimension: "completeness",
          where: "Experience → dates",
          action: "use real 4-digit years — the dates currently read as stubs",
        },
      ]
    : [];

  const sections = (completeness?.missing ?? [])
    // The redacted-dates row is the more specific version of the same gap, so
    // the generic one is suppressed rather than listed beside it.
    .filter(
      (label) => !(label === "role dates" && completeness?.redactedDates),
    )
    .map((label) => COMPLETENESS_ADVICE[label])
    // A label renamed in `score.ts` falls out of the map and yields no row at
    // all — silence, never a stale instruction.
    .filter(
      (advice): advice is { where: string; action: string } =>
        advice !== undefined,
    )
    .map((advice) => ({
      dimension: "completeness" as const,
      where: advice.where,
      action: advice.action,
    }));

  return [...contact, ...redacted, ...sections];
}

/**
 * Build the located guidance list for a résumé.
 *
 * Returns `[]` when there is nothing to say, which is the contract the caller
 * needs in order to render no chrome at all rather than an empty container
 * (#810 acceptance). Order is document order within a dimension, and
 * Specificity → Structure → Completeness across them — the weight order the
 * score itself uses (0.4 / 0.3 / 0.3), so the first thing listed is the one
 * carrying the most points.
 *
 * The three dimensions are built by their own functions above rather than
 * inline here. That is not only tidiness: as one body this was 20 cyclomatic
 * / 21 cognitive, the highest in the module and higher than anything it sits
 * beside, and each dimension's rules are independent of the other two's.
 *
 * Copy discipline, applied to every string this returns: it says what to
 * change about the résumé, never what any applicant tracking system will do
 * with it (`docs/scoring.md`: "our own deterministic read … not a claim about
 * what any specific applicant tracking system does"), never a predicted
 * outcome, and never a remark about our own scoring.
 */
export function buildScoreGuidance(
  input: ScoreGuidanceInput,
): ScoreGuidanceItem[] {
  const max = input.maxPerDimension ?? DEFAULT_MAX_PER_DIMENSION;
  if (max <= 0) return [];

  // Each dimension is capped independently, so a résumé with many unquantified
  // bullets still gets to hear about its missing contact fields.
  return [
    ...specificityItems(input.located).slice(0, max),
    ...structureItems(input.located).slice(0, max),
    ...completenessItems(input.contactMissing ?? [], input.completeness).slice(
      0,
      max,
    ),
  ];
}
