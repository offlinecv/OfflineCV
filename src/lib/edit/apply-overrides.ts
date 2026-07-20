// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * apply-overrides.ts — make in-memory edit overrides authoritative.
 *
 * The reconstructed-resume UI lets the user correct mis-parsed contact fields,
 * experience headers, and bullet text (#82). Those edits must feed the scorer
 * and the JD-coverage check, not just the display. This module folds the
 * override maps back into a fresh `{ parsed, rawText, sections }` triple that
 * the score and coverage functions re-grade from.
 *
 * The load-bearing fact (verified against score.ts + coverage.ts):
 *   - Specificity + Structure (and `score.bullets`) are pooled from the
 *     accomplishment sections of `input.sections` via
 *     `extractBulletsFromSections` (#133). The section rewrite below is what
 *     re-grades a live bullet edit; the parallel `rawText` rewrite is retained
 *     for any remaining rawText consumer (e.g. the redacted-date scan), it is
 *     no longer the bullet-pool source.
 *   - JD coverage + per-role flagged lists are built from
 *     `parsed.experience[].description` (+ skills/summary/education).
 * So a bullet edit has to land in the matching accomplishment section AND the
 * matching role's `description`, or the display would move while the score
 * stayed frozen — the exact bug #82 fixes. Contact + header edits only touch
 * `parsed` (Completeness + coverage read parsed directly).
 *
 * Pure and total: it clones the input, never mutates it, and an empty/missing
 * override is a no-op.
 */

import type {
  HeuristicParsedResume,
  FieldConfidence,
} from "../heuristics/types.ts";
import type { CanonicalResume } from "../heuristics/canonical.ts";
import { toCanonicalResume } from "../heuristics/canonical.ts";
import type { BulletObservation } from "../score/score.ts";
import type { HeuristicAchievement } from "../score/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import type { SectionName } from "../heuristics/regex.ts";
import { normalizeBulletText } from "../score/group-bullets.ts";
import { classifyProfile, profilesFromUrls } from "../contact/profile-registry.ts";
import type { LegacyLinkKey, ProfileLink } from "../score/types.ts";
import type {
  ContactOverrides,
  ExperienceFieldOverrides,
  EducationFieldOverrides,
  AchievementFieldOverrides,
  SkillsOverride,
  AddedEntry,
  AddedBullets,
  ProfileOverride,
  BulletOverrides,
  DescriptionOverrides,
} from "../../hooks/useEditableParse.ts";

/**
 * The edit result (#445, Stage D+E): the mutated {@link CanonicalResume} plus
 * the edited `rawText`. The pre-cutover four-field lockstep quadruple collapses
 * — `fields` / `sections` / `fieldConfidence` are simply the canonical model's
 * members (the same three that AC1 unified), so they can no longer drift out of
 * step. `rawText` is NOT a canonical member (it is cascade metadata); it rides
 * alongside because the scorer's redacted-date scan re-reads the edited text
 * (#133), and the section view still carries live bullet edits so the anonymous
 * scorer re-grades Specificity / Structure from the pooled bullets. The edited
 * `fieldConfidence` keeps score + contact-gap display in step with user-affirmed
 * contact edits (#421 Blocking #1 / #3).
 */
export type ApplyOverridesResult = CanonicalResume & { rawText: string };

/** A `{ rawText, sections }` pair — the two bullet-pool views that every
 *  bullet-line mutation (replace/remove) must keep in lockstep. */
interface BulletViews {
  rawText: string;
  sections: SectionedResume;
}

// ── Contact ────────────────────────────────────────────────────────────────

/** The editable non-link contact keys, all optional string-valued on the parsed
 *  object. Link fields moved to the consolidated `profileOverrides` channel
 *  (#427), applied by `applyProfileOverrides`. */
const CONTACT_KEYS: readonly (keyof ContactOverrides)[] = [
  "full_name",
  "email",
  "phone",
  "location",
];

/** Leading bullet/numbered markers — mirrors group-bullets.ts LEADING_MARKER_RE. */
const LEADING_MARKER_RE = /^[\s ]*(?:[-*•●–▪◦‣▶►·�]|\d+[.)]) */;

/**
 * Fold `contact` overrides into `nextParsed` in place. Empty string clears a
 * field (Completeness counts it as absent, mirroring ContactCard's display
 * behaviour); a phone edit also drops the now-stale `phoneIsValid` flag so the
 * scorer re-grades the edited number as validity-unknown rather than carrying
 * the old false → permanent half credit (#70 review).
 */
function applyContactOverrides(
  nextParsed: HeuristicParsedResume,
  contact: ContactOverrides,
): void {
  for (const key of CONTACT_KEYS) {
    const ov = contact[key];
    if (ov === undefined) continue;
    if (ov === "") {
      delete nextParsed[key];
    } else {
      nextParsed[key] = ov;
    }
    if (key === "phone") delete nextParsed.phoneIsValid;
  }
}

// ── Profile links (#335) ────────────────────────────────────────────────────

/** The network label (`classifyProfile`) → legacy `_url` slot a back-fill
 *  targets. Only the two links the scorer + contact-gap actually read
 *  (`linkedin_url`, `github_url`) map — portfolio/website have no single
 *  canonical network, and nothing downstream keys on them the way LinkedIn/
 *  GitHub feed the "Professional profile" gap. */
const NETWORK_TO_LEGACY_KEY: Readonly<Record<string, "linkedin_url" | "github_url">> = {
  LinkedIn: "linkedin_url",
  GitHub: "github_url",
};

/** The confidence a user-affirmed contact link earns; a cleared slot earns 0. */
export type LegacyConfEdit = { key: LegacyLinkKey; confidence: 0 | 1 };

/**
 * The legacy-link slice of a parsed resume that {@link applyProfileOverrides}
 * actually reads/writes — the four legacy `*_url` slots plus the `profiles[]`
 * mirror. Narrowed rather than the full `HeuristicParsedResume` so a caller can
 * probe "would this `profileOverrides` change move a legacy slot" against a
 * cheap 4-field object instead of paying for a full parsed-resume clone (#428
 * — the score memo split in `useAnalyzedResume`).
 */
export type LegacyLinkFields = Pick<
  HeuristicParsedResume,
  "linkedin_url" | "github_url" | "portfolio_url" | "website_url"
> & { profiles?: ProfileLink[] };

/**
 * Fold the ONE consolidated `profileOverrides` list (#427) back into
 * `nextParsed`: the four legacy `*_url` slots (the back-compat readers — scorer,
 * PDF render, JSON export) AND `nextParsed.profiles[]`.
 *
 * Two override kinds, per the #427 ruling:
 *   - CORRECTION (`legacyKey` set) — replaces that detected slot outright; an
 *     empty url clears it. This is a user-affirmed edit, so it forces the slot's
 *     confidence to 1 (or 0 on clear). Mirrors the old per-slot
 *     `contactOverrides.{...}_url` behavior.
 *   - EXTRA (`legacyKey` absent) — an added link with no legacy home. It
 *     back-fills an EMPTY linkedin/github slot (only when empty), matching the
 *     old `addedProfiles` behavior, and otherwise rides only in `profiles[]`.
 *
 * `profiles[]` is then re-derived from the (now-edited) four legacy slots in
 * precedence order plus the extras, classified + de-duped by slug — the mirror
 * every downstream reader consumes. Returns the per-slot confidence edits so the
 * caller can thread them into the edited `fieldConfidence`.
 *
 * Exported (#428) so a caller can run just this cheap step against a 4-field
 * {@link LegacyLinkFields} probe to answer "did this move a legacy slot"
 * without the full `applyOverrides` clone + regrade — the ONE place this logic
 * lives, so that answer never drifts from what a real override actually does.
 */
export function applyProfileOverrides(
  nextParsed: LegacyLinkFields,
  profileOverrides: readonly ProfileOverride[],
): LegacyConfEdit[] {
  const extras = profileOverrides.filter((p) => p.legacyKey === undefined);
  // Step order matters: corrections lead, extra back-fills follow, so a later
  // back-fill's confidence wins the dedup on a slot a correction just cleared.
  const confEdits = [
    ...applyLinkCorrections(nextParsed, profileOverrides),
    ...backfillLegacyFromExtras(nextParsed, extras),
  ];

  // Re-derive the profiles mirror from the edited legacy slots + extras.
  const profiles = profilesFromUrls([
    nextParsed.linkedin_url,
    nextParsed.github_url,
    nextParsed.portfolio_url,
    nextParsed.website_url,
    ...extras.map((p) => p.url),
  ]);
  // Absent when nothing is left, so an empty-override call stays a true no-op
  // (an `applyOverrides` invariant a test pins) and the parsed shape matches
  // extraction's "present only when ≥1 link" convention.
  if (profiles.length > 0) nextParsed.profiles = profiles;
  else delete nextParsed.profiles;

  return dedupeConfEdits(confEdits);
}

/** Corrections (`legacyKey` set) — replace/clear the targeted legacy slot,
 *  confidence → 1 (or 0 on clear). Mutates `nextParsed`. */
function applyLinkCorrections(
  nextParsed: LegacyLinkFields,
  profileOverrides: readonly ProfileOverride[],
): LegacyConfEdit[] {
  const confEdits: LegacyConfEdit[] = [];
  for (const ov of profileOverrides) {
    if (ov.legacyKey === undefined) continue;
    if (ov.url.trim() === "") {
      delete nextParsed[ov.legacyKey];
      confEdits.push({ key: ov.legacyKey, confidence: 0 });
    } else {
      // Store the classified (normalized) URL when parseable, else the raw edit
      // — mirrors the old per-slot override storing the user's value.
      nextParsed[ov.legacyKey] = classifyProfile(ov.url)?.url ?? ov.url;
      confEdits.push({ key: ov.legacyKey, confidence: 1 });
    }
  }
  return confEdits;
}

/** Extras (no `legacyKey`) — back-fill an EMPTY linkedin/github slot from a
 *  matching added link (only when empty), so the add moves the score + clears
 *  the gap. Mutates `nextParsed`. */
function backfillLegacyFromExtras(
  nextParsed: LegacyLinkFields,
  extras: readonly ProfileOverride[],
): LegacyConfEdit[] {
  const confEdits: LegacyConfEdit[] = [];
  for (const extra of extras) {
    const classified = classifyProfile(extra.url);
    if (!classified) continue;
    const legacyKey = NETWORK_TO_LEGACY_KEY[classified.network];
    if (legacyKey && !nextParsed[legacyKey]) {
      nextParsed[legacyKey] = classified.url;
      confEdits.push({ key: legacyKey, confidence: 1 });
    }
  }
  return confEdits;
}

/**
 * Collapse to one entry per legacy key, last-write-wins. A correction and an
 * extra back-fill can target the SAME slot — e.g. the user clears a detected
 * LinkedIn (correction → conf 0) then adds one via + Add (extra → conf 1).
 * Keeping both would let a downstream `.find(e => e.key === …)` read the stale
 * earlier confidence and treat a present link as absent; last-write-wins keeps
 * the confidence the slot actually ends up at (the extra's).
 */
function dedupeConfEdits(confEdits: readonly LegacyConfEdit[]): LegacyConfEdit[] {
  const byKey = new Map<LegacyLinkKey, LegacyConfEdit>();
  for (const edit of confEdits) byKey.set(edit.key, edit);
  return [...byKey.values()];
}

// ── Experience / education header fields ────────────────────────────────────

/** Fold `experience` header overrides (title/company/location/team/dates) into
 *  the cloned experience entries in place, keyed by array index. */
function applyExperienceHeaderOverrides(
  experience: HeuristicParsedResume["experience"],
  overrides: Record<number, ExperienceFieldOverrides>,
): void {
  for (const [idxStr, fields] of Object.entries(overrides)) {
    const idx = Number(idxStr);
    const exp = experience[idx];
    if (!exp) continue;
    if (fields.title !== undefined) exp.title = fields.title;
    if (fields.company !== undefined) exp.company = fields.company;
    // `location` is optional; a clear ("") drops it so render/PDF treat it as
    // absent rather than emitting an empty location segment.
    if (fields.location !== undefined) exp.location = fields.location || undefined;
    // `team` is optional too; mirror `location` — a clear ("") drops it so the
    // render/PDF header emits no trailing " · Team" segment.
    if (fields.team !== undefined) exp.team = fields.team || undefined;
    if (fields.start_date !== undefined) exp.start_date = fields.start_date;
    if (fields.end_date !== undefined) exp.end_date = fields.end_date;
  }
}

/** Fold `education` field overrides into the cloned education entries in
 *  place, keyed by array index. Mirrors the experience-header fold: an empty
 *  string clears the field (the UI renders "not detected" and the
 *  scorer/PDF read the blank). `degree` and `institution` are required
 *  string fields on ResumeEducation, so a clear writes "" rather than
 *  deleting the key. */
function applyEducationFieldOverrides(
  education: HeuristicParsedResume["education"],
  overrides: Record<number, EducationFieldOverrides>,
): void {
  for (const [idxStr, fields] of Object.entries(overrides)) {
    const idx = Number(idxStr);
    const edu = education[idx];
    if (!edu) continue;
    if (fields.degree !== undefined) edu.degree = fields.degree;
    // `field` (major) is optional; a clear ("") drops it so render/PDF treat it
    // as absent rather than emitting an empty subject after the degree comma.
    if (fields.field !== undefined) edu.field = fields.field || undefined;
    if (fields.institution !== undefined) edu.institution = fields.institution;
    if (fields.start_date !== undefined) edu.start_date = fields.start_date;
    if (fields.end_date !== undefined) edu.end_date = fields.end_date;
  }
}

// ── Achievements (#454) ─────────────────────────────────────────────────────

/**
 * Fold `achievements` field overrides into the parsed achievements, keyed by
 * array index. Each override key names a REAL field on `HeuristicAchievement`
 * (`type`, `title`, `year`) and is copied straight onto it (#456) — there is no
 * compose/decompose step, so an edit to one field can never perturb another.
 *
 * An empty `type` or `year` drops the key (mirroring the optional
 * `location`/`team` clears on experience); an empty `title` is kept verbatim,
 * since `title` is required and its empty string is the parser's own
 * no-usable-header value.
 *
 * `heuristic_achievements` is cloned here (the entry point pre-clones only
 * experience / education / skills). A later re-clone by
 * {@link applyAddedEntriesAndBullets} preserves these edits.
 *
 * Achievement overrides are keyed against the PARSED array, and added entries
 * are appended AFTER this runs, so the two index spaces never collide.
 */
function applyAchievementOverrides(
  nextParsed: HeuristicParsedResume,
  overrides: Record<number, AchievementFieldOverrides>,
): void {
  if (Object.keys(overrides).length === 0) return;
  const parsedAchievements = nextParsed.heuristic_achievements;
  if (!parsedAchievements || parsedAchievements.length === 0) return;

  const achievements = parsedAchievements.map((a) => ({ ...a }));
  for (const [idxStr, fields] of Object.entries(overrides)) {
    const ach = achievements[Number(idxStr)];
    if (!ach) continue;
    mergeAchievementFields(ach, fields);
  }
  nextParsed.heuristic_achievements = achievements;
}

/** Fold one achievement's field overrides into the (already cloned) entry. */
function mergeAchievementFields(
  ach: HeuristicAchievement,
  fields: AchievementFieldOverrides,
): void {
  if (fields.type !== undefined) ach.type = fields.type || undefined;
  if (fields.title !== undefined) ach.title = fields.title;
  if (fields.year !== undefined) ach.year = fields.year || undefined;
}

// ── Prose descriptions (#489) ───────────────────────────────────────────────

/**
 * Fold `descriptionOverrides` onto the matching parsed entries' prose
 * `description`, keyed by {@link parsedEntryKey} (`"<section>:<index>"`) and
 * resolved through the same {@link resolveParsedDescriptionTarget} the
 * added-bullet fold uses. This is the edit path for a prose-body entry (a
 * project whose blurb the parser stored as a paragraph, with no `•` bullets) —
 * the read-only branch #483 rendered now commits back here (#489).
 *
 * An empty string clears the description (treated as absent); a non-empty value
 * replaces it verbatim.
 *
 * `projects` / `heuristic_achievements` are NOT pre-cloned by the entry point
 * (it clones only experience / education / skills), so clone the arrays + their
 * entries here before mutating a description — mirroring
 * {@link applyAchievementOverrides}. `experience` entries are already cloned by
 * the entry point, so mutating one in place is safe. A later re-clone by
 * {@link applyAddedEntriesAndBullets} preserves these edits.
 */
function applyDescriptionOverrides(
  nextParsed: HeuristicParsedResume,
  overrides: DescriptionOverrides,
): void {
  if (Object.keys(overrides).length === 0) return;
  if (nextParsed.projects) {
    nextParsed.projects = nextParsed.projects.map((p) => ({ ...p }));
  }
  if (nextParsed.heuristic_achievements) {
    nextParsed.heuristic_achievements = nextParsed.heuristic_achievements.map(
      (a) => ({ ...a }),
    );
  }
  for (const [key, value] of Object.entries(overrides)) {
    const target = resolveParsedDescriptionTarget(nextParsed, key);
    if (!target) continue;
    target.description = value || undefined;
  }
}

// ── Skills (add / remove) ───────────────────────────────────────────────────

/**
 * Rebuild `nextParsed.skills` in place from add/remove edits: final list =
 * parsed skills minus `removed` (by lower-cased key), then `added` appended,
 * de-duplicated case-insensitively against the survivors.
 */
function applySkillOverrides(
  nextParsed: HeuristicParsedResume,
  skills: SkillsOverride,
): void {
  if (skills.removed.length === 0 && skills.added.length === 0) return;
  const removedSet = new Set(skills.removed.map((s) => s.toLowerCase()));
  const kept = nextParsed.skills.filter(
    (s) => !removedSet.has(s.toLowerCase()),
  );
  const present = new Set(kept.map((s) => s.toLowerCase()));
  for (const add of skills.added) {
    const key = add.toLowerCase();
    if (present.has(key)) continue;
    present.add(key);
    kept.push(add);
  }
  nextParsed.skills = kept;
}

// ── Shared "find first matching line, then mutate" primitives ──────────────
//
// Every bullet edit (replace or remove) needs to locate the first line whose
// normalised form equals the original bullet text, across one of three
// different line containers (rawText, an accomplishment section, a role's
// description) — then either swap or splice that one line. The three
// `withMatched*` helpers below own the shared "find + clone + mutate" shape;
// each pair of public replace/remove functions is a thin `mutate` callback
// over one of them. This collapses what were six near-identical bodies
// (previously duplicated clone groups flagged by fallow) into three shared
// traversals.

/** Index of the first line whose normalised form equals `target`, or -1. */
function findMatchingLineIndex(
  lines: readonly string[],
  target: string,
): number {
  for (let i = 0; i < lines.length; i++) {
    if (normalizeBulletText(lines[i]) === target) return i;
  }
  return -1;
}

/**
 * Split `rawText` into lines, find the first line matching `originalText`,
 * and let `mutate` rewrite the (mutable) lines array in place at that index
 * (replace the entry, or splice it out). Returns the rejoined text, or the
 * input unchanged when no line matches.
 */
function withMatchedRawTextLine(
  rawText: string,
  originalText: string,
  mutate: (lines: string[], idx: number) => void,
): string {
  const target = normalizeBulletText(originalText);
  if (!target) return rawText;
  const lines = rawText.split(/\r?\n/);
  const idx = findMatchingLineIndex(lines, target);
  if (idx < 0) return rawText;
  mutate(lines, idx);
  return lines.join("\n");
}

/**
 * Walk `sections.accomplishmentSections` in policy order, find the first
 * section whose lines contain a line matching `originalText`, and let
 * `mutate` rewrite a CLONED copy of that section's lines in place at the
 * matched index. Returns a NEW {@link SectionedResume} with a cloned
 * `byName` map (only the mutated section's array is cloned), or the input
 * unchanged when no line matches anywhere.
 */
function withMatchedSectionLine(
  sections: SectionedResume,
  originalText: string,
  mutate: (lines: string[], idx: number) => void,
): SectionedResume {
  const target = normalizeBulletText(originalText);
  if (!target) return sections;

  for (const name of sections.accomplishmentSections) {
    const lines = sections.byName.get(name);
    if (!lines) continue;
    const idx = findMatchingLineIndex(lines, target);
    if (idx < 0) continue;
    const nextLines = lines.slice();
    mutate(nextLines, idx);
    const nextByName = new Map<SectionName | "profile", readonly string[]>(
      sections.byName,
    );
    nextByName.set(name, nextLines);
    return { ...sections, byName: nextByName };
  }
  return sections;
}

/**
 * Walk `experience` in order, find the first role whose (newline-split)
 * `description` contains a line matching `originalText`, and let `mutate`
 * rewrite that role's description lines in place at the matched index —
 * mirroring `groupBulletsByExperience`'s first-match tiebreak so the bullet
 * lands in the same role the UI grouped it under. Mutates the role's
 * `description` directly (the caller already cloned the experience entries);
 * a no-op when no role matches.
 */
function withMatchedDescriptionLine(
  experience: HeuristicParsedResume["experience"],
  originalText: string,
  mutate: (lines: string[], idx: number) => void,
): void {
  const target = normalizeBulletText(originalText);
  if (!target) return;

  for (const exp of experience) {
    if (!exp.description) continue;
    const descLines = exp.description.split("\n");
    const idx = findMatchingLineIndex(descLines, target);
    if (idx < 0) continue;
    mutate(descLines, idx);
    exp.description = descLines.join("\n");
    return; // first-match tiebreak: only the first role claims this line
  }
}

// ── Bullet line replacement ──────────────────────────────────────────────────

/**
 * Replace the first rawText line whose stripped form equals `originalText`
 * (matched via `normalizeBulletText`, the same normaliser the grouping uses)
 * with `editedText`, preserving any leading bullet/numbered marker so the line
 * still extracts as a bullet. Returns the text unchanged if no line matches.
 */
function replaceBulletInRawText(
  rawText: string,
  originalText: string,
  editedText: string,
): string {
  return withMatchedRawTextLine(rawText, originalText, (lines, idx) => {
    const marker = lines[idx].match(LEADING_MARKER_RE)?.[0] ?? "";
    lines[idx] = marker + editedText;
  });
}

/**
 * Replace the first accomplishment-section line whose normalised form equals
 * `originalText` with `editedText`, preserving the leading marker, and return a
 * NEW {@link SectionedResume} with a cloned `byName` map (only the mutated
 * section's array is cloned; the input map and arrays are never mutated).
 * Returns the input unchanged when no line matches.
 *
 * This mirrors `replaceBulletInRawText`'s first-match, preserve-marker logic,
 * but walks the accomplishment sections in policy order so the live edit lands
 * in the exact pool the anonymous scorer grades from (#133).
 */
function replaceBulletInSections(
  sections: SectionedResume,
  originalText: string,
  editedText: string,
): SectionedResume {
  return withMatchedSectionLine(sections, originalText, (lines, idx) => {
    const marker = lines[idx].match(LEADING_MARKER_RE)?.[0] ?? "";
    lines[idx] = marker + editedText;
  });
}

/**
 * Replace the first description line (in any role) whose normalised form equals
 * `originalText` with `editedText`. Mutates the cloned experience entries in
 * place via the returned descriptions. Mirrors `groupBulletsByExperience`'s
 * first-match tiebreak so the bullet lands in the same role the UI grouped it
 * under.
 */
function replaceBulletInDescriptions(
  experience: HeuristicParsedResume["experience"],
  originalText: string,
  editedText: string,
): void {
  withMatchedDescriptionLine(experience, originalText, (lines, idx) => {
    lines[idx] = editedText;
  });
}

/**
 * Remove the first rawText line whose normalised form equals `originalText`.
 * Returns the text unchanged when no line matches. Mirrors
 * `replaceBulletInRawText`'s first-match contract, but drops the line entirely
 * (the rewrite-review "accept this removal" path, #211).
 */
function removeBulletFromRawText(
  rawText: string,
  originalText: string,
): string {
  return withMatchedRawTextLine(rawText, originalText, (lines, idx) => {
    lines.splice(idx, 1);
  });
}

/**
 * Remove the first accomplishment-section line whose normalised form equals
 * `originalText`, returning a NEW {@link SectionedResume} with only the mutated
 * section's array cloned. This is the pool the anonymous scorer grades from
 * (#133), so an accepted removal must drop the line here to move the score.
 */
function removeBulletFromSections(
  sections: SectionedResume,
  originalText: string,
): SectionedResume {
  return withMatchedSectionLine(sections, originalText, (lines, idx) => {
    lines.splice(idx, 1);
  });
}

/**
 * Remove the first description line (in any role) whose normalised form equals
 * `originalText`, mutating the cloned experience entries in place. Mirrors
 * `replaceBulletInDescriptions`' first-match tiebreak.
 */
function removeBulletFromDescriptions(
  experience: HeuristicParsedResume["experience"],
  originalText: string,
): void {
  withMatchedDescriptionLine(experience, originalText, (lines, idx) => {
    lines.splice(idx, 1);
  });
}

// ── Bullet override application ─────────────────────────────────────────────

/**
 * Fold `bullets` text edits into `views` (rawText + sections) and the
 * matching role's description, in that priority order — first-match wins per
 * container, same as the original inline loop. A no-op edit (equal to the
 * original, or empty) is skipped: an empty edit doesn't drop a bullet (that
 * would silently change the bullet count); clearing the field reverts to the
 * parsed text instead.
 */
function applyBulletTextOverrides(
  views: BulletViews,
  experience: HeuristicParsedResume["experience"],
  bullets: BulletOverrides,
  byIndex: ReadonlyMap<number, BulletObservation>,
): BulletViews {
  let { rawText, sections } = views;
  for (const [idxStr, editedRaw] of Object.entries(bullets)) {
    const idx = Number(idxStr);
    const obs = byIndex.get(idx);
    if (!obs) continue;
    const edited = editedRaw.trim();
    if (edited === obs.text) continue;
    if (edited === "") continue;
    rawText = replaceBulletInRawText(rawText, obs.text, edited);
    sections = replaceBulletInSections(sections, obs.text, edited);
    replaceBulletInDescriptions(experience, obs.text, edited);
  }
  return { rawText, sections };
}

/**
 * Fold `removedBullets` (accepted "this bullet was removed" decisions from
 * the rewrite review, #211) into `views` and the matching role's
 * description. Removal changes the bullet COUNT, so re-grading produces
 * fresh BulletObservation indices; that's fine because removals are applied
 * as a batch and the proposal is dismissed afterward (the override maps that
 * key by index are reconciled on the next render against the new
 * observations).
 */
function applyRemovedBulletOverrides(
  views: BulletViews,
  experience: HeuristicParsedResume["experience"],
  removedBullets: ReadonlySet<number>,
  byIndex: ReadonlyMap<number, BulletObservation>,
): BulletViews {
  let { rawText, sections } = views;
  for (const idx of removedBullets) {
    const obs = byIndex.get(idx);
    if (!obs) continue;
    rawText = removeBulletFromRawText(rawText, obs.text);
    sections = removeBulletFromSections(sections, obs.text);
    removeBulletFromDescriptions(experience, obs.text);
  }
  return { rawText, sections };
}

// ── Added entries + bullets ──────────────────────────────────────────────────

/** Resolve a parsed-entry bullet key ("<section>:<index>") to the cloned
 *  entry whose description carries the bullet. Added-entry keys
 *  ("added:<n>") are handled by the caller and skipped here. Education
 *  carries no bullets. */
function resolveParsedDescriptionTarget(
  nextParsed: HeuristicParsedResume,
  key: string,
): { description?: string } | undefined {
  const colon = key.indexOf(":");
  if (colon < 0) return undefined;
  const section = key.slice(0, colon);
  const index = Number(key.slice(colon + 1));
  if (!Number.isInteger(index)) return undefined;
  if (section === "experience") return nextParsed.experience[index];
  // `?.` (not `!`): a description/added-bullet override can outlive the section
  // array it was keyed against (a stale draft or handoff whose re-parse produced
  // no projects/achievements). Resolve to undefined so the caller's `if
  // (!target) continue` no-ops, rather than throwing on an absent array.
  if (section === "projects") return nextParsed.projects?.[index];
  if (section === "achievements")
    return nextParsed.heuristic_achievements?.[index];
  return undefined;
}

/** Append a single user-added entry to its target section array, with its
 *  description built from its own added bullets (keyed by the entry id).
 *  Returns the "• "-prefixed pool lines for the added bullets so the caller
 *  can fold them into the graded bullet pool. */
function pushAddedEntry(
  nextParsed: HeuristicParsedResume,
  entry: AddedEntry,
  addedBullets: AddedBullets,
): string[] {
  const entryBullets = addedBullets[entry.id] ?? [];
  const description = entryBullets.join("\n") || undefined;
  if (entry.section === "experience") {
    nextParsed.experience.push({
      title: entry.title,
      company: entry.subtitle ?? "",
      ...(entry.location ? { location: entry.location } : {}),
      ...(entry.team ? { team: entry.team } : {}),
      start_date: entry.start_date,
      end_date: entry.end_date,
      description,
    });
  } else if (entry.section === "education") {
    nextParsed.education.push({
      degree: entry.title,
      institution: entry.subtitle ?? "",
      start_date: entry.start_date,
      end_date: entry.end_date,
    });
  } else if (entry.section === "projects") {
    nextParsed.projects!.push({ name: entry.title, description });
  } else {
    // The added entry's flat header fields map straight onto the achievement's
    // real fields (#456) — `achievementType` is the bold label, `title` the rest
    // — so an added achievement is indistinguishable from a parsed-then-edited
    // one (#455) without any recomposition.
    nextParsed.heuristic_achievements!.push({
      type: entry.achievementType || undefined,
      title: entry.title,
      year: entry.year,
      description,
    });
  }
  return entryBullets.map((b) => `• ${b}`);
}

/** Append `poolLines` to the last accomplishment section (canonical order),
 *  so appended bullets sort after every existing bullet and keep prior
 *  `BulletObservation` indices (which bulletOverrides are keyed by) stable.
 *  Falls back to "achievements" when there is no existing accomplishment
 *  section. Returns a NEW {@link SectionedResume}; a no-op when there are no
 *  pool lines to add. */
function appendPoolLinesToSections(
  sections: SectionedResume,
  poolLines: readonly string[],
): SectionedResume {
  if (poolLines.length === 0) return sections;
  const order = sections.accomplishmentSections;
  const tail: SectionName =
    order.length > 0 ? order[order.length - 1] : "achievements";
  const nextByName = new Map<SectionName | "profile", readonly string[]>(
    sections.byName,
  );
  const existing = nextByName.get(tail) ?? [];
  nextByName.set(tail, [...existing, ...poolLines]);
  const accomplishmentSections = order.includes(tail)
    ? order
    : [...order, tail];
  return { ...sections, byName: nextByName, accomplishmentSections };
}

/**
 * Fold `addedEntries` (whole new experience/education/projects/achievements
 * rows) and `addedBullets` (bullet lines appended to a new or existing entry)
 * into `nextParsed` (mutated in place — projects/heuristic_achievements are
 * cloned here first since the entry point only pre-clones
 * experience/education/skills) and `sections`. Added bullet lines land in
 * BOTH the entry description (display / PDF / grouping / fallback grading)
 * and the graded bullet pool (Specificity / Structure). A no-op when there
 * are no additions.
 */
function applyAddedEntriesAndBullets(
  nextParsed: HeuristicParsedResume,
  sections: SectionedResume,
  addedEntries: readonly AddedEntry[],
  addedBullets: AddedBullets,
): SectionedResume {
  const hasAdds =
    addedEntries.length > 0 || Object.keys(addedBullets).length > 0;
  if (!hasAdds) return sections;

  // projects + heuristic_achievements weren't cloned by the entry point (only
  // experience / education / skills were). Clone them — and their entries —
  // before we push or mutate descriptions, so the original parse is never
  // touched.
  nextParsed.projects = (nextParsed.projects ?? []).map((p) => ({ ...p }));
  nextParsed.heuristic_achievements = (
    nextParsed.heuristic_achievements ?? []
  ).map((a) => ({ ...a }));

  // "• "-prefixed copies of every added bullet, pooled for grading.
  const poolLines: string[] = [];

  for (const entry of addedEntries) {
    poolLines.push(...pushAddedEntry(nextParsed, entry, addedBullets));
  }

  poolLines.push(...applyAddedBulletsToExistingEntries(nextParsed, addedBullets));

  return appendPoolLinesToSections(sections, poolLines);
}

/** Fold `addedBullets` keyed to EXISTING parsed entries into those entries'
 *  descriptions (cloned) and return the `"• "`-prefixed pool copies. Keys for
 *  added entries (`"added:"` prefix) are handled by {@link pushAddedEntry} and
 *  skipped here. */
function applyAddedBulletsToExistingEntries(
  nextParsed: HeuristicParsedResume,
  addedBullets: AddedBullets,
): string[] {
  const poolLines: string[] = [];
  for (const [key, lines] of Object.entries(addedBullets)) {
    if (key.startsWith("added:") || lines.length === 0) continue;
    const target = resolveParsedDescriptionTarget(nextParsed, key);
    if (!target) continue;
    const existing = target.description ? [target.description] : [];
    target.description = [...existing, ...lines].join("\n");
    for (const b of lines) poolLines.push(`• ${b}`);
  }
  return poolLines;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Fold the override maps into a fresh `{ parsed, rawText, sections }` triple.
 *
 * @param parsed    the cascade's parsed resume (NOT mutated — deep-ish cloned).
 * @param rawText   the cascade's raw extracted text (NOT mutated).
 * @param sections  the cascade's typed section view (NOT mutated — cloned only
 *                  where a bullet edit lands). The anonymous scorer pools its
 *                  bullet set from this (#133), so a live edit must be folded
 *                  here to re-grade Specificity / Structure.
 * @param contact   contact-field overrides (full_name/email/phone/linkedin/location).
 * @param experience experience-header overrides keyed by experience array index.
 * @param bullets   bullet-text overrides keyed by BulletObservation.index.
 * @param observations the `score.bullets` array — links a bullet override index
 *                  back to the original bullet text it should replace. Pass `[]`
 *                  when there are no bullet overrides.
 * @param education education-field overrides keyed by education array index
 *                  (degree/institution/start_date/end_date). Empty string clears
 *                  a field. Default `{}`.
 * @param skills    add/remove edits against `parsed.skills`. `removed` keys
 *                  (lower-cased) drop parsed skills; `added` are appended,
 *                  de-duplicated. Default `{ removed: [], added: [] }`.
 * @param addedEntries user-added entries appended to their section arrays
 *                  (experience/education/projects/achievements). Default `[]`.
 * @param addedBullets bullet lines a user appended to an entry, keyed by entry
 *                  key — `"<section>:<index>"` for a parsed entry or an added
 *                  entry's id. Folded into the entry description AND the graded
 *                  bullet pool so an addition moves Specificity / Structure.
 *                  Default `{}`.
 * @param removedBullets accepted "this bullet was removed" indices (#211).
 *                  Default empty set.
 * @param profileOverrides the ONE consolidated contact-link edit list (#427):
 *                  corrections to the four legacy slots (entries with a
 *                  `legacyKey`) AND user-added extras (untagged). Folded into the
 *                  legacy slots + `parsed.profiles`, and the per-slot confidence
 *                  edits are threaded into `fieldConfidence`. Default `[]`.
 * @param fieldConfidence the base per-field confidence. Returned bumped to 1
 *                  for every user-affirmed contact edit (and dropped to 0 for a
 *                  clear), so a typed-in / picker-added contact link scores +
 *                  displays as present rather than as low-confidence against the
 *                  frozen base parse (#421 Blocking #1 / #3). Default `{}`.
 * @param achievements achievement-field overrides keyed by
 *                  `heuristic_achievements` array index (#454). `type`, `title`
 *                  and `year` are copied straight onto the entry — `type` is a
 *                  stored field, not a run of `title`, so nothing is recomposed
 *                  (#456). An empty `type` or `year` clears it. Default `{}`.
 * @param descriptionOverrides prose-description overrides keyed by
 *                  {@link parsedEntryKey} (`"<section>:<index>"`, #489). Applied
 *                  straight onto the matching parsed entry's `description` — the
 *                  edit path for a prose-body project (no `•` bullets). An empty
 *                  string clears the description; a non-empty value replaces it.
 *                  Default `{}`.
 */
export function applyOverrides(
  parsed: HeuristicParsedResume,
  rawText: string,
  sections: SectionedResume,
  contact: ContactOverrides,
  experience: Record<number, ExperienceFieldOverrides>,
  bullets: BulletOverrides,
  observations: readonly BulletObservation[],
  education: Record<number, EducationFieldOverrides> = {},
  skills: SkillsOverride = { removed: [], added: [] },
  addedEntries: readonly AddedEntry[] = [],
  addedBullets: AddedBullets = {},
  removedBullets: ReadonlySet<number> = new Set(),
  profileOverrides: readonly ProfileOverride[] = [],
  fieldConfidence: FieldConfidence = {},
  achievements: Record<number, AchievementFieldOverrides> = {},
  descriptionOverrides: DescriptionOverrides = {},
): ApplyOverridesResult {
  // Clone so the original parse is never mutated. experience + education entries
  // are cloned individually because we rewrite fields on them; skills is cloned
  // because we rebuild the array from removed/added edits.
  const nextParsed: HeuristicParsedResume = {
    ...parsed,
    experience: parsed.experience.map((e) => ({ ...e })),
    education: parsed.education.map((e) => ({ ...e })),
    skills: [...parsed.skills],
  };

  applyContactOverrides(nextParsed, contact);
  // Fold the consolidated contact-link list (#427) into the legacy slots +
  // profiles mirror, returning the per-slot confidence edits (corrections → 1,
  // clears → 0, extra back-fills → 1) so the score + ContactCard read the edit.
  const linkConfEdits = applyProfileOverrides(nextParsed, profileOverrides);
  const nextConfidence = deriveEditedConfidence(
    fieldConfidence,
    contact,
    linkConfEdits,
  );
  applyExperienceHeaderOverrides(nextParsed.experience, experience);

  const byIndex = new Map<number, BulletObservation>();
  for (const o of observations) byIndex.set(o.index, o);

  let views: BulletViews = { rawText, sections };
  views = applyBulletTextOverrides(views, nextParsed.experience, bullets, byIndex);
  views = applyRemovedBulletOverrides(
    views,
    nextParsed.experience,
    removedBullets,
    byIndex,
  );

  applyEducationFieldOverrides(nextParsed.education, education);
  // Before the added-entry append below, so the override keys stay aligned with
  // the PARSED achievement indices they were captured against.
  applyAchievementOverrides(nextParsed, achievements);
  // Prose-body descriptions (#489). Runs before the added-entry append so its
  // clone-and-set stays aligned with the PARSED entry indices the override keys
  // were captured against; the later re-clone in applyAddedEntriesAndBullets
  // preserves these edits.
  applyDescriptionOverrides(nextParsed, descriptionOverrides);
  applySkillOverrides(nextParsed, skills);

  const nextSections = applyAddedEntriesAndBullets(
    nextParsed,
    views.sections,
    addedEntries,
    addedBullets,
  );

  return {
    ...toCanonicalResume(nextParsed, nextSections, nextConfidence),
    rawText: views.rawText,
  };
}

/**
 * Build the edited `fieldConfidence` from the base plus the user's contact
 * edits: a non-empty non-link contact override is user-affirmed → confidence 1;
 * an explicit clear ("") → 0 (absent). Contact-link confidence edits arrive
 * pre-resolved from `applyProfileOverrides` (correction → 1, clear → 0, extra
 * back-fill → 1). Untouched fields keep their base confidence. See {@link
 * ApplyOverridesResult.fieldConfidence}.
 */
function deriveEditedConfidence(
  base: FieldConfidence,
  contact: ContactOverrides,
  linkConfEdits: readonly LegacyConfEdit[],
): FieldConfidence {
  const next: FieldConfidence = { ...base };
  for (const key of CONTACT_KEYS) {
    const ov = contact[key];
    if (ov === undefined) continue;
    next[key] = ov === "" ? 0 : 1;
  }
  // Apply link edits in order so a later extra back-fill can't undo a correction
  // clear on the same slot (corrections are processed first in the list).
  for (const { key, confidence } of linkConfEdits) next[key] = confidence;
  return next;
}
