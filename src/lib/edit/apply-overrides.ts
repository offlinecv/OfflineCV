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
  const target = normalizeBulletText(originalText);
  if (!target) return rawText;

  const lines = rawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (normalizeBulletText(lines[i]) !== target) continue;
    // Preserve the leading marker + whitespace; swap only the body text.
    const marker = lines[i].match(LEADING_MARKER_RE)?.[0] ?? "";
    lines[i] = marker + editedText;
    return lines.join("\n");
  }
  return rawText;
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
  const target = normalizeBulletText(originalText);
  if (!target) return sections;

  for (const name of sections.accomplishmentSections) {
    const lines = sections.byName.get(name);
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      if (normalizeBulletText(lines[i]) !== target) continue;
      // First match wins — clone the map + this one section's array, swap the
      // line body while preserving its leading marker, and return a new view.
      const marker = lines[i].match(LEADING_MARKER_RE)?.[0] ?? "";
      const nextLines = lines.slice();
      nextLines[i] = marker + editedText;
      const nextByName = new Map<SectionName | "profile", readonly string[]>(
        sections.byName,
      );
      nextByName.set(name, nextLines);
      return { ...sections, byName: nextByName };
    }
  }
  return sections;
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
  const target = normalizeBulletText(originalText);
  if (!target) return;

  for (const exp of experience) {
    if (!exp.description) continue;
    const descLines = exp.description.split("\n");
    let changed = false;
    for (let i = 0; i < descLines.length; i++) {
      if (normalizeBulletText(descLines[i]) === target) {
        descLines[i] = editedText;
        changed = true;
        break;
      }
    }
    if (changed) {
      exp.description = descLines.join("\n");
      return; // first-match tiebreak: only the first role claims this line
    }
  }
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
  const target = normalizeBulletText(originalText);
  if (!target) return rawText;
  const lines = rawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (normalizeBulletText(lines[i]) !== target) continue;
    lines.splice(i, 1);
    return lines.join("\n");
  }
  return rawText;
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
  const target = normalizeBulletText(originalText);
  if (!target) return sections;
  for (const name of sections.accomplishmentSections) {
    const lines = sections.byName.get(name);
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      if (normalizeBulletText(lines[i]) !== target) continue;
      const nextLines = lines.slice();
      nextLines.splice(i, 1);
      const nextByName = new Map<SectionName | "profile", readonly string[]>(
        sections.byName,
      );
      nextByName.set(name, nextLines);
      return { ...sections, byName: nextByName };
    }
  }
  return sections;
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
  const target = normalizeBulletText(originalText);
  if (!target) return;
  for (const exp of experience) {
    if (!exp.description) continue;
    const descLines = exp.description.split("\n");
    for (let i = 0; i < descLines.length; i++) {
      if (normalizeBulletText(descLines[i]) === target) {
        descLines.splice(i, 1);
        exp.description = descLines.join("\n");
        return; // first-match tiebreak
      }
    }
  }
}

/** Leading bullet/numbered markers — mirrors group-bullets.ts LEADING_MARKER_RE. */
const LEADING_MARKER_RE = /^[\s ]*(?:[-*•●–▪◦‣▶►·�]|\d+[.)]) */;

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
  let nextRawText = rawText;
  let nextSections = sections;

  // ── Contact fields ──────────────────────────────────────────────────────
  for (const key of CONTACT_KEYS) {
    const ov = contact[key];
    if (ov === undefined) continue;
    // Empty string = "user cleared it" → drop the field so Completeness counts
    // it as absent (mirrors ContactCard's display behaviour).
    if (ov === "") {
      delete nextParsed[key];
    } else {
      nextParsed[key] = ov;
    }
    // The original `phoneIsValid` flag is now stale — it described the parsed
    // phone, not the user-supplied one. Drop it so the scorer re-grades the
    // edited number as validity-unknown (backward-compatible full credit)
    // instead of carrying the old false → permanent half credit. (#70 review)
    if (key === "phone") delete nextParsed.phoneIsValid;
  }

  // ── Experience headers ──────────────────────────────────────────────────
  for (const [idxStr, fields] of Object.entries(experience)) {
    const idx = Number(idxStr);
    const exp = nextParsed.experience[idx];
    if (!exp) continue;
    if (fields.title !== undefined) exp.title = fields.title;
    if (fields.company !== undefined) exp.company = fields.company;
    if (fields.start_date !== undefined) exp.start_date = fields.start_date;
    if (fields.end_date !== undefined) exp.end_date = fields.end_date;
  }

  // ── Bullets — propagate to BOTH rawText and the matching description ──────
  const byIndex = new Map<number, BulletObservation>();
  for (const o of observations) byIndex.set(o.index, o);

  for (const [idxStr, editedRaw] of Object.entries(bullets)) {
    const idx = Number(idxStr);
    const obs = byIndex.get(idx);
    if (!obs) continue;
    const edited = editedRaw.trim();
    // No-op when the edit equals the original (nothing to re-grade).
    if (edited === obs.text) continue;
    // An empty edit is a no-op: we don't drop a bullet (that would silently
    // change the bullet count); clearing the field reverts to the parsed text.
    if (edited === "") continue;
    nextRawText = replaceBulletInRawText(nextRawText, obs.text, edited);
    nextSections = replaceBulletInSections(nextSections, obs.text, edited);
    replaceBulletInDescriptions(nextParsed.experience, obs.text, edited);
  }

  // ── Removed bullets — drop the line from the pool, rawText, description ────
  // Accepted "this bullet was removed" decisions from the rewrite review (#211).
  // Removal changes the bullet COUNT, so re-grading produces fresh
  // BulletObservation indices; that's fine because removals are applied as a
  // batch and the proposal is dismissed afterward (the override maps that key
  // by index are reconciled on the next render against the new observations).
  for (const idx of removedBullets) {
    const obs = byIndex.get(idx);
    if (!obs) continue;
    nextRawText = removeBulletFromRawText(nextRawText, obs.text);
    nextSections = removeBulletFromSections(nextSections, obs.text);
    removeBulletFromDescriptions(nextParsed.experience, obs.text);
  }

  // ── Education fields ──────────────────────────────────────────────────────
  // Mirror the experience-header fold: an empty string clears the field (the UI
  // renders "not detected" and the scorer/PDF read the blank). degree and
  // institution are required string fields on ResumeEducation, so a clear writes
  // "" rather than deleting the key.
  for (const [idxStr, fields] of Object.entries(education)) {
    const idx = Number(idxStr);
    const edu = nextParsed.education[idx];
    if (!edu) continue;
    if (fields.degree !== undefined) edu.degree = fields.degree;
    // `field` (major) is optional; a clear ("") drops it so render/PDF treat it
    // as absent rather than emitting an empty subject after the degree comma.
    if (fields.field !== undefined) edu.field = fields.field || undefined;
    if (fields.institution !== undefined) edu.institution = fields.institution;
    if (fields.start_date !== undefined) edu.start_date = fields.start_date;
    if (fields.end_date !== undefined) edu.end_date = fields.end_date;
  }

  // ── Skills (add / remove) ─────────────────────────────────────────────────
  // Final list = parsed skills minus `removed` (by lower-cased key), then
  // `added` appended, de-duplicated case-insensitively against the survivors.
  if (skills.removed.length > 0 || skills.added.length > 0) {
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

  // ── Added entries + bullets ────────────────────────────────────────────────
  // Append user-added entries to their section arrays and fold added bullet
  // lines into BOTH the entry description (display / PDF / grouping / fallback
  // grading) and the graded bullet pool (Specificity / Structure). Pool lines
  // land in the LAST accomplishment section so they sort after every existing
  // bullet — keeping prior BulletObservation indices (which bulletOverrides are
  // keyed by) stable.
  const hasAdds =
    addedEntries.length > 0 || Object.keys(addedBullets).length > 0;
  if (hasAdds) {
    // projects + heuristic_achievements weren't cloned above (only experience /
    // education / skills were). Clone them — and their entries — before we push
    // or mutate descriptions, so the original parse is never touched.
    nextParsed.projects = (nextParsed.projects ?? []).map((p) => ({ ...p }));
    nextParsed.heuristic_achievements = (
      nextParsed.heuristic_achievements ?? []
    ).map((a) => ({ ...a }));

    // "• "-prefixed copies of every added bullet, pooled for grading.
    const poolLines: string[] = [];

    // Added entries: build each from its header fields, with description from
    // its own added bullets (keyed by the entry id).
    for (const entry of addedEntries) {
      const entryBullets = addedBullets[entry.id] ?? [];
      const description = entryBullets.join("\n") || undefined;
      if (entry.section === "experience") {
        nextParsed.experience.push({
          title: entry.title,
          company: entry.subtitle ?? "",
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
        nextParsed.projects.push({ name: entry.title, description });
      } else {
        nextParsed.heuristic_achievements.push({
          title: entry.title,
          year: entry.year,
          description,
        });
      }
      for (const b of entryBullets) poolLines.push(`• ${b}`);
    }

    // Resolve a parsed-entry bullet key ("<section>:<index>") to the cloned
    // entry whose description carries the bullet. Added-entry keys ("added:<n>")
    // are handled above and skipped here. Education carries no bullets.
    const parsedDescTarget = (
      key: string,
    ): { description?: string } | undefined => {
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
    };

    // Added bullets on EXISTING parsed entries: append to that entry's
    // description (cloned) and to the pool.
    for (const [key, lines] of Object.entries(addedBullets)) {
      if (key.startsWith("added:")) continue; // added entries handled above
      if (lines.length === 0) continue;
      const target = parsedDescTarget(key);
      if (!target) continue;
      const existing = target.description ? [target.description] : [];
      target.description = [...existing, ...lines].join("\n");
      for (const b of lines) poolLines.push(`• ${b}`);
    }

    if (poolLines.length > 0) {
      const order = nextSections.accomplishmentSections;
      // Last accomplishment section in canonical order — its lines pool last, so
      // appended bullets get the highest indices. Fall back to "achievements".
      const tail: SectionName =
        order.length > 0 ? order[order.length - 1] : "achievements";
      const nextByName = new Map<
        SectionName | "profile",
        readonly string[]
      >(nextSections.byName);
      const existing = nextByName.get(tail) ?? [];
      nextByName.set(tail, [...existing, ...poolLines]);
      const accomplishmentSections = order.includes(tail)
        ? order
        : [...order, tail];
      nextSections = {
        ...nextSections,
        byName: nextByName,
        accomplishmentSections,
      };
    }
  }

  return { parsed: nextParsed, rawText: nextRawText, sections: nextSections };
}
