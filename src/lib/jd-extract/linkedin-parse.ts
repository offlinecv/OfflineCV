// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// LinkedIn job title / company parsing, kept separate from the LinkedIn adapter
// because LinkedIn is the one host that forces two independent strategies.
//
// LinkedIn's logged-in job view ships no JSON-LD and no `og:` meta tags — it is
// SPA-rendered, so the tiers that work everywhere else all miss it. That matters
// more than it sounds: LinkedIn is the highest-volume source in the `job-hunt`
// lane, and without host-specific parsing it falls through to the weakest tier.
//
// So there are two entry points, for two different contexts:
//   - `extractLinkedInCompanyFromDOM` — a real `Document` is in hand.
//   - `parseLinkedInTitle` — only the `<title>` string is available.
// The title parser is pure, which is also why it can be unit-tested without jsdom.

export interface LinkedInParseResult {
  title: string;
  company: string;
}

/**
 * Read the company name from LinkedIn's `aria-label` on the company element.
 *
 * The accessibility layer is the most reliable surface here: LinkedIn's visible
 * class names are hashed and rotate between deploys, while the `aria-label` text
 * is user-facing and stable. Expected shape: `<div aria-label="Company, Visa.">`.
 *
 * Returns `null` rather than an empty string when the element is missing or the
 * label is empty, so callers can use `||` to fall through to title parsing.
 */
export function extractLinkedInCompanyFromDOM(doc: Document): string | null {
  const companyEl = doc.querySelector('[aria-label^="Company,"]');
  if (!companyEl) return null;
  const raw = companyEl.getAttribute("aria-label");
  if (!raw) return null;
  return (
    raw
      .replace(/^Company,\s*/, "")
      .replace(/\.\s*$/, "")
      .trim() || null
  );
}

/**
 * How each bracket character moves the nesting depth. All three families count
 * toward one depth: the only question being asked is "is this dash inside
 * something", and no page title mixes families in a way that telling them apart
 * would resolve.
 */
const BRACKET_DEPTH: Readonly<Record<string, number>> = {
  "(": 1,
  "[": 1,
  "{": 1,
  ")": -1,
  "]": -1,
  "}": -1,
};

/** The dashes LinkedIn puts between a job title and its team/department. */
const TEAM_DASHES = new Set(["-", "–"]);

const WHITESPACE = /\s/;

/**
 * The part of a title segment that precedes its team/department dash.
 *
 * The naive split — first `-` or `–` wins — truncated real titles, because a dash
 * appears inside a title far more often than the "Job Title - Department" shape
 * suggests. Observed live: `"Head of Engineering ($225k - $275k)"` became
 * `"Head of Engineering ($225k"`, and the truncated value was persisted as the
 * user's record of the job.
 *
 * So a dash separates only when it is BOTH:
 *
 *  - **at bracket depth zero**, with no unbalanced closer before it — i.e. what it
 *    leaves on the left is a bracket-balanced string. This is what rejects the
 *    dash inside `($225k - $275k)`, `[Contract - 12 months]`, and every other
 *    parenthesised comp band or qualifier; and
 *  - **surrounded by whitespace on both sides**, which is how LinkedIn writes the
 *    separator and is not how a hyphenated token is written. This is what rejects
 *    `"Full-Stack Engineer"` and an unbracketed `"$225k-$275k"`.
 *
 * Both guards only ever *decline* a split the old code made, so the failure they
 * can introduce is a title that keeps a department it should have dropped. That
 * is the cheap direction: a title that says slightly too much is still the job,
 * while `"Head of Engineering ($225k"` is not a title at all. A spaced dash
 * outside brackets — `"Head of Engineering $225k - $275k"` — is genuinely
 * ambiguous with the department shape and is left splitting, because nothing in
 * the string distinguishes the two.
 */
function titleBeforeTeamSegment(segment: string): string {
  let depth = 0;
  let sawUnbalancedCloser = false;

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];

    const delta = BRACKET_DEPTH[char];
    if (delta !== undefined) {
      depth += delta;
      if (depth < 0) sawUnbalancedCloser = true;
      continue;
    }

    if (!TEAM_DASHES.has(char)) continue;
    if (depth !== 0 || sawUnbalancedCloser) continue;
    // `segment[-1]` and the past-the-end read are both `undefined`, so a leading
    // or trailing dash fails this and the whole segment is kept as the title.
    if (!WHITESPACE.test(segment[i - 1] ?? "")) continue;
    if (!WHITESPACE.test(segment[i + 1] ?? "")) continue;

    return segment.slice(0, i);
  }

  return segment;
}

/**
 * Parse a LinkedIn page title into job title and company.
 *
 * LinkedIn's format is `"Job Title - Team/Department | Company | LinkedIn"`, so
 * the split is two-stage and the order matters. Pipes first, because they are
 * LinkedIn's own branding structure and are not used inside job titles; dashes
 * second and only within the first segment, because dashes appear inside company
 * names ("Acme - EMEA") and splitting on them globally would shred those.
 *
 *   "Director, Engineering - Agentic Systems | Visa | LinkedIn"
 *     → pipes → ["Director, Engineering - Agentic Systems", "Visa", "LinkedIn"]
 *     → company = second-to-last = "Visa"
 *     → dash-split segment 0 → title = "Director, Engineering"
 *
 * Which dashes count as that separator is {@link titleBeforeTeamSegment}'s
 * problem, and the answer is narrower than "the first one" — see its docblock.
 *
 * The trailing `"LinkedIn"` is required, not assumed: without it this is some
 * other page's title and guessing at it would invent a company name. Returns
 * `null` in that case, and returns an empty `company` for the two-part shape
 * where the title genuinely carries none.
 */
export function parseLinkedInTitle(
  rawTitle: string,
): LinkedInParseResult | null {
  if (!rawTitle) return null;

  // Includes the fullwidth pipe (U+FF5C) — LinkedIn emits it on some locales.
  const pipeParts = rawTitle.split(/\s*[|｜]\s*/);

  // Need at least 3 parts: [title-segment, company, "LinkedIn"]
  if (pipeParts.length >= 3 && pipeParts[pipeParts.length - 1] === "LinkedIn") {
    const company = pipeParts[pipeParts.length - 2]?.trim();
    const title = titleBeforeTeamSegment(pipeParts[0]).trim();

    if (title && company) {
      return { title, company };
    }
  }

  // Two-part shape — "Job Title | LinkedIn" — carries no company at all.
  if (pipeParts.length === 2 && pipeParts[pipeParts.length - 1] === "LinkedIn") {
    const title = pipeParts[0]?.trim();
    if (title) {
      return { title, company: "" };
    }
  }

  return null;
}

/**
 * Is this a LinkedIn job *view* page?
 *
 * Deliberately narrower than "is this LinkedIn": a search results page, a company
 * page, and a feed post all live on the same host, and the adapter must decline
 * them. Accepts a string or a `URL` and swallows parse failures, so a malformed
 * href from the page cannot throw inside a `matches()` call.
 */
export function isLinkedInJobUrl(url: string | URL): boolean {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return (
      u.hostname.endsWith("linkedin.com") && u.pathname.includes("/jobs/view/")
    );
  } catch {
    return false;
  }
}
