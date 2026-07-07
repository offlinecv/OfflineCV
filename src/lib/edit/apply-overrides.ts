// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { BulletObservation } from "../score/score.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import type { SectionName } from "../heuristics/regex.ts";
import { normalizeBulletText } from "../score/group-bullets.ts";
import type {
  ContactOverrides,
  ExperienceFieldOverrides,
  EducationFieldOverrides,
  SkillsOverride,
  AddedEntry,
  AddedBullets,
  BulletOverrides,
} from "../../hooks/useEditableParse.ts";

export interface ApplyOverridesResult {
  parsed: HeuristicParsedResume;
  rawText: string;
  /** The section view with any live bullet edits folded into the matching
   *  accomplishment-section line. This is what the anonymous scorer pools its
   *  bullet set from (#133), so a live edit must be reflected here to re-grade
   *  Specificity / Structure. */
  sections: SectionedResume;
}

/** A `{ rawText, sections }` pair — the two bullet-pool views that every
 *  bullet-line mutation (replace/remove) must keep in lockstep. */
interface BulletViews {
  rawText: string;
  sections: SectionedResume;
}

// ── Contact ────────────────────────────────────────────────────────────────

/** The editable contact keys, all optional string-valued on the parsed object.
 *  Link fields (github/portfolio/website) join the original five so a corrected
 *  URL re-grades Completeness + JD coverage like any other field. */
const CONTACT_KEYS: readonly (keyof ContactOverrides)[] = [
  "full_name",
  "email",
  "phone",
  "linkedin_url",
  "location",
  "github_url",
  "portfolio_url",
  "website_url",
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

// ── Experience / education header fields ────────────────────────────────────

/** Fold `experience` header overrides (title/company/location/dates) into the
 *  cloned experience entries in place, keyed by array index. */
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
  if (section === "projects") return nextParsed.projects![index];
  if (section === "achievements")
    return nextParsed.heuristic_achievements![index];
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
    nextParsed.heuristic_achievements!.push({
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
  applySkillOverrides(nextParsed, skills);

  const nextSections = applyAddedEntriesAndBullets(
    nextParsed,
    views.sections,
    addedEntries,
    addedBullets,
  );

  return { parsed: nextParsed, rawText: views.rawText, sections: nextSections };
}
