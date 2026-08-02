// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// The DOM-free half of schema.org `JobPosting` extraction: given already-parsed
// JSON-LD, pull out the fields a posting declares about itself.
//
// Split from the DOM shell (`schema-org.ts`) on purpose, and the split is load-
// bearing rather than tidy-minded. Nothing here touches `Document`, so it is
// unit-testable in the default `environment: "node"` (`vite.config.ts`) with no
// jsdom pragma and no fixture HTML — the tests can hand these functions plain
// objects. It also means this half runs anywhere JSON-LD can be obtained,
// including contexts that have no DOM at all.
//
// Every extractor here is defensive to the point of paranoia about types. JSON-LD
// is publisher-authored and routinely violates its own schema: `jobLocation` is a
// single object on one board and an array on the next, `identifier` is a bare
// string here and a `{ value }` object there, `employmentType` is sometimes an
// array. So each helper narrows from `unknown` and returns `undefined` rather
// than throwing — one malformed field must never cost the whole extraction.

/**
 * Domain fragment → human-readable ATS platform name.
 *
 * This table only *names* the platform behind a page. It deliberately does not
 * decide whether that platform can be fetched: `parseAtsUrl` in
 * `src/lib/jd-match/fetch-jd.ts` remains the single owner of "does this URL
 * resolve to a public JSON API I can call", and this map must not grow into a
 * second one. The two answer different questions — most domains below have no
 * fetchable API at all, and putting them in the fetch parser would produce a
 * platform id with no client behind it.
 *
 * Matched by substring against a hostname or href, so `boards.greenhouse.io`
 * and a bare `greenhouse.io` both resolve; the longer keys exist to document the
 * shapes seen in the wild, not because matching requires them.
 */
export const ATS_DOMAIN_MAP: Record<string, string> = {
  "greenhouse.io": "Greenhouse",
  "boards.greenhouse.io": "Greenhouse",
  "lever.co": "Lever",
  "jobs.lever.co": "Lever",
  "taleo.net": "Taleo",
  "myworkdayjobs.com": "Workday",
  "wd5.myworkdayjobs.com": "Workday",
  "icims.com": "iCIMS",
  "smartrecruiters.com": "SmartRecruiters",
  "jobvite.com": "Jobvite",
  "applytojob.com": "JazzHR",
  "breezy.hr": "Breezy HR",
  "ashbyhq.com": "Ashby",
  "bamboohr.com": "BambooHR",
  "recruitee.com": "Recruitee",
  "successfactors.com": "SAP SuccessFactors",
  "phenom.com": "Phenom",
  "oraclecloud.com": "Oracle HCM",
  "workable.com": "Workable",
};

/**
 * Name the ATS platform behind a hostname or href, or `undefined` if none match.
 *
 * The sole reader of `ATS_DOMAIN_MAP`, so the substring-matching rule lives in
 * one place rather than being re-implemented by each caller.
 */
export function matchAtsDomain(hrefOrHost: string): string | undefined {
  if (!hrefOrHost) return undefined;
  const haystack = hrefOrHost.toLowerCase();
  for (const [domain, platform] of Object.entries(ATS_DOMAIN_MAP)) {
    if (haystack.includes(domain)) return platform;
  }
  return undefined;
}

// ─── JSON-LD helpers ─────────────────────────────────────────────────────────

/**
 * Find a `JobPosting` node in parsed JSON-LD.
 *
 * Recursive because publishers nest it three different ways: as the root object,
 * inside a `@graph` array alongside `Organization` / `BreadcrumbList` nodes, or
 * inside a bare top-level array of unrelated blocks. Returns the first match —
 * a page advertising two distinct postings in one block is not a shape worth
 * guessing about, and taking the first is at least deterministic.
 */
export function findJobPosting(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  if (obj["@type"] === "JobPosting") return obj;

  if (Array.isArray(obj["@graph"])) {
    for (const item of obj["@graph"]) {
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>)["@type"] === "JobPosting"
      ) {
        return item as Record<string, unknown>;
      }
    }
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findJobPosting(item);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Check that a JSON-LD block declares a schema.org context.
 *
 * Guards against reading a `@type: "JobPosting"` that belongs to some other
 * vocabulary entirely. `@context` is a string on most pages and an array on
 * pages that mix vocabularies, so both are accepted.
 */
export function hasSchemaOrgContext(data: Record<string, unknown>): boolean {
  const context = data["@context"];
  if (typeof context === "string") return context.includes("schema.org");
  if (Array.isArray(context)) {
    return context.some((c) => typeof c === "string" && c.includes("schema.org"));
  }
  return false;
}

// ─── Field extraction ────────────────────────────────────────────────────────

/**
 * Compose a location string from `jobLocation`.
 *
 * Multiple locations are joined with `" | "` rather than collapsed to the first:
 * a posting open in three cities is materially different from one open in one,
 * and the consumer displays this verbatim. Falls back to a `Place.name` when a
 * publisher skips the nested `address` object.
 */
export function extractLocation(
  posting: Record<string, unknown>,
): string | undefined {
  const jobLocation = posting.jobLocation;
  if (!jobLocation) return undefined;

  const locations = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
  const parts: string[] = [];

  for (const loc of locations) {
    if (!loc || typeof loc !== "object") continue;
    const place = loc as Record<string, unknown>;
    const address = place.address as Record<string, unknown> | undefined;

    if (address && typeof address === "object") {
      const city = address.addressLocality as string | undefined;
      const region = address.addressRegion as string | undefined;
      const country = address.addressCountry as string | undefined;
      const components = [city, region, country].filter(Boolean);
      if (components.length > 0) parts.push(components.join(", "));
    } else if (typeof place.name === "string") {
      parts.push(place.name);
    }
  }

  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/**
 * Read the posting's own declared work model.
 *
 * Returns only `"remote"` or `undefined` — never a guess. schema.org has exactly
 * one machine-readable signal here (`TELECOMMUTE`), so "hybrid" and "onsite" are
 * not derivable and are left absent rather than inferred from prose. A regex over
 * the description would be a guess wearing a declared field's clothes.
 *
 * The third branch is the shape where a publisher states *who may apply from
 * where* (`applicantLocationRequirements`) but names no physical `jobLocation` —
 * in practice that is a remote role.
 */
export function extractWorkModel(
  posting: Record<string, unknown>,
): string | undefined {
  if (posting.jobLocationType === "TELECOMMUTE") return "remote";
  if (
    Array.isArray(posting.jobLocationType) &&
    posting.jobLocationType.includes("TELECOMMUTE")
  ) {
    return "remote";
  }
  if (posting.applicantLocationRequirements && !posting.jobLocation) {
    return "remote";
  }
  return undefined;
}

/**
 * Format `baseSalary` into display text.
 *
 * Deliberately produces a string, not numbers. Currency, period, and open-ended
 * ranges ("$180k+", "up to $220k") all carry meaning that a `{min, max}` pair
 * loses, and no consumer in this repo does arithmetic on pay.
 */
export function extractSalary(
  posting: Record<string, unknown>,
): string | undefined {
  const salary = posting.baseSalary;
  if (!salary || typeof salary !== "object") return undefined;

  const salaryObj = salary as Record<string, unknown>;
  const currency = (salaryObj.currency as string) || "";
  const value = salaryObj.value;

  if (!value || typeof value !== "object") {
    if (typeof value === "number") {
      return `${currency} ${value.toLocaleString()}`.trim();
    }
    return undefined;
  }

  const valueObj = value as Record<string, unknown>;
  const min = valueObj.minValue as number | undefined;
  const max = valueObj.maxValue as number | undefined;
  const unitText = (valueObj.unitText as string) || "";

  if (min && max) {
    const suffix = unitText ? ` per ${unitText.toLowerCase()}` : "";
    return `${currency} ${min.toLocaleString()} - ${max.toLocaleString()}${suffix}`.trim();
  }
  if (min) return `${currency} ${min.toLocaleString()}+`.trim();
  if (max) return `Up to ${currency} ${max.toLocaleString()}`.trim();

  return undefined;
}

/**
 * Read the publisher's own job identifier.
 *
 * Note this is the *publisher's* id, not this repo's. `deriveJobId` in
 * `src/lib/storage/job-url.ts` remains the only thing that decides whether two
 * captures are the same posting; this value is a hint carried alongside, never a
 * substitute for that rule.
 */
export function extractJobId(
  posting: Record<string, unknown>,
): string | undefined {
  if (typeof posting.identifier === "string") return posting.identifier;
  if (posting.identifier && typeof posting.identifier === "object") {
    const idObj = posting.identifier as Record<string, unknown>;
    if (typeof idObj.value === "string") return idObj.value;
    if (typeof idObj.name === "string") return idObj.name;
  }
  return undefined;
}

/**
 * Hash the JSON-LD fields that decide whether a posting has materially changed,
 * so a re-capture can tell "the publisher edited this" from "the page re-rendered".
 *
 * Hashes a fixed field subset rather than the whole node, because publishers mutate
 * unrelated keys (view counts, tracking ids) on every render and hashing those
 * would report a change on every visit.
 *
 * Returns `undefined` rather than throwing when Web Crypto is unavailable — the
 * hash is an optimisation for change detection, and losing it must never cost the
 * extraction itself.
 */
export async function computeStructuredDataHash(
  posting: Record<string, unknown>,
): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;

  const hashContent = JSON.stringify({
    title: posting.title,
    description: posting.description,
    identifier: posting.identifier,
    jobLocation: posting.jobLocation,
    baseSalary: posting.baseSalary,
    datePosted: posting.datePosted,
    validThrough: posting.validThrough,
  });

  try {
    const encoder = new TextEncoder();
    const hashBuffer = await subtle.digest("SHA-256", encoder.encode(hashContent));
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

// ─── HTML section parser ─────────────────────────────────────────────────────

export interface ParsedSections {
  requirements: string[];
  qualifications: string[];
  description: string;
}

/**
 * Split a posting's HTML description into requirements, qualifications, and the
 * full body.
 *
 * Regex over an HTML *string* rather than a DOM walk, because this runs on the
 * `description` field of a JSON-LD node — HTML embedded inside a JSON string,
 * with no `Document` in sight. That is also why this file stays DOM-free.
 *
 * The two heading patterns encode the vocabulary boards actually use for the
 * must-have / nice-to-have split. Matching only a heading immediately followed by
 * a list keeps prose paragraphs out of the bullet arrays; a posting that writes
 * its requirements as prose yields empty arrays and a full `description`, which
 * is the honest answer rather than a mangled one.
 */
export function parseHtmlSections(html: string): ParsedSections {
  const requirements: string[] = [];
  const qualifications: string[] = [];

  const reqPatterns =
    /(?:<(?:strong|b|h[1-6])[^>]*>)\s*(?:requirements?|responsibilities|key\s+skills?|must[\s-]+have|what\s+you(?:'ll|\s+will)\s+(?:do|bring|need)|certifications?\s+required|essential\s+(?:skills|qualifications))\s*(?:<\/(?:strong|b|h[1-6])>)/gi;

  const qualPatterns =
    /(?:<(?:strong|b|h[1-6])[^>]*>)\s*(?:qualifications?|preferred|nice[\s-]+to[\s-]+have|desired|bonus|additional\s+(?:skills|qualifications)|who\s+you\s+are)\s*(?:<\/(?:strong|b|h[1-6])>)/gi;

  extractListItems(html, reqPatterns, requirements);
  extractListItems(html, qualPatterns, qualifications);

  const description = stripHtml(html);

  return { requirements, qualifications, description };
}

/**
 * Collect `<li>` text from the first list following each match of
 * `headingPattern`, appending into `target`.
 *
 * `headingPattern` must carry the `g` flag — the loop relies on `lastIndex`
 * advancing, and a non-global regex would spin forever on the first match.
 *
 * Module-private: `parseHtmlSections` is the only caller, and the heading
 * vocabulary it pairs this with is what makes the output meaningful.
 */
function extractListItems(
  html: string,
  headingPattern: RegExp,
  target: string[],
): void {
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(html)) !== null) {
    const afterHeading = html.slice(match.index + match[0].length);
    const listMatch = afterHeading.match(/^[\s\S]*?<[uo]l[^>]*>([\s\S]*?)<\/[uo]l>/i);
    if (listMatch) {
      const itemPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let itemMatch: RegExpExecArray | null;
      while ((itemMatch = itemPattern.exec(listMatch[1])) !== null) {
        const text = stripHtml(itemMatch[1]).trim();
        if (text.length > 0) target.push(text);
      }
    }
  }
}

/**
 * Convert an HTML string to Markdown.
 *
 * The string-level counterpart to `htmlToMarkdown` in `./html-to-markdown.ts`,
 * which walks a real DOM. Both exist because the two inputs genuinely differ:
 * the DOM walker is more accurate and is used wherever an element is in hand,
 * while this one handles HTML that arrives as a JSON string value with no
 * `Document` available to parse it into.
 *
 * Markdown rather than plaintext for the reason given on `ExtractedPosting.body`:
 * list structure carries the requirements, and flattening it costs extracted terms.
 */
export function stripHtml(html: string): string {
  return (
    html
      // Headers → Markdown
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n\n# ${stripTags(c).trim()}\n\n`)
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n\n## ${stripTags(c).trim()}\n\n`)
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n\n### ${stripTags(c).trim()}\n\n`)
      .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => `\n\n#### ${stripTags(c).trim()}\n\n`)
      .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => `\n\n##### ${stripTags(c).trim()}\n\n`)
      .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => `\n\n###### ${stripTags(c).trim()}\n\n`)
      // Bold / italic
      .replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**")
      .replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*")
      // List items → Markdown bullets
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${stripTags(c).trim()}\n`)
      // Strip list wrapper tags
      .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
      // Block elements → line breaks
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Compress blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}
