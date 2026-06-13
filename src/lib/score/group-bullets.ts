// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

// ── Normalization ─────────────────────────────────────────────────────────────

/** Leading bullet/numbered markers (mirrors BULLET_MARKER_RE + NUMBERED_BULLET_RE in score.ts). */
const LEADING_MARKER_RE = /^[\s ]*(?:[-*•●–▪◦‣▶►·�]|\d+[.)]) */;

/**
 * Normalize a bullet line for fuzzy matching: lowercase, strip any leading
 * bullet/numbered marker, collapse all internal whitespace to single spaces,
 * trim.
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
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
  description?: string;
}

/** A group of flagged bullets under one parsed experience role (or "Other"). */
export interface BulletGroup {
  /** Index into the experiences array, or null for unmatched bullets. */
  experienceIndex: number | null;
  /** The experience entry, or null for the unmatched group. */
  experience: BulletExperience | null;
  bullets: BulletObservation[];
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
