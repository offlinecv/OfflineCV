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

/** Canonicalize a URL: ensure an `https://` scheme, drop any run of trailing
 *  sentence punctuation and slashes, and strip a leading `www.` host prefix.
 *  Returns `undefined` for empty input, and for input that strips down to
 *  nothing or to a bare scheme.
 *
 *  The `www.` strip (#425) and the trailing-slash strip both make the ATS-export
 *  round-trip symmetric: the exporter shows link slugs `www.`-less AND
 *  slash-less (`formatLinkDisplay`), and the parser can't recover either on
 *  re-parse — so canonicalizing them away HERE, on both the original parse and
 *  the re-parse, means a `www.`- or slash-bearing source URL (LinkedIn's own
 *  canonical `/in/<slug>/` form ends in a slash) and its stripped exported
 *  display both normalize to the same value, so the `linkedin_url` round-trip
 *  holds. Both are semantically inert (a trailing slash on a host+path is the
 *  same resource), so dropping them loses nothing. Keeps this Tier-1 helper in
 *  lockstep with the Tier-1.5 `regex-fallback.ts` `normalizeUrl` and the
 *  trailing-punctuation strip `urlSlug` already applies for identity
 *  comparison. */
export function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw
    .trim()
    // One pass over punctuation AND slashes together, not two sequential
    // strips: `.../jane./` ends in a slash, so a slash-last pass would leave
    // the `.` stranded as the new final character with nothing left to strip
    // it. Interleaving is the point of the shared character class.
    .replace(/[,;.)/]+$/, "")
    .replace(/^(https?:\/\/)?www\./i, "$1");
  // Nothing survived the strip, or all that did is a bare scheme (`https://`
  // strips to `https:`) — there is no URL here. Returning `https://` + "" would
  // manufacture one. Mirrors `urlSlug`'s empty guard so the pair agrees on what
  // "not a URL" means.
  if (trimmed.length === 0 || /^[a-z][a-z0-9+.-]*:$/i.test(trimmed)) {
    return undefined;
  }
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
