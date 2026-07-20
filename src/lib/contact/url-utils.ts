// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

/** Canonicalize a URL: ensure an `https://` scheme, drop a trailing sentence
 *  punctuation mark, and strip a leading `www.` host prefix. Returns `undefined`
 *  for empty input.
 *
 *  The `www.` strip (#425) makes the ATS-export round-trip symmetric: the
 *  exporter shows link slugs `www.`-less (`formatLinkDisplay`), and the parser
 *  can't recover a `www.` on re-parse — so canonicalizing it away HERE, on both
 *  the original parse and the re-parse, means a `www.`-bearing source URL and
 *  its `www.`-less exported display both normalize to the same value and the
 *  `linkedin_url` round-trip holds. `www.` is a semantically inert host alias
 *  (linkedin/github/etc. serve both), so dropping it loses nothing. Mirrors the
 *  `www.` strip `urlSlug` already applies for identity comparison. */
export function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw
    .replace(/[,;.)]$/, "")
    .trim()
    .replace(/^(https?:\/\/)?www\./i, "$1");
  // Preserve any explicit scheme unchanged — only default a bare host to https.
  // Matching just `https?://` here would (a) not exist as a bug for http (it
  // already round-trips) but (b) turn `ftp://foo` into `https://ftp://foo`.
  // Guarding on the general scheme grammar keeps the module's round-trip promise
  // for non-http(s) inputs too (Samhit review, PR #434).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
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
