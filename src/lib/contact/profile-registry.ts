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
 * shared `url-utils` leaf (the same helpers the parser's `extract/contact.ts`
 * uses) so classification stays byte-consistent with extraction, without the
 * two modules importing each other (#423).
 */

import type { ProfileLink } from "../score/types.ts";
import {
  normalizeUrl,
  urlSlug,
  LINKEDIN_NONPROFILE_RE,
} from "./url-utils.ts";

interface HostRule {
  /** Tested against the URL's hostname (lowercased, `www.` stripped). */
  match: RegExp;
  /** Human-facing network label shown in the UI. */
  network: string;
  kind: ProfileLink["kind"];
  /** Paths on this host that are NOT a personal identity profile (e.g. a
   *  LinkedIn company/jobs/feed page, a GitHub org page). Tested against the
   *  full URL; a match keeps the link but downgrades it to a generic `other`
   *  link on the bare host — never the network's `social`/`code`/… kind. Keeps
   *  the per-host exclusion inside the `HostRule` shape instead of accreting a
   *  special case in the classify loop (#421 review, nit 17). */
  nonProfilePath?: RegExp;
  /** UI-only guided-add hint. When set, this host surfaces as a quick-pick chip
   *  in the profile-add affordance (`PROFILE_QUICK_PICKS`): tapping the chip
   *  pre-fills `prefix` and the caret lands after it so the user types only
   *  `hint` (their handle). Ordering in `PROFILE_HOSTS` sets the chip order.
   *  Kept here so "which networks do we recognize" has ONE source of truth. */
  quickPick?: { prefix: string; hint: string };
}

/**
 * Ordered host rules. First match wins. To support a new host, add one line.
 * `match` is tested against the bare hostname (e.g. `scholar.google.com`), so
 * anchor with `(^|\.)host$` to match the host and its subdomains without also
 * matching a look-alike substring.
 */
export const PROFILE_HOSTS: readonly HostRule[] = [
  {
    match: /(^|\.)linkedin\.com$/i,
    network: "LinkedIn",
    kind: "social",
    nonProfilePath: LINKEDIN_NONPROFILE_RE,
    quickPick: { prefix: "https://linkedin.com/in/", hint: "your-handle" },
  },
  {
    match: /(^|\.)github\.com$/i,
    network: "GitHub",
    kind: "code",
    quickPick: { prefix: "https://github.com/", hint: "your-handle" },
  },
  {
    match: /(^|\.)gitlab\.com$/i,
    network: "GitLab",
    kind: "code",
    quickPick: { prefix: "https://gitlab.com/", hint: "your-handle" },
  },
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

/** One tappable network chip in the guided profile-add affordance. */
export interface ProfileQuickPick {
  /** Chip label + the profile's network name (e.g. "LinkedIn"). */
  label: string;
  /** URL pre-filled when the chip is tapped; the caret lands after it. */
  prefix: string;
  /** Ghost hint for the part the user still types (their handle / domain). */
  hint: string;
}

/**
 * The quick-pick network chips shown in the guided profile-add UI, DERIVED from
 * `PROFILE_HOSTS` (every host carrying a `quickPick`) plus a generic
 * "Portfolio" catch-all for a personal site (which has no fixed host). Deriving
 * keeps the picker in lockstep with what `classifyProfile` recognizes — adding
 * a `quickPick` to a host is the ONE-LINE change that surfaces a new chip.
 */
export const PROFILE_QUICK_PICKS: readonly ProfileQuickPick[] = [
  ...PROFILE_HOSTS.filter((h) => h.quickPick).map((h) => ({
    label: h.network,
    prefix: h.quickPick!.prefix,
    hint: h.quickPick!.hint,
  })),
  { label: "Portfolio", prefix: "https://", hint: "yourname.com" },
];

/**
 * Recognized network names NOT already offered as a quick-pick chip — feeds the
 * "…and more are recognized automatically" helper so the promise stays truthful
 * as hosts are added/removed (single source of truth: {@link PROFILE_HOSTS}).
 */
export function otherRecognizedNetworks(): string[] {
  const picked = new Set(PROFILE_QUICK_PICKS.map((p) => p.label));
  const names: string[] = [];
  for (const host of PROFILE_HOSTS) {
    if (!picked.has(host.network)) names.push(host.network);
  }
  return names;
}

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

  for (const rule of PROFILE_HOSTS) {
    if (!rule.match.test(hostname)) continue;
    // A non-profile path on this host (e.g. a LinkedIn feed/company/jobs page)
    // is kept but downgraded to a generic `other` link on the bare host — never
    // the network's identity kind.
    if (rule.nonProfilePath?.test(url)) {
      return { url, network: hostname, kind: "other" };
    }
    return { url, network: rule.network, kind: rule.kind };
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
