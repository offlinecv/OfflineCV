// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * contact-profiles.ts — the ONE consolidated contact-link model (#427).
 *
 * Before #427 contact links lived in two parallel channels that drifted: the
 * four hardcoded `*_url` slots (read/gated by the scorer + contact display) and
 * a separate `addedProfiles` edit list. This module makes a single, ordered,
 * confidence-stamped `ProfileLink[]` the thing every downstream consumer reads:
 * the scorer's completeness check, the ContactCard, and (via `parsed.profiles`)
 * the JSON-Resume export.
 *
 * The load-bearing invariant is **byte-identical scoring**: `deriveContactProfiles`
 * is a pure function of the exact same inputs the scorer + display read before
 * consolidation — the four legacy slot values and their `fieldConfidence`. Each
 * legacy slot becomes one entry carrying its `legacyKey` and the slot's
 * confidence (defaulting to 0 when the slot has a value but no confidence entry,
 * mirroring the old `fieldConfidence[key] ?? 0` gate), so a consumer that reads
 * the list and applies the same 0.5 floor sees precisely what it saw reading the
 * slot directly. Extra links beyond the four slots (a second GitHub, a GitLab,
 * ORCID, …) append after, carrying confidence 1 (user-affirmed) — they were
 * always shown ungated in the pre-#427 `ContactExtraLinks` surface and never
 * counted toward the score, both of which this preserves.
 */

import type { FieldConfidence } from "../heuristics/types.ts";
import type { LegacyLinkKey, ProfileLink } from "../score/types.ts";
import { classifyProfile } from "./profile-registry.ts";
import { urlSlug } from "./url-utils.ts";

/** The four legacy contact-link slots in their fixed precedence order. */
export const LEGACY_LINK_KEYS: readonly LegacyLinkKey[] = [
  "linkedin_url",
  "github_url",
  "portfolio_url",
  "website_url",
];

/** The slice of a parsed resume `deriveContactProfiles` reads. */
export type ContactProfileSource = Partial<Record<LegacyLinkKey, string>> & {
  profiles?: readonly ProfileLink[];
};

/** Normalized dedup key for a URL — the shared slug, or the lowercased URL when
 *  the slug can't be derived (mirrors `profilesFromUrls`). */
function slugOf(url: string): string {
  return urlSlug(url) ?? url.toLowerCase();
}

/**
 * Derive the consolidated contact-link list from a parsed resume's four legacy
 * slots plus any extra `profiles[]` entries beyond them. Pure; order is the four
 * legacy slots (present-only) in precedence order, then extras in their existing
 * order. Each legacy entry carries its `legacyKey` and the slot's confidence
 * (`fieldConfidence[key] ?? 0`); extras carry their own confidence (default 1).
 *
 * A legacy slot's value is kept even when `classifyProfile` can't parse it (a
 * malformed-but-present URL) — presence must match the old `Boolean(slot)` gate
 * — falling back to `{ network: url, kind: "other" }`.
 */
export function deriveContactProfiles(
  parsed: ContactProfileSource,
  fieldConfidence: FieldConfidence,
): ProfileLink[] {
  const out: ProfileLink[] = [];
  const seen = new Set<string>();

  for (const key of LEGACY_LINK_KEYS) {
    const url = parsed[key];
    if (!url) continue;
    const classified = classifyProfile(url);
    const canonicalUrl = classified?.url ?? url;
    seen.add(slugOf(canonicalUrl));
    out.push({
      url: canonicalUrl,
      network: classified?.network ?? url,
      kind: classified?.kind ?? "other",
      legacyKey: key,
      confidence: fieldConfidence[key] ?? 0,
    });
  }

  // Extras: any `profiles[]` entry whose slug isn't already one of the four
  // legacy slots. These are the links that had no legacy home (#427's drift) —
  // user-affirmed, so confidence defaults to 1.
  for (const p of parsed.profiles ?? []) {
    const slug = slugOf(p.url);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ ...p, confidence: p.confidence ?? 1, legacyKey: undefined });
  }

  return out;
}

/** The confidence floor a contact link must clear to be credited/displayed —
 *  the same 0.5 floor the scorer + contact display applied to the legacy slots
 *  before #427 (`ANON_CONTACT_CONFIDENCE_FLOOR` / `CONTACT_DISPLAY_CONFIDENCE_FLOOR`). */
export const CONTACT_LINK_CONFIDENCE_FLOOR = 0.5;

/** True when `profile` clears the confidence floor (absent confidence ⇒ trusted). */
export function isProfileConfident(profile: ProfileLink): boolean {
  return (profile.confidence ?? 1) >= CONTACT_LINK_CONFIDENCE_FLOOR;
}

/** The primary (legacy-slot) entry for `key` in a derived list, or undefined. */
export function primaryProfileFor(
  profiles: readonly ProfileLink[],
  key: LegacyLinkKey,
): ProfileLink | undefined {
  return profiles.find((p) => p.legacyKey === key);
}
