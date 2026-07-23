// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Derive the outbound search keyword(s) from a `JobQuery`.
 *
 * Privacy note: this is the ONLY resume-derived data that leaves the browser —
 * a short keyword string built from the (user-editable) query title/skills.
 * Never the resume text. Kept in one shared helper so every adapter sends the
 * same derivation and there is a single place to audit what goes out.
 */

import type { JobQuery } from "../query-builder.ts";

/**
 * Full-text search phrase for feeds with a `search=` param (Remotive,
 * Arbeitnow). Prefers the PRIMARY (most-recent) title; falls back to the top
 * few skills when the résumé had no derivable title.
 *
 * Deliberately sends only the primary title, not the full multi-title set
 * (#539): a `search=` param is a single-intent full-text query, so stacking
 * distinct titles ("Executive Staff Engineer") would over-constrain the feed,
 * and it would widen the audited egress for no gain. The multi-title broadening
 * happens client-side in `search.ts`'s `matchesQuery`, which ORs across every
 * title's tokens against the (unfiltered) feed response.
 */
export function searchPhrase(query: JobQuery): string {
  const primary = query.titles[0]?.trim();
  const parts = primary ? [primary] : query.skills.slice(0, 3);
  return parts.join(" ").trim();
}

/**
 * A single keyword for tag-style feeds (Jobicy's `tag=`). Prefers the first
 * skill (feed tags are skill/tech-shaped), falls back to the primary title.
 */
export function primaryKeyword(query: JobQuery): string {
  return (query.skills[0] ?? query.titles[0] ?? "").trim();
}
