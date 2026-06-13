// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// ATS public JSON API clients — fetch a job description as plaintext.
// These APIs are free, unauthenticated, and legally safe.

export type AtsPlatform = "greenhouse" | "lever" | "workable" | "recruitee";

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
    parseRecruiteeUrl(url)
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

// ─── HTML → plaintext ─────────────────────────────────────────────────────────

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

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

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
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a job description as plaintext from a supported ATS URL.
 * Returns null if the URL isn't a supported ATS or the API call fails.
 * Analytics capture is a separate intern task (#75) — not emitted here.
 */
export async function fetchJdFromUrl(
  url: string,
): Promise<{ text: string; title?: string; company?: string; source: AtsPlatform } | null> {
  const parsed = parseAtsUrl(url);
  if (!parsed) return null;

  try {
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
  } catch (err) {
    console.warn(`[fetch-jd] ${parsed.platform} fetch failed:`, err);
    return null;
  }
}
