// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// ATS public JSON API clients — fetch a job description as plaintext.
// These APIs are free, unauthenticated, and legally safe.

export type AtsPlatform =
  | "greenhouse"
  | "lever"
  | "workable"
  | "recruitee"
  | "ashby";

interface ParsedAtsUrl {
  platform: AtsPlatform;
  company: string;
  jobId: string;
}

// ─── URL parsers ──────────────────────────────────────────────────────────────

export function parseAtsUrl(url: string): ParsedAtsUrl | null {
  return (
    parseGreenhouseUrl(url) ||
    parseLeverUrl(url) ||
    parseWorkableUrl(url) ||
    parseRecruiteeUrl(url) ||
    parseAshbyUrl(url)
  );
}

function parseGreenhouseUrl(url: string): ParsedAtsUrl | null {
  const match = url.match(/boards\.greenhouse\.io\/(\w[\w-]*)\/jobs\/(\d+)/);
  return match
    ? { platform: "greenhouse", company: match[1], jobId: match[2] }
    : null;
}

function parseLeverUrl(url: string): ParsedAtsUrl | null {
  const match = url.match(/jobs\.lever\.co\/([\w-]+)\/([\da-f-]+)/);
  return match
    ? { platform: "lever", company: match[1], jobId: match[2] }
    : null;
}

function parseWorkableUrl(url: string): ParsedAtsUrl | null {
  const match = url.match(/apply\.workable\.com\/([\w-]+)\/j\/([A-Z0-9]+)/i);
  return match
    ? { platform: "workable", company: match[1], jobId: match[2] }
    : null;
}

function parseRecruiteeUrl(url: string): ParsedAtsUrl | null {
  const match = url.match(/([\w-]+)\.recruitee\.com\/o\/([\w-]+)/);
  return match
    ? { platform: "recruitee", company: match[1], jobId: match[2] }
    : null;
}

// Ashby job-board URLs: `jobs.ashbyhq.com/{token}/{uuid}` — `token` is the
// board slug (the public-API path component), `uuid` identifies the posting.
// UUID-strict on the tail so a non-UUID path falls through to "unsupported"
// instead of producing a 404 on the API.
function parseAshbyUrl(url: string): ParsedAtsUrl | null {
  const match = url.match(
    /jobs\.ashbyhq\.com\/([\w-]+)\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})/i,
  );
  return match
    ? { platform: "ashby", company: match[1], jobId: match[2] }
    : null;
}

// ─── Network ──────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT = 8_000; // 8s max

async function fetchWithTimeout(
  url: string,
  timeoutMs = FETCH_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Internal fetcher result shape ────────────────────────────────────────────

interface FetchedJd {
  title?: string;
  company?: string;
  descriptionHtml?: string;
  descriptionText?: string;
}

// ─── Platform fetchers ────────────────────────────────────────────────────────

async function fetchGreenhouseJob(
  company: string,
  jobId: string,
): Promise<FetchedJd> {
  const resp = await fetchWithTimeout(
    `https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${jobId}?questions=true`,
  );
  if (!resp.ok) throw new Error(`Greenhouse API ${resp.status}`);
  const data = await resp.json();
  return {
    title: data.title,
    company: data.company?.name || company,
    descriptionHtml: data.content,
  };
}

async function fetchLeverJob(
  company: string,
  jobId: string,
): Promise<FetchedJd> {
  const resp = await fetchWithTimeout(
    `https://api.lever.co/v0/postings/${company}/${jobId}`,
  );
  if (!resp.ok) throw new Error(`Lever API ${resp.status}`);
  const data = await resp.json();
  return {
    title: data.text,
    company: data.categories?.team || company,
    // Prefer plain text; fall back to HTML
    descriptionText: data.descriptionPlain,
    descriptionHtml: data.description,
  };
}

async function fetchWorkableJob(
  company: string,
  jobId: string,
): Promise<FetchedJd> {
  const resp = await fetchWithTimeout(
    `https://apply.workable.com/api/v1/widget/accounts/${company}`,
  );
  if (!resp.ok) throw new Error(`Workable API ${resp.status}`);
  const data = await resp.json();

  // Workable returns all jobs — find the matching one by shortcode (case-insensitive)
  const job = data.jobs?.find(
    (j: { shortcode: string }) =>
      j.shortcode?.toUpperCase() === jobId.toUpperCase(),
  );
  if (!job) throw new Error("Job not found in Workable listing");

  // Workable widget has no description body — description will fall back to title+company
  return {
    title: job.title,
    company: data.name || company,
  };
}

async function fetchRecruiteeJob(
  company: string,
  jobSlug: string,
): Promise<FetchedJd> {
  const resp = await fetchWithTimeout(
    `https://${company}.recruitee.com/api/offers`,
  );
  if (!resp.ok) throw new Error(`Recruitee API ${resp.status}`);
  const data = await resp.json();

  const offer = data.offers?.find(
    (o: { slug: string }) => o.slug === jobSlug,
  );
  if (!offer) throw new Error("Job not found in Recruitee listing");

  return {
    title: offer.title,
    company: offer.company_name || company,
    descriptionHtml: offer.description,
  };
}

// Ashby job-board API: a single GET returns the whole board's posting list.
// Public, no auth, CORS-open. Shape (relevant fields only):
//   { jobBoard: { name }, jobPostings: [{ id, title, descriptionHtml }] }
async function fetchAshbyJob(
  token: string,
  jobId: string,
): Promise<FetchedJd> {
  const resp = await fetchWithTimeout(
    `https://api.ashbyhq.com/posting-api/job-board/${token}`,
  );
  if (!resp.ok) throw new Error(`Ashby API ${resp.status}`);
  const data = await resp.json();

  const posting = data.jobPostings?.find(
    (p: { id: string }) => p.id === jobId,
  );
  if (!posting) throw new Error("Job not found in Ashby listing");

  return {
    title: posting.title,
    company: data.jobBoard?.name || token,
    descriptionHtml: posting.descriptionHtml,
  };
}

// ─── HTML → plaintext ─────────────────────────────────────────────────────────

/**
 * Resolve a numeric character reference's code point to its character, leaving
 * the original `&#…;` text untouched when the value isn't a valid Unicode
 * scalar (out of the 0–0x10FFFF range, or a lone surrogate). This keeps a
 * malformed/overflowing reference visible rather than throwing or emitting U+FFFD.
 *
 * Code point 0xA0 (non-breaking space) is folded to a regular space so numeric
 * `&#160;` / `&#xA0;` references match the named `&nbsp;` decode path.
 *
 * Non-whitespace C0 control characters and DEL (e.g. `&#0;`, `&#7;`, `&#8;`) are
 * dropped — decoding them would inject invisible control bytes into the matched
 * plaintext. Tab / LF / CR are kept as legitimate whitespace (the line-collapse
 * pass downstream normalizes them).
 */
function decodeCodePoint(original: string, codePoint: number): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return original;
  }
  if (codePoint === 0xa0) return " ";
  if (
    (codePoint < 0x20 &&
      codePoint !== 0x09 &&
      codePoint !== 0x0a &&
      codePoint !== 0x0d) ||
    codePoint === 0x7f
  ) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}

export function htmlToPlaintext(html: string): string {
  // Strip <style> and <script> blocks
  let text = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  // Convert block-end tags to newlines
  text = text.replace(/<\/(p|li|div|tr)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common named HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Decode numeric character references (decimal &#160; and hex &#x2013;).
  // Generators such as Lever lean on these for typographic punctuation; left
  // raw they leak `&#…;` fragments into the JD-match passes. Malformed refs
  // like `&#x;` never match (the digit group requires 1+); out-of-range or
  // surrogate code points are preserved by decodeCodePoint.
  text = text
    .replace(/&#(\d+);/g, (m, n: string) => decodeCodePoint(m, parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) =>
      decodeCodePoint(m, parseInt(h, 16)),
    );

  // Collapse trailing spaces on each line, then collapse 3+ newlines to 2
  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ─── Fetcher dispatch table ───────────────────────────────────────────────────

const FETCHERS: Record<
  AtsPlatform,
  (company: string, jobId: string) => Promise<FetchedJd>
> = {
  greenhouse: fetchGreenhouseJob,
  lever: fetchLeverJob,
  workable: fetchWorkableJob,
  recruitee: fetchRecruiteeJob,
  ashby: fetchAshbyJob,
};

// ─── Unsupported-host classifier ──────────────────────────────────────────────

/**
 * Hosts the UI knows are out of reach client-side, with the user-facing
 * reason. Drives the tailored fallback message in `JdInput` so the user
 * gets "LinkedIn blocks automated reads" instead of a generic "couldn't
 * fetch" when their paste target is a well-known closed surface.
 *
 * `null` means "we don't recognise this host" — the UI falls back to its
 * generic unsupported copy.
 *
 * Why these five:
 *   - LinkedIn / Indeed / Glassdoor — Cloudflare + JA3/TLS fingerprinting +
 *     HTTP 999 + datacenter-IP blocklists; no browser header trick gets past
 *     these. Acknowledged closed surfaces (per #72 research).
 *   - Workday — has a JSON endpoint but does NOT send CORS `*`, so the
 *     browser blocks the response. Different reason from the others; same
 *     paste-fallback outcome.
 *   - Wellfound (formerly AngelList) — heavy bot-protection, paste-only.
 */
export type UnsupportedHost =
  | "linkedin"
  | "indeed"
  | "glassdoor"
  | "workday"
  | "wellfound";

const UNSUPPORTED_HOST_PATTERNS: ReadonlyArray<readonly [UnsupportedHost, RegExp]> = [
  ["linkedin", /(^|\.)linkedin\.com\b/i],
  ["indeed", /(^|\.)indeed\.com\b/i],
  ["glassdoor", /(^|\.)glassdoor\.(com|co\.[a-z]{2})\b/i],
  ["workday", /\bmyworkdayjobs\.com\b|\bworkday\.com\b/i],
  ["wellfound", /(^|\.)wellfound\.com\b|(^|\.)angel\.co\b/i],
];

/**
 * Match a URL string against the closed-surface host list. Returns the
 * canonical id when the URL belongs to a known-unsupported host, else null.
 * Pure — no network, safe to call repeatedly.
 *
 * Robust against malformed URLs: tries `new URL(...)` first; falls back to a
 * raw substring scan so a bare `linkedin.com/jobs/view/123` (no scheme) still
 * classifies.
 */
export function classifyUnsupportedHost(url: string): UnsupportedHost | null {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  for (const [id, pattern] of UNSUPPORTED_HOST_PATTERNS) {
    if (pattern.test(host)) return id;
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a job description as plaintext from a supported ATS URL.
 *
 * Two distinct failure modes, surfaced separately so the caller can route to
 * the right user-facing copy and the right telemetry bucket (#75):
 *   - **`null`** — the URL did not parse to any supported ATS host; the
 *     callee should consult `classifyUnsupportedHost` to pick the message.
 *     No network call was made.
 *   - **throws** — the URL parsed, but the platform's API call failed
 *     (non-2xx, network error, JSON parse, "job not found"). The thrown
 *     error preserves the underlying failure on its `cause`. The caller's
 *     catch is the `network_error` funnel state.
 *
 * Analytics are wired in the caller (see `JdInput`), not here, so this
 * module stays pure (#75).
 */
export async function fetchJdFromUrl(
  url: string,
): Promise<{ text: string; title?: string; company?: string; source: AtsPlatform } | null> {
  const parsed = parseAtsUrl(url);
  if (!parsed) return null;

  const result = await FETCHERS[parsed.platform](parsed.company, parsed.jobId);

  const text =
    result.descriptionText ??
    (result.descriptionHtml ? htmlToPlaintext(result.descriptionHtml) : null) ??
    [result.title, result.company].filter(Boolean).join(" — ");

  return {
    text,
    title: result.title,
    company: result.company,
    source: parsed.platform,
  };
}
