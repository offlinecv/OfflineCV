// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// The vocabulary for job-posting extraction: what a posting page yields, and
// what an extractor must implement to yield it.
//
// This lane exists because JD extraction was forked across three consumers —
// this app, the `job-hunt` skill (which described extraction as English prose
// over string sentinels), and the browser extension. `src/lib/storage/job-url.ts`
// already established the pattern this follows: one implementation of a rule
// that several producers must agree on, so they converge instead of drifting.
//
// `ExtractedPosting` is deliberately NOT `JobRecord`. `JobRecord` is a public
// capture contract with a version number and a compile-enforced field-rule map;
// this type is an internal extraction result that changes whenever the
// extractors improve. A single `toJobRecord()` mapper is the only bridge, so an
// extractor change can never silently bump a public contract.

/**
 * Which strategy produced a posting, in the order they are attempted.
 *
 * The ladder is ordered by trust, not convenience. `schema_org` is a publisher's
 * own machine-readable declaration and is site-agnostic; a per-host adapter is a
 * guess about someone else's markup that breaks when they redesign. So a host
 * adapter is the LAST resort, never the first — most modern boards ship a JSON-LD
 * `JobPosting` and need no host-specific code at all.
 *
 * The upstream implementation carried a fifth `llm` tier. It is deliberately
 * omitted: this repo has an on-device WebLLM lane, but wiring it in is scope
 * creep, and a non-deterministic tier under a deterministic one would make
 * extraction results irreproducible across runs.
 */
export type ExtractionTier =
  | "schema_org"
  | "ats_api"
  | "dom_metadata"
  | "ats_extractor";

/**
 * Bumped whenever extraction changes materially enough that a stored result is
 * no longer comparable to a fresh one. Same idea as `ATS_SCORE_ALGO_VERSION` in
 * `src/lib/score/score.ts`: a cached extraction stamped with an older version is
 * treated as stale and re-extracted rather than trusted.
 *
 * Carried over from the upstream implementation at its then-current value, so
 * results already stamped by that code remain correctly comparable.
 *
 * `10` (#725): both halves of a result moved. `parseLinkedInTitle` stopped
 * splitting a title at a dash inside brackets or inside a hyphenated token, so a
 * title carrying a comp band extracts whole where it was previously truncated;
 * and `pruneNonPosting` began dropping a list whose every item links to another
 * posting, so `body` loses a search-results rail it used to carry. A version 9
 * extraction of either page shape is not comparable to a version 10 one.
 */
export const EXTRACTION_ALGORITHM_VERSION = 10;

/**
 * What a job-posting page yields. Everything except `title` and `company` is
 * optional, because every field below is absent from some real posting — a
 * partially-populated result is the normal case, not a degraded one.
 *
 * Field values are passed through as the posting states them. Nothing here is
 * parsed into numbers, normalized to an enum, or reconciled against another
 * source: `salaryRange` stays `"$180k – $220k"` and `employmentType` stays
 * whatever schema.org string the publisher wrote. Interpreting those is a
 * consumer's job, and a lossy parse here would be unrecoverable downstream.
 */
export interface ExtractedPosting {
  title: string;
  company: string;
  location?: string;
  workModel?: string;

  /**
   * The job description as Markdown.
   *
   * Markdown rather than plaintext because list structure carries the
   * requirements, and flattening it measurably costs extracted terms: on a real
   * posting, a 489-character flattened summary yielded 0 extractable skill terms
   * and no fit rating at all, while the same job's 8000-character structured
   * body yielded 26 terms. `src/lib/job-search/rate-saved-jobs.ts` treats a
   * record with no extractable terms as *not rated* rather than rated zero, so a
   * weak body makes a saved job silently vanish from the rated set.
   *
   * Named `body` rather than the upstream `rawText` because it is neither raw
   * nor incidental — it is the field the fit rating actually consumes.
   */
  body: string;

  /** First ~200 characters of `body`, for list rows that must not render it all. */
  descriptionPreview: string;

  /** The ATS platform this posting appears to be hosted on, when detectable. */
  atsDetected?: string;

  // ─── Extraction metadata — internal, never crosses into `JobRecord` ───────

  extractionTier: ExtractionTier;
  jobId?: string;
  /** ISO date. A snapshot of the posting's age at capture; it only decays. */
  datePosted?: string;
  /** ISO date — the posting's own declared expiry, where it declares one. */
  validThrough?: string;
  /** schema.org enum string (`FULL_TIME`, …), passed through unvalidated. */
  employmentType?: string;
  salaryRange?: string;
  requirements?: string[];
  qualifications?: string[];
  /** SHA-256 over the JSON-LD fields that matter, for change detection. */
  structuredDataHash?: string;
  /** The original JSON-LD node, passed through untouched. */
  schemaOrgRaw?: Record<string, unknown>;
  /** `EXTRACTION_ALGORITHM_VERSION` at the time this result was produced. */
  algorithmVersion?: number;
  /** An external apply link discovered on an aggregator page. */
  applyUrl?: string;
  /**
   * The canonical ATS-hosted URL behind an aggregator listing, e.g.
   * `boards.greenhouse.io/acme/jobs/123` found from a LinkedIn page.
   *
   * This is what lets the same posting found via LinkedIn, via Indeed, and on
   * the company's own board collapse to one record instead of three. Discovering
   * a canonical URL is not applying to anything.
   */
  atsUrl?: string;
}

/**
 * A per-host extraction strategy.
 *
 * `matches` is separate from `extract` so the dispatcher can ask "is this yours?"
 * without paying for extraction, and so a host adapter can decline a page that
 * merely lives on its domain (a board's search results page, say).
 *
 * Both take a `Document` rather than a string: the whole point of this lane is
 * that structure is the signal. A sentinel over flattened text cannot express
 * "drop this subtree", which is the operation that actually matters — dropping a
 * block of third-party names off a posting page, for instance.
 *
 * `extract` returns `null`, never a partially-populated object, when the page is
 * not one it can read. A half-filled result is worse than none: it looks like a
 * successful extraction to every caller downstream.
 */
export interface ATSExtractor {
  name: string;
  matches(url: URL, doc: Document): boolean;
  extract(doc: Document, url: URL): ExtractedPosting | null;
}
