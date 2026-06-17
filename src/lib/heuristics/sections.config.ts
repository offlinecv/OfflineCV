// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Typed loader for section keyword configuration.
 *
 * The single source of truth for all section aliases, split-letter
 * normalisation allowlist, and future L2 anchor / anchor-fallback hints
 * is `sections.config.json`. This module imports that JSON, validates its
 * shape at module load time, and re-exports the structures that the rest
 * of the heuristic pipeline consumes — preserving the same public API
 * that `regex.ts` used to own.
 *
 * Consumers (sections.ts, markdown-lines.ts, extract-fields.ts) import
 * from `./regex.ts`, which re-exports from here, so their import paths
 * are unchanged.
 */

import rawConfig from "./sections.config.json";

// ── Canonical section name union ─────────────────────────────────────────────
//
// Defined explicitly rather than derived from the JSON import: JSON keys widen
// to `string`, losing the literal union that `SectionName` consumers rely on.

export type SectionName =
  | "summary"
  | "experience"
  | "education"
  | "skills"
  | "projects"
  | "certifications"
  | "achievements"
  | "other";

// ── Config shape ─────────────────────────────────────────────────────────────

interface SectionConfig {
  aliases: string[];
  anchors: string[];
  splitLetterNormalizable: boolean;
  anchorFallback: boolean;
}

// Drift guard: if the JSON ever gains or loses a key that doesn't match
// SectionName, this assignment fails the build immediately.
const _drift: Record<SectionName, SectionConfig> = rawConfig.sections;

// ── Validation ───────────────────────────────────────────────────────────────

function validate(cfg: Record<SectionName, SectionConfig>): void {
  for (const [name, section] of Object.entries(cfg) as Array<
    [SectionName, SectionConfig]
  >) {
    if (
      !Array.isArray(section.aliases) ||
      section.aliases.length === 0 ||
      !section.aliases.every((a) => typeof a === "string")
    ) {
      throw new Error(
        `[sections.config] Section "${name}" must have a non-empty string[] aliases array.`,
      );
    }
    if (
      !Array.isArray(section.anchors) ||
      !section.anchors.every((a) => typeof a === "string")
    ) {
      throw new Error(
        `[sections.config] Section "${name}" must have a string[] anchors array.`,
      );
    }
  }
}

validate(_drift);

// ── Public exports ───────────────────────────────────────────────────────────

/**
 * Map of section name → alias list.
 *
 * Shape-compatible with the previous `as const` definition: the existing
 * `Object.entries(SECTION_KEYWORDS) as Array<[SectionName, readonly string[]]>`
 * cast in regex.ts / markdown-lines.ts continues to work.
 */
export const SECTION_KEYWORDS: Record<SectionName, readonly string[]> =
  Object.fromEntries(
    (Object.entries(_drift) as Array<[SectionName, SectionConfig]>).map(
      ([name, cfg]) => [name, cfg.aliases as readonly string[]],
    ),
  ) as Record<SectionName, readonly string[]>;

/**
 * Set of section names whose split-lead-letter form we are willing to
 * reconstruct (e.g. `S UMMARY` → `SUMMARY`). Mirrors the previous
 * `new Set([...])` in regex.ts.
 */
export const SPLIT_LETTER_NORMALIZABLE_SECTIONS: ReadonlySet<SectionName> =
  new Set(
    (Object.entries(_drift) as Array<[SectionName, SectionConfig]>)
      .filter(([, cfg]) => cfg.splitLetterNormalizable)
      .map(([name]) => name),
  );

/**
 * Per-section anchor token sets — consumed by L2 (no reader yet).
 * Present in the JSON; re-exported here for future callers.
 */
export const SECTION_ANCHORS: ReadonlyMap<SectionName, readonly string[]> =
  new Map(
    (Object.entries(_drift) as Array<[SectionName, SectionConfig]>).map(
      ([name, cfg]) => [name, cfg.anchors as readonly string[]],
    ),
  );

/**
 * Per-section anchor-fallback opt-in — consumed by L2 (no reader yet).
 */
export const SECTION_ANCHOR_FALLBACK: ReadonlyMap<SectionName, boolean> =
  new Map(
    (Object.entries(_drift) as Array<[SectionName, SectionConfig]>).map(
      ([name, cfg]) => [name, cfg.anchorFallback],
    ),
  );
