// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

// Drift guard (one-directional at compile time): if the JSON loses a key
// required by SectionName, this assignment fails the build immediately —
// TS demands every SectionName key is present. However, extra JSON keys
// pass structurally because TS excess-property checks don't apply to a
// non-literal assignment like `rawConfig.sections`. Extra keys are caught
// at runtime by validate() below.
const _drift: Record<SectionName, SectionConfig> = rawConfig.sections;

// ── Validation ───────────────────────────────────────────────────────────────

// Runtime-known set of valid SectionName values. Must be kept in sync with
// the SectionName union above (the compile-time type is the source of truth).
const VALID_SECTION_NAMES = new Set<string>([
  "summary",
  "experience",
  "education",
  "skills",
  "projects",
  "certifications",
  "achievements",
  "other",
]);

// Per-section shape check: arrays well-formed and boolean flags real booleans.
// Boolean flags are read structurally (the SPLIT_LETTER/ANCHOR_FALLBACKS
// filters below), so a JSON "true" (string) or 1 (number) would pass
// structurally then act truthy — the same drift class validate() exists to
// catch.
function validateSection(name: SectionName, section: SectionConfig): void {
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
  if (typeof section.splitLetterNormalizable !== "boolean") {
    throw new Error(
      `[sections.config] Section "${name}" field "splitLetterNormalizable" must be a boolean.`,
    );
  }
  if (typeof section.anchorFallback !== "boolean") {
    throw new Error(
      `[sections.config] Section "${name}" field "anchorFallback" must be a boolean.`,
    );
  }
}

// Cross-section anchor uniqueness (fallback-enabled sections only).
// matchAnchorFallback (regex.ts) returns on the first iteration hit, so a
// collision across two anchorFallback:true sections would resolve silently by
// iteration order. Enforce disjointness while the fallback path is the
// load-bearing L2 contract.
function validateAnchorUniqueness(
  cfg: Record<SectionName, SectionConfig>,
): void {
  const seenAnchors = new Map<string, SectionName>();
  for (const [name, section] of Object.entries(cfg) as Array<
    [SectionName, SectionConfig]
  >) {
    if (!section.anchorFallback) continue;
    for (const a of section.anchors) {
      const prior = seenAnchors.get(a);
      if (prior) {
        throw new Error(
          `[sections.config] Anchor "${a}" appears in fallback-enabled sections "${prior}" and "${name}". Anchor sets across anchorFallback:true sections must be disjoint.`,
        );
      }
      seenAnchors.set(a, name);
    }
  }
}

function validate(cfg: Record<SectionName, SectionConfig>): void {
  // Catch extra JSON keys that the one-directional compile-time guard misses.
  for (const key of Object.keys(cfg)) {
    if (!VALID_SECTION_NAMES.has(key)) {
      throw new Error(
        `[sections.config] Unexpected section key "${key}" in sections.config.json. ` +
          `Add it to the SectionName union in sections.config.ts or remove it from the JSON.`,
      );
    }
  }
  for (const [name, section] of Object.entries(cfg) as Array<
    [SectionName, SectionConfig]
  >) {
    validateSection(name, section);
  }
  validateAnchorUniqueness(cfg);
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
 * Per-section head-noun anchor sets, keyed by section name (L2 / #111).
 *
 * An anchor is the canonical head noun of a qualified header — the closed-set
 * category word that a header phrase ends in ("Relevant **Experience**",
 * "Customer Service **Experience**"). `matchSectionHeader`'s anchor fallback
 * checks whether a header-shaped line's last token is a member of one of
 * these sets. Sections whose `anchors` array is empty in the JSON (e.g.
 * `other`) simply contribute no anchors.
 *
 * Each set is gated by `SECTION_ANCHOR_FALLBACKS` — membership here does not
 * by itself enable the fallback; the section's `anchorFallback` flag must also
 * be true (see below). Exported for consumption by `regex.ts`; do not widen
 * the `SECTION_KEYWORDS` accessor for this — anchors are a distinct surface.
 */
export const SECTION_ANCHORS: Record<SectionName, ReadonlySet<string>> =
  Object.fromEntries(
    (Object.entries(_drift) as Array<[SectionName, SectionConfig]>).map(
      ([name, cfg]): [SectionName, ReadonlySet<string>] => [
        name,
        new Set(cfg.anchors),
      ],
    ),
  ) as Record<SectionName, ReadonlySet<string>>;

/**
 * Set of section names whose head-noun anchor fallback is enabled (L2 / #111).
 *
 * `skills` and `other` stay OFF (`anchorFallback: false` in the JSON): a
 * two-column résumé flattens a sidebar "SKILLS" label between experience
 * entries, and an anchored match there would open a section mid-experience and
 * strand every following role — the same hazard that excludes `skills` from
 * `SPLIT_LETTER_NORMALIZABLE_SECTIONS`. `matchSectionHeader` consults this set
 * before accepting an anchor match.
 */
export const SECTION_ANCHOR_FALLBACKS: ReadonlySet<SectionName> = new Set(
  (Object.entries(_drift) as Array<[SectionName, SectionConfig]>)
    .filter(([, cfg]) => cfg.anchorFallback)
    .map(([name]) => name),
);
