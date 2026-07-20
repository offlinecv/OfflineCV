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
 * Arbeitnow). Prefers the title; falls back to the top few skills when the
 * résumé had no derivable title.
 */
export function searchPhrase(query: JobQuery): string {
  const title = query.title.trim();
  const parts = title ? [title] : query.skills.slice(0, 3);
  return parts.join(" ").trim();
}

/**
 * A single keyword for tag-style feeds (Jobicy's `tag=`). Prefers the first
 * skill (feed tags are skill/tech-shaped), falls back to the title.
 */
export function primaryKeyword(query: JobQuery): string {
  return (query.skills[0] ?? query.title).trim();
}
