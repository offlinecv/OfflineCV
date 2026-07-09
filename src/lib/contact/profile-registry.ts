// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Contributor-extensible host registry for classifying contact/identity links
 * into the JSON-Resume-style `ProfileLink` shape (#335).
 *
 * Adding support for a new host is a ONE-LINE change: append a `HostRule` to
 * `PROFILE_HOSTS`. An unrecognized host is never dropped — it is kept as
 * `{ network: <hostname>, kind: "other" }`, so a candidate's GitLab, Codeberg,
 * Kaggle, Behance, ORCID, Substack, … link survives with its identity intact
 * instead of collapsing into a generic "website" bucket.
 *
 * URL normalization is intentionally NOT reimplemented here — `normalizeUrl` /
 * `urlSlug` and the `LINKEDIN_NONPROFILE_RE` exclusion are reused from the
 * parser's `extract/contact.ts` so classification stays byte-consistent with
 * extraction.
 */

import type { ProfileLink } from "../score/types.ts";
import {
  normalizeUrl,
  urlSlug,
  LINKEDIN_NONPROFILE_RE,
} from "../heuristics/extract/contact.ts";

interface HostRule {
  /** Tested against the URL's hostname (lowercased, `www.` stripped). */
  match: RegExp;
  /** Human-facing network label shown in the UI. */
  network: string;
  kind: ProfileLink["kind"];
}

/**
 * Ordered host rules. First match wins. To support a new host, add one line.
 * `match` is tested against the bare hostname (e.g. `scholar.google.com`), so
 * anchor with `(^|\.)host$` to match the host and its subdomains without also
 * matching a look-alike substring.
 */
export const PROFILE_HOSTS: readonly HostRule[] = [
  { match: /(^|\.)linkedin\.com$/i, network: "LinkedIn", kind: "social" },
  { match: /(^|\.)github\.com$/i, network: "GitHub", kind: "code" },
  { match: /(^|\.)gitlab\.com$/i, network: "GitLab", kind: "code" },
  { match: /(^|\.)codeberg\.org$/i, network: "Codeberg", kind: "code" },
  { match: /(^|\.)kaggle\.com$/i, network: "Kaggle", kind: "code" },
  { match: /(^|\.)huggingface\.co$/i, network: "Hugging Face", kind: "code" },
  { match: /(^|\.)behance\.net$/i, network: "Behance", kind: "portfolio" },
  { match: /(^|\.)dribbble\.com$/i, network: "Dribbble", kind: "portfolio" },
  { match: /(^|\.)orcid\.org$/i, network: "ORCID", kind: "academic" },
  { match: /(^|\.)scholar\.google\./i, network: "Google Scholar", kind: "academic" },
  { match: /(^|\.)substack\.com$/i, network: "Substack", kind: "writing" },
  { match: /(^|\.)medium\.com$/i, network: "Medium", kind: "writing" },
];

/**
 * Classify one URL into a `ProfileLink`. Normalizes the URL first (reusing the
 * parser's `normalizeUrl`, so a scheme-less `github.com/x` gets `https://`),
 * then matches its hostname against {@link PROFILE_HOSTS}.
 *
 * - An UNKNOWN host is kept, never dropped: `{ network: <hostname>, kind:
 *   "other" }`.
 * - A NON-PROFILE LinkedIn URL (feed / company / jobs / … — see
 *   `LINKEDIN_NONPROFILE_RE`) must NOT become a `social` profile; it is kept as
 *   an `other` link on the `linkedin.com` host.
 *
 * Returns `undefined` only when the input is empty / cannot be parsed into a
 * host — callers filter those out.
 */
export function classifyProfile(rawUrl: string): ProfileLink | undefined {
  const url = normalizeUrl(rawUrl);
  if (!url) return undefined;

  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
  if (hostname.length === 0) return undefined;

  // A LinkedIn URL that is a feed/company/jobs/… page is not a personal
  // identity profile — keep it, but do not label it `social`.
  const isLinkedinHost = /(^|\.)linkedin\.com$/i.test(hostname);
  if (isLinkedinHost && LINKEDIN_NONPROFILE_RE.test(url)) {
    return { url, network: hostname, kind: "other" };
  }

  for (const rule of PROFILE_HOSTS) {
    if (rule.match.test(hostname)) {
      return { url, network: rule.network, kind: rule.kind };
    }
  }
  return { url, network: hostname, kind: "other" };
}

/**
 * Build a deduplicated, order-preserving `ProfileLink[]` from a list of raw
 * URLs (undefined entries skipped). Duplicates — the same link reached via more
 * than one source — collapse by normalized slug so a URL never appears twice.
 *
 * Phase 1 (#335) feeds this the four legacy link values in their fixed
 * precedence order `[linkedin, github, portfolio, website]`, so the resulting
 * array mirrors exactly the links the four legacy keys already carry.
 */
export function profilesFromUrls(
  urls: readonly (string | undefined)[],
): ProfileLink[] {
  const out: ProfileLink[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    const profile = classifyProfile(raw);
    if (!profile) continue;
    const slug = urlSlug(profile.url) ?? profile.url.toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(profile);
  }
  return out;
}
