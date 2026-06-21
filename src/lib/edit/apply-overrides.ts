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
} from "../../hooks/useEditableParse.ts";

/** Bullet overrides keyed by `BulletObservation.index` (stable rawText order). */
export type BulletOverrides = Record<number, string>;

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

/** The five editable contact keys, all string-valued on the parsed object. */
const CONTACT_KEYS: readonly (keyof ContactOverrides)[] = [
  "full_name",
  "email",
  "phone",
  "linkedin_url",
  "location",
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
 */
export function applyOverrides(
  parsed: HeuristicParsedResume,
  rawText: string,
  sections: SectionedResume,
  contact: ContactOverrides,
  experience: Record<number, ExperienceFieldOverrides>,
  bullets: BulletOverrides,
  observations: readonly BulletObservation[],
): ApplyOverridesResult {
  // Clone so the original parse is never mutated. experience entries are cloned
  // individually because we rewrite description strings on them.
  const nextParsed: HeuristicParsedResume = {
    ...parsed,
    experience: parsed.experience.map((e) => ({ ...e })),
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

  return { parsed: nextParsed, rawText: nextRawText, sections: nextSections };
}
