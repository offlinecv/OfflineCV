// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * group-bullets.ts — maps BulletObservation entries to parsed experience roles.
 *
 * The experience `description` field is assembled by `extractExperience` as:
 *   bodyLines.map(l => stripBullet(l.text)).join("\n").trim()
 * where `stripBullet` strips leading glyphs + whitespace but does NOT collapse
 * internal whitespace. `BulletObservation.text` is extracted from rawText and
 * also strips leading markers. Both sides therefore need normalization before
 * comparison (lowercasing + internal-whitespace collapse).
 */

import type { BulletObservation } from "./score.ts";
import { splitAchievementType } from "./entry-dates.ts";

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Leading bullet/numbered markers (mirrors BULLET_MARKER_RE + NUMBERED_BULLET_RE
 * in score.ts). The outer group repeats (`+`) so a line stacking two markers —
 * a glyph followed by a numbered prefix, e.g. `"• 1. Led team"` — strips BOTH in
 * one pass; a single `.replace` with a non-repeating group only strips the
 * first, which made `normalizeBulletText` non-idempotent and left such a line
 * unmatched against its once-stripped `BulletObservation.text` counterpart
 * (#999). Each marker must be followed by whitespace or end-of-line, not just
 * optional spaces — otherwise `\d+[.)]` matches the decimal point in a
 * numeric-content bullet like `"1.5M raised"` and corrupts its normalized key.
 * The trailing separator is `[ \t]+`, not `\s+` — a bare `\s+` lets a marker's
 * separator swallow a `\n` and chain into a marker on the NEXT line as if it
 * stacked with the first, over-stripping a multi-line string (e.g. a WebLLM
 * critique `bullet` field of `"1.\n• Led the effort"`) in one pass.
 */
const LEADING_MARKER_RE =
  /^(?:[\s ]*(?:[-*•●–▪◦‣▶►·�]|\d+[.)])(?:[ \t]+|$))+/;

/**
 * Normalize a bullet line for fuzzy matching: lowercase, strip any leading
 * bullet/numbered marker(s), collapse all internal whitespace to single
 * spaces, trim. Idempotent — `normalizeBulletText(normalizeBulletText(x)) ===
 * normalizeBulletText(x)` — because {@link LEADING_MARKER_RE} strips every
 * leading marker in one pass rather than just the first.
 */
export function normalizeBulletText(s: string): string {
  return s
    .replace(LEADING_MARKER_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ── Grading predicate ───────────────────────────────────────────────────────

/**
 * True when a bullet fails at least one of the three grading checks (no metric,
 * weak opening verb, or out-of-window length) and therefore warrants an inline
 * flag in the reconstructed-resume view. The complement (all three pass) renders
 * the bullet plain.
 *
 * This is library logic, not UI: it mirrors the same three checks
 * `scoreBulletPool` aggregates, exposed per-bullet for in-context display.
 */
export function needsAttention(b: BulletObservation): boolean {
  return !b.hasMetric || !b.startsWithActionVerb || !b.wellFormedLength;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Structural subset of ResumeExperience — only the fields we need for display
 * and matching. ResumeExperience[] assigns to BulletExperience[] directly.
 */
export interface BulletExperience {
  title?: string;
  company?: string;
  location?: string;
  /** Team / department / sub-org — the trailing "· Team" header segment. Carried
   *  for display + edit in the reconstructed résumé (renders in the Download PDF
   *  header via ats-resume-model, #425). Absent on projects/achievements. */
  team?: string;
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
  description?: string;
}

/** The project / achievement / certification shape {@link toBulletExperience} reads. */
export interface AccomplishmentEntry {
  title?: string;
  name?: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
}

/**
 * Coerce a list of parsed entries (experiences, projects, achievements) into
 * the `BulletExperience` shape: `name` falls back to `title`, and the date /
 * currency fields pass through verbatim. Shared by the reconstruction surface
 * and the ATS render-model builder so both derive the entry shape identically.
 *
 * An achievement's `type` label is deliberately NOT folded into the title here.
 * The title must stay the entry's CANONICAL text — the one thing a `type` edit
 * cannot change — because it is the ownership key {@link suppressTitleOwnedBullets}
 * matches against. Composing `type · title` instead would rebuild the key out of
 * a user-editable field, so retyping a "Patent" as a "Book" would move the key
 * off the raw PDF line it has to match and strand that line in "Other bullets"
 * (#456). The label tolerance lives on the bullet side instead, where the text is
 * immutable.
 */
export function toBulletExperience(
  entries: ReadonlyArray<AccomplishmentEntry>,
): BulletExperience[] {
  return entries.map((e) => ({
    title: e.title ?? e.name,
    description: e.description,
    start_date: e.start_date,
    end_date: e.end_date,
    is_current: e.is_current,
  }));
}

/** A group of flagged bullets under one parsed experience role (or "Other"). */
export interface BulletGroup {
  /** Index into the experiences array, or null for unmatched bullets. */
  experienceIndex: number | null;
  /** The experience entry, or null for the unmatched group. */
  experience: BulletExperience | null;
  bullets: BulletObservation[];
}

/**
 * Short "Title — Company" display label for a role, falling back to whichever
 * of the two is present, or "Untitled role" / "Other bullets" when neither is.
 * Shared by `ReconstructedResume` (role headings, whole-résumé rewrite section
 * labels) and the per-role `SectionRewrite` apply-confirmation copy (#508) —
 * one label format across every surface that names a role.
 */
export function roleLabel(exp: BulletGroup["experience"]): string {
  if (exp === null) return "Other bullets";
  const { title, company } = exp;
  if (title && company) return `${title} — ${company}`;
  if (title) return title;
  if (company) return company;
  return "Untitled role";
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Group `bullets` under the experience role whose description contains a line
 * matching the normalized bullet text.
 *
 * Build a Map<normalizedLine, experienceIndex> from description lines up front.
 * First-match tiebreak: when the same normalized line appears in two roles'
 * descriptions, the FIRST (lowest index) experience wins. We intentionally do
 * NOT overwrite an existing entry on collision — iterate experiences in order
 * and skip any line already mapped.
 *
 * Returns:
 *   - experience groups (in experience order, only those with ≥1 bullet)
 *   - a trailing "Other" group (experienceIndex null) only if ≥1 bullet unmatched
 * Relative bullet order is preserved within each group.
 */
export function groupBulletsByExperience(
  bullets: BulletObservation[],
  experiences: BulletExperience[],
): BulletGroup[] {
  // Build normalized-line → experience-index map (first-match tiebreak).
  const lineToExpIdx = new Map<string, number>();
  for (let i = 0; i < experiences.length; i++) {
    const desc = experiences[i].description;
    if (!desc) continue;
    for (const line of desc.split("\n")) {
      const key = normalizeBulletText(line);
      if (key && !lineToExpIdx.has(key)) {
        // First experience to claim this line wins — do not overwrite.
        lineToExpIdx.set(key, i);
      }
    }
  }

  // Assign each bullet to an experience index or null.
  const grouped = new Map<number | null, BulletObservation[]>();
  for (const bullet of bullets) {
    const key = normalizeBulletText(bullet.text);
    const expIdx = lineToExpIdx.get(key) ?? null;
    if (!grouped.has(expIdx)) grouped.set(expIdx, []);
    grouped.get(expIdx)!.push(bullet);
  }

  // Collect experience groups in experience order (only those with ≥1 bullet).
  const result: BulletGroup[] = [];
  for (let i = 0; i < experiences.length; i++) {
    const groupBullets = grouped.get(i);
    if (groupBullets && groupBullets.length > 0) {
      result.push({
        experienceIndex: i,
        experience: experiences[i],
        bullets: groupBullets,
      });
    }
  }

  // Append the unmatched "Other" group last, only if there are any.
  const other = grouped.get(null);
  if (other && other.length > 0) {
    result.push({ experienceIndex: null, experience: null, bullets: other });
  }

  return result;
}

// ── Title-owned bullet suppression (#224) ──────────────────────────────────────

/**
 * Normalize a title / bullet for OWNERSHIP comparison — stricter than
 * {@link normalizeBulletText}: on top of the marker-strip + lowercase + whitespace
 * collapse, it drops the bracket/date residue that makes a title-only entry's
 * header and its own pooled source line fail an exact match.
 *
 * The coupling this defuses (#224): a one-line achievement/project — the
 * `• Label · text [year]` or `Label, year` shape — parses as a TITLE-ONLY entry
 * (whole line in `title`, empty `description`) with the date peeled into a
 * separate field. The scorer still pools that raw line as a bullet. With no
 * `description` to key on, {@link groupBulletsByExperience} can't attribute the
 * bullet, so it lands in the "Other" group and the content renders twice — once
 * as the entry's title, once under "Other bullets". The title is date-stripped
 * (`… catalogs. []`) while the pooled bullet keeps its date (`… catalogs. [2019]`),
 * so the residue strip below is what lets the two reconcile.
 */
function normalizeTitleKey(s: string): string {
  return (
    normalizeBulletText(s)
      // Trailing "[2019]" / "[]" bracket residue (with or without a year inside).
      .replace(/\s*\[[^\]]*\]\s*$/, "")
      // Trailing bare year or ", 2021" / "· 2021" date suffix.
      .replace(/[\s,;·|–—-]*\b(?:19|20)\d{2}\b\s*$/, "")
      .replace(/[\s,;·|–—-]+$/, "")
      .trim()
  );
}

/**
 * The bullet key with a leading achievement-type run removed, or null when it
 * carries none.
 *
 * A pooled bullet is raw PDF text, so an achievement's line arrives COMPOSED
 * (`"Patent · Issued US10275736B1"`) while the parsed entry holds the two halves
 * apart — `type: "Patent"`, `title: "Issued US10275736B1"`. Ownership therefore
 * has to compare the bullet's post-label remainder against the bare title.
 *
 * This reuses the parser's own {@link splitAchievementType} rather than
 * re-deriving the split: it IS the inverse of the parse-time cut, so the two stay
 * in lockstep on the separator and the type-length bound. Rolling a second regex
 * here would let the two drift, which is exactly how the label run stopped
 * matching in the first place.
 */
function stripAchievementLabel(key: string): string | null {
  const split = splitAchievementType(key);
  const rest = split?.rest.trim();
  return rest ? rest : null;
}

/**
 * True when `key` (already in {@link normalizeTitleKey} form) names a line one
 * of `ownedKeys` owns — matching on EITHER the whole key or the key minus a
 * leading achievement type run (#456), the composed-vs-split reconciliation
 * described on {@link stripAchievementLabel}. The second candidate is additive:
 * it only ever matches more, and it is keyed on the entry's canonical `title`,
 * so editing an achievement's `type` cannot move the key off the raw line it has
 * to match.
 *
 * The ONE place the ownership relation is defined, shared by the two directions
 * that must agree on it: {@link suppressTitleOwnedBullets} hides a line the
 * entry owns, {@link isTitleOwnedLine} finds the same line so deleting the entry
 * can drop it (#856).
 */
function matchesOwnedKey(key: string, ownedKeys: ReadonlySet<string>): boolean {
  if (ownedKeys.has(key)) return true;
  const unlabelled = stripAchievementLabel(key);
  return unlabelled !== null && ownedKeys.has(unlabelled);
}

/**
 * Drop from a bullet list every bullet whose content is already OWNED by a
 * title-only entry — i.e. a `• Label … [year]` achievement/project that renders
 * its whole line as a header and carries no `description` for the grouper to
 * match against (#224). Such a bullet, left in the "Other bullets" group, shows
 * the same content twice. We suppress it from "Other" rather than re-attributing
 * it to the entry: the entry's own title already IS that content, so rendering it
 * again as the entry's bullet would just move the duplicate, not remove it.
 *
 * Ownership is exact on the residue-tolerant {@link normalizeTitleKey} — a tight
 * key, not substring containment — so a genuinely-unmatched bullet that merely
 * shares a prefix with some title is NOT suppressed. Only title-only entries
 * (empty description) are candidates; an entry with a real bullet body attributes
 * through the normal description path and never strands its bullets here.
 */
export function suppressTitleOwnedBullets(
  bullets: readonly BulletObservation[],
  entries: readonly BulletExperience[],
): BulletObservation[] {
  const ownedKeys = new Set<string>();
  for (const e of entries) {
    if (e.description?.trim()) continue; // not title-only
    const key = normalizeTitleKey(e.title ?? "");
    if (key) ownedKeys.add(key);
  }
  if (ownedKeys.size === 0) return [...bullets];
  return bullets.filter(
    (b) => !matchesOwnedKey(normalizeTitleKey(b.text), ownedKeys),
  );
}

/**
 * True when `line` is a source line the entry titled `title` OWNS — the exact
 * relation {@link suppressTitleOwnedBullets} hides a bullet on, exposed so the
 * INVERSE operation can reuse it: deleting a parsed entry (#856) has to drop the
 * entry's own line from `rawText` and from the graded section pool, and that line
 * is not otherwise identifiable (the parsed model keeps no source-line
 * provenance).
 *
 * Getting this from the suppressor rather than from a second matcher is what
 * makes the two agree by construction. It matters most for the case the
 * suppressor exists for: a title-only achievement/project is parsed OUT of a
 * `•`-marked line, so that line stays in the pool the anonymous scorer grades
 * even though nothing renders it — deleting the entry with a matcher that
 * disagreed here would leave its content grading the résumé forever.
 *
 * Exact-key, never containment, for the reason spelled out on the suppressor: a
 * different entry's line that merely shares a prefix is not owned.
 */
export function isTitleOwnedLine(
  line: string,
  title: string | undefined,
): boolean {
  const owned = normalizeTitleKey(title ?? "");
  if (!owned) return false;
  return matchesOwnedKey(normalizeTitleKey(line), new Set([owned]));
}

// ── Header formatting ─────────────────────────────────────────────────────────

/**
 * Format a parsed experience entry as a compact role header string.
 *
 * Pattern: `Title — Company · dates`
 * - ` — ` (space-em-dash-space) separates title from company when both present
 * - ` · ` precedes the date range when present
 * - Date range: `start–end` (en-dash), or `start–Present` when is_current, or just `start`
 *
 * Examples:
 *   full        → "Senior PM — Google · 2019–2023"
 *   no dates    → "Senior PM — Google"
 *   title only  → "Senior PM"
 *   company only → "Google"
 */
export function formatExperienceHeader(exp: BulletExperience): string {
  const parts: string[] = [];

  if (exp.title) parts.push(exp.title);

  if (exp.company) {
    if (parts.length > 0) {
      parts[0] = `${parts[0]} — ${exp.company}`;
    } else {
      parts.push(exp.company);
    }
  }

  const dateRange = buildDateRange(exp);
  if (dateRange) {
    if (parts.length > 0) {
      parts[0] = `${parts[0]} · ${dateRange}`;
    } else {
      parts.push(dateRange);
    }
  }

  return parts[0] ?? "";
}

function buildDateRange(exp: BulletExperience): string {
  const { start_date, end_date, is_current } = exp;
  if (!start_date && !end_date && !is_current) return "";
  if (start_date && (end_date || is_current)) {
    const end = is_current ? "Present" : end_date!;
    return `${start_date}–${end}`;
  }
  if (start_date) return start_date;
  if (is_current) return "Present";
  if (end_date) return end_date;
  return "";
}

// ── Section partition ─────────────────────────────────────────────────────────

/**
 * Group the bullet pool across experiences, projects AND achievements in one
 * pass, then partition the result so each section renders its own entries with
 * the SAME "every parsed entry renders, even with zero matched bullets"
 * guarantee, and the trailing "Other" group only holds bullets matched to none.
 *
 * Projects (#95), achievements (#96) and certifications (#884) are each mapped
 * onto the `BulletExperience` shape (`name`/`title → title`, `description`
 * verbatim) and concatenated after experiences, so a single
 * `groupBulletsByExperience` call attributes every bullet. Without this,
 * project/achievement bullets — which are not in any `experience.description` —
 * fall into the null "Other" group (the leak #95 fixed). The combined index
 * space is split back out by source length:
 * `[experiences | projects | achievements | certifications]`.
 *
 * Certifications sit LAST on purpose. Nothing in the graded pool comes from a
 * certifications section (it is not one of `ACCOMPLISHMENT_SECTION_NAMES`), so
 * the only bullets they can claim are ones a user ADDED to a certification —
 * and the grouper's first-match tiebreak means a trailing source can never take
 * a bullet away from an entry that legitimately owns it.
 *
 * We do NOT rely on groupBulletsByExperience's output alone: it omits entries
 * with no matched bullet, which would silently drop those roles/projects/items.
 *
 * Memoised on its last call. `/` runs it twice per re-grade over the same
 * arrays — Fix It's guidance (`computeScoreGuidance`) and the résumé render
 * (`ReconstructedResume`) — and both must see the same partition, so the second
 * call returns the first's result rather than re-running the matcher (#1004).
 * The inputs are compared by reference, which holds because both read the
 * override-folded `canonical.fields` and the re-graded score's `bullets`; an
 * empty array matches any empty array, since callers default a missing section
 * with a fresh `[]`. Callers must treat the result as read-only.
 */
export function buildEntryGroups(
  experiences: BulletExperience[],
  projects: ReadonlyArray<AccomplishmentEntry>,
  achievements: ReadonlyArray<AccomplishmentEntry>,
  certifications: ReadonlyArray<AccomplishmentEntry>,
  bullets: readonly BulletObservation[],
): EntryGroups {
  const args = [experiences, projects, achievements, certifications, bullets] as const;
  if (lastEntryGroups && args.every((a, i) => sameList(a, lastEntryGroups!.args[i]!))) {
    return lastEntryGroups.result;
  }
  const result = groupEntries(...args);
  lastEntryGroups = { args, result };
  return result;
}

/** The partition `buildEntryGroups` returns. */
export interface EntryGroups {
  experienceGroups: BulletGroup[];
  projectGroups: BulletGroup[];
  achievementGroups: BulletGroup[];
  certificationGroups: BulletGroup[];
  other: BulletGroup | null;
}

let lastEntryGroups: {
  args: readonly (readonly unknown[])[];
  result: EntryGroups;
} | null = null;

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a === b || (a.length === 0 && b.length === 0);
}

function groupEntries(
  experiences: BulletExperience[],
  projects: ReadonlyArray<AccomplishmentEntry>,
  achievements: ReadonlyArray<AccomplishmentEntry>,
  certifications: ReadonlyArray<AccomplishmentEntry>,
  bullets: readonly BulletObservation[],
): EntryGroups {
  const projectsAsExperience = toBulletExperience(projects);
  const achievementsAsExperience = toBulletExperience(achievements);
  const certificationsAsExperience = toBulletExperience(certifications);
  const combined = [
    ...experiences,
    ...projectsAsExperience,
    ...achievementsAsExperience,
    ...certificationsAsExperience,
  ];
  const grouped = groupBulletsByExperience([...bullets], combined);

  const byIndex = new Map<number, BulletGroup>();
  let other: BulletGroup | null = null;
  for (const g of grouped) {
    if (g.experienceIndex === null) other = g;
    else byIndex.set(g.experienceIndex, g);
  }

  // Suppress from "Other" any bullet already owned by a title-only entry — a
  // one-line achievement/project whose whole line renders as its header but
  // carries no description for the grouper to match (#224). Left in "Other" it
  // shows the same content twice. Drop the now-empty group entirely.
  if (other) {
    const kept = suppressTitleOwnedBullets(other.bullets, combined);
    other = kept.length > 0 ? { ...other, bullets: kept } : null;
  }

  // Each source slices its own window out of the combined index space, falling
  // back to an empty group so every parsed entry still renders.
  const sliceGroups = (
    source: BulletExperience[],
    offset: number,
  ): BulletGroup[] =>
    source.map((exp, i) => {
      const combinedIdx = offset + i;
      return (
        byIndex.get(combinedIdx) ?? {
          experienceIndex: combinedIdx,
          experience: exp,
          bullets: [],
        }
      );
    });

  const experienceGroups: BulletGroup[] = experiences.map((exp, i) => ({
    ...(byIndex.get(i) ?? { experienceIndex: i, experience: exp, bullets: [] }),
    experienceIndex: i,
  }));
  const projectGroups = sliceGroups(projectsAsExperience, experiences.length);
  const achievementGroups = sliceGroups(
    achievementsAsExperience,
    experiences.length + projects.length,
  );
  const certificationGroups = sliceGroups(
    certificationsAsExperience,
    experiences.length + projects.length + achievements.length,
  );

  return {
    experienceGroups,
    projectGroups,
    achievementGroups,
    certificationGroups,
    other,
  };
}
