// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Leaf URL helpers shared by the contact extractor (`heuristics/extract/
 * contact.ts`) and the profile registry (`contact/profile-registry.ts`).
 *
 * Extracted here to break the import cycle those two formed (#423): the registry
 * needs `normalizeUrl` / `urlSlug` / `LINKEDIN_NONPROFILE_RE` for byte-consistent
 * classification, while the extractor imports the registry's `profilesFromUrls`.
 * Both now depend on this leaf (which imports nothing internal), so neither
 * imports the other. Behavior is unchanged — the definitions moved verbatim.
 */

/** LinkedIn paths that are NOT a personal profile — feed, company pages, job
 *  posts, articles, etc. Everything else under `linkedin.com/<handle>` (the
 *  `/in/<handle>` canonical form AND bare-vanity hosts) is treated as a
 *  profile, mirroring GitHub's "any `github.com/<user>`" rule. */
export const LINKEDIN_NONPROFILE_RE =
  /linkedin\.com\/(company|jobs|feed|school|learning|pulse|posts|groups|showcase|games|events|help|legal|search|signup|login|home)\b/i;

/** Ensure a URL carries an `https://` scheme and drop a trailing sentence
 *  punctuation mark. Returns `undefined` for empty input. */
export function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/[,;.)]$/, "").trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Host+path of a URL, lowercased, with scheme / `www.` / trailing punctuation
 *  removed — the comparable identity of a link across "https://github.com/x",
 *  "github.com/x" and "github.com/x/". */
export function urlSlug(u: string | undefined): string | undefined {
  if (!u) return undefined;
  const s = u
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[/.,;:)\]]+$/, "")
    .toLowerCase();
  return s.length > 0 ? s : undefined;
}
