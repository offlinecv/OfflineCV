// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Achievement type presets — the catalog behind the type picker (#456).
 *
 * {@link HeuristicAchievement.type} is FREE TEXT: the verbatim label a real
 * résumé happened to carry, lifted at parse (`splitAchievementType`). It cannot
 * be narrowed to an enum without losing every label a résumé actually used
 * ("Best Paper Award", "Keynote", …) — so these presets are SUGGESTIONS layered
 * over free text, not a closed set:
 *
 *   – the picker offers them as one-tap choices, and
 *   – any other string a user types (or the parser lifted) stays valid and
 *     round-trips untouched.
 *
 * Matching is therefore by LABEL, case-insensitively, and a miss is normal —
 * an unrecognized label simply has no emoji.
 *
 * The emoji is a UI affordance ONLY. It is never written into the exported PDF:
 * the export bolds the `type` label as text, and the parser reads text back, so
 * injecting a glyph would put a character in the résumé that no ATS asked for
 * and that re-parses as part of the label.
 */

export interface AchievementPreset {
  /** The label written to `HeuristicAchievement.type` when picked. */
  label: string;
  /** Displayed next to the label in the picker. UI-only — never exported. */
  emoji: string;
}

export const ACHIEVEMENT_PRESETS: readonly AchievementPreset[] = [
  { label: "Patent", emoji: "\u{1F4DC}" },
  { label: "Book", emoji: "\u{1F4D8}" },
  { label: "Publication", emoji: "\u{1F4C4}" },
  { label: "Founded", emoji: "\u{1F680}" },
  { label: "Exit", emoji: "\u{1F3C1}" },
  { label: "Acquired", emoji: "\u{1F91D}" },
  { label: "Award", emoji: "\u{1F3C6}" },
  { label: "Talk", emoji: "\u{1F3A4}" },
  { label: "Fellowship", emoji: "\u{1F393}" },
  { label: "Press", emoji: "\u{1F4F0}" },
  { label: "Open Source", emoji: "\u{1F9EA}" },
  { label: "Certification", emoji: "\u{1F4CB}" },
];

const BY_LABEL = new Map(
  ACHIEVEMENT_PRESETS.map((p) => [p.label.toLowerCase(), p]),
);

/**
 * The preset a free-text label corresponds to, or `undefined` when it matches
 * none — the expected case for a label the parser lifted verbatim from a PDF.
 */
export function matchAchievementPreset(
  type: string | undefined,
): AchievementPreset | undefined {
  const key = type?.trim().toLowerCase();
  return key ? BY_LABEL.get(key) : undefined;
}
