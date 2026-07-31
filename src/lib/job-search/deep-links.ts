// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * buildDeepLinks — maps a `JobQuery` to prefilled search URLs on major job
 * boards (#318, slice 1 of the job-search epic). Pure function, no I/O; the
 * resulting URLs are rendered as inert `<a target="_blank" rel="noopener
 * noreferrer">` — nothing here fetches anything.
 *
 * Keyword composition: seniority + every title + skills, space-joined — with
 * the seniority skipped when a title already contains it (the usual case, since
 * seniority is derived from a title word; see query-builder.ts), so "Senior
 * Backend Engineer" never becomes "Senior Senior Backend Engineer". All titles
 * (not just the most-recent) go into the keyword phrase — #539: the major
 * boards' keyword field is OR-weighted, so listing every held title broadens
 * the results to cover each facet of the candidate rather than the single most-
 * recent one. A fully degenerate query (no titles, no skills) still produces
 * valid URLs — LinkedIn/Indeed get an empty query string, Google Jobs falls
 * back to the bare word "jobs" — so the deep-link row never breaks even before
 * the user has typed anything.
 *
 * Skill count in the keyword phrase (#541): `query.skills` can hold up to
 * `MAX_SKILLS` (12, query-builder.ts) — plenty for the in-app chip list, but
 * pasting all 12 plus every title into a URL query param risks tipping
 * pathological cases past board/browser URL-length limits. `deriveSkills`
 * already rank-sorts canonical/taxonomy skills first, so slicing again here
 * to `MAX_DEEP_LINK_SKILLS` keeps only the most relevant subset in the
 * outbound link without re-deriving anything — the in-app query (chips,
 * titles, seniority) is untouched.
 *
 * Location (#545): only LinkedIn and Indeed get a dedicated location param
 * (`location` / `l`) — both boards honor it as a distinct location filter on
 * their search UI. Google Jobs has no structured location param (it's a
 * free-text query), so it's left alone rather than folding location into the
 * keyword text and changing that builder's existing shape. The location
 * string is trimmed and capped at `MAX_DEEP_LINK_LOCATION_LENGTH` so a
 * pathological free-typed value can't blow out the egress URL length the way
 * an uncapped skill list could (see `MAX_DEEP_LINK_SKILLS` above).
 *
 * `buildLocationParam` / `stripSearchOperators` are exported for
 * `company-search-link.ts` (#691); `buildKeywords` deliberately is NOT. That
 * module used to import it, on the reasoning that one derivation cannot drift
 * — but a self-hosted employer's careers box parses its input differently from
 * a major board's OR-weighted keyword field, and sharing the broadening phrase
 * across both shipped a link that returned nothing. It now composes a
 * single-intent phrase and shares only the operator hygiene below, which is
 * correct for every destination. See its docblock for the measurement.
 *
 * So `buildKeywords` is module-private again: this file's own `buildDeepLinks`
 * is its only caller, and re-exporting it would re-offer the exact seam that
 * was wrong.
 */

import type { JobQuery } from "./query-builder.ts";

export interface JobBoardLink {
  label: string;
  url: string;
}

/**
 * Cap on skills folded into the deep-link keyword phrase — narrower than
 * `MAX_SKILLS` on purpose (see docblock above). `query.skills` is already
 * ranked most-relevant-first, so slicing to the top N here drops the least-
 * relevant tail, not an arbitrary one.
 */
export const MAX_DEEP_LINK_SKILLS = 6;

/** Cap on the location string folded into a deep link's location param —
 *  bounds egress URL length against a pathological free-typed value. */
const MAX_DEEP_LINK_LOCATION_LENGTH = 100;

/**
 * Neutralize the one punctuation mark a résumé term carries that a destination
 * search box reads as an OPERATOR rather than as text: a `-` that begins a
 * whitespace-delimited token, which every major job search parses as "exclude
 * the following word".
 *
 * This is not hypothetical, and it is not about phrase length. A title written
 * `Engineering Lead - Customer Experience` — an ordinary way to write a scoped
 * role — joins into the keyword phrase carrying a bare `-` token. Measured
 * against Apple's own careers search on 2026-07-30:
 *
 *     search=Engineering Manager                          → 600+ postings
 *     search=Engineering Manager - Customer Experience    → zero postings
 *     search=Sr. Engineering Manager Founder India Site Lead → 600+ postings
 *
 * The third line is the control: three stacked titles and no hyphen still
 * returns a full page, so it is the operator that empties the result set, not
 * the number of terms. A user reading that page sees an employer with no
 * matching roles rather than a malformed query, which is why this fails
 * silently and why the strip belongs here — in the shared derivation — rather
 * than in any one renderer.
 *
 * Only a TOKEN-LEADING `-` is removed, and a token that is nothing but dashes
 * is dropped entirely rather than left behind as a double space. An INTRA-word
 * hyphen is ordinary spelling (`e-commerce`, `full-stack`, `end-to-end`) with
 * no operator meaning, so stripping it would mangle a real term to fix a
 * problem it does not have.
 *
 * Deliberately left alone: `&`, `/`, `,`, `+`, `#`, `.`. `+` and `#` are
 * load-bearing inside `C++` and `C#`, and none of them reproduced the empty
 * result above when measured — an unmeasured strip would trade a real term for
 * a guess.
 */
export function stripSearchOperators(phrase: string): string {
  return phrase
    .split(/\s+/)
    .map((token) => token.replace(/^-+/, ""))
    .filter((token) => token.length > 0)
    .join(" ");
}

export function buildLocationParam(query: JobQuery): string | undefined {
  const location = query.location?.trim();
  if (!location) return undefined;
  return location.slice(0, MAX_DEEP_LINK_LOCATION_LENGTH);
}

function buildKeywords(query: JobQuery): string {
  // Seniority is usually DERIVED from a word in the primary title
  // (query-builder.ts), so prepending it blindly doubles it ("Senior Senior
  // Backend Engineer"). Only add it when NO title already carries it (e.g. a
  // user-typed seniority, or an abbreviated title like "Sr. Engineer" with the
  // expanded "Senior" label).
  const seniorityLower = query.seniority?.toLowerCase();
  const seniority =
    seniorityLower &&
    !query.titles.some((t) => t.toLowerCase().includes(seniorityLower))
      ? query.seniority
      : undefined;
  const parts = [
    seniority,
    ...query.titles,
    ...query.skills.slice(0, MAX_DEEP_LINK_SKILLS),
  ].filter((part): part is string => Boolean(part && part.trim()));
  return stripSearchOperators(parts.join(" "));
}

export function buildDeepLinks(query: JobQuery): JobBoardLink[] {
  const keywords = buildKeywords(query);
  const location = buildLocationParam(query);

  const linkedinParams = new URLSearchParams();
  if (keywords) linkedinParams.set("keywords", keywords);
  if (location) linkedinParams.set("location", location);

  const indeedParams = new URLSearchParams();
  if (keywords) indeedParams.set("q", keywords);
  if (location) indeedParams.set("l", location);

  const googleParams = new URLSearchParams();
  googleParams.set("q", keywords ? `${keywords} jobs` : "jobs");

  return [
    {
      label: "LinkedIn",
      url: `https://www.linkedin.com/jobs/search/?${linkedinParams.toString()}`,
    },
    {
      label: "Indeed",
      url: `https://www.indeed.com/jobs?${indeedParams.toString()}`,
    },
    {
      label: "Google Jobs",
      url: `https://www.google.com/search?${googleParams.toString()}`,
    },
  ];
}
