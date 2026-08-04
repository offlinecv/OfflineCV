// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-duplicates — "do these two tracked records look like the same posting?"
 * (#746). Pure, zero-storage, zero-UI: it reads two {@link JobRecord}s and
 * returns a confidence, and every caller decides for itself what to do with the
 * answer. Sibling of `job-status-bucket.ts`, and testable at module scope for
 * the same reason.
 *
 * ## Why this exists at all
 *
 * `deriveJobId` (`storage/job-url.ts`) is a pure function of the canonicalised
 * URL, and it refuses to guess beyond what cannot plausibly distinguish two
 * postings, because **under-merging is a duplicate the user can delete;
 * over-merging destroys a record.** An aggregator listing and the employer's own
 * ATS page for one job share no host, no path and no parameter, so no URL rule
 * can ever relate them and none should try. The missing piece was never a better
 * URL rule — it was any representation of "these two URLs are the same posting".
 * `JobRecord.aliasUrls` is that representation, and this module is what reads it.
 *
 * ## This module NEVER decides anything
 *
 * It reports evidence; it does not merge, write, or rank. The asymmetry above
 * forbids an automatic merge outright — this build has no evidence source strong
 * enough to overrule it — so the strongest thing a caller may do with a
 * {@link JobDuplicateConfidence} is *offer* a merge that a user then clicks.
 * Nothing here reads or writes `id`: an alias is display/dedupe evidence and
 * must never fork the id space.
 *
 * ## Totality
 *
 * Every field is read through {@link text} / an `Array.isArray` guard rather
 * than trusted from the type. Records reach the `jobs` store through a
 * deliberately permissive write (`saveJob`) and from a backup file that may
 * predate any field here, so a record whose `title` is not a string is
 * reachable — and this function runs on every tracker render. It degrades to
 * "no evidence", never to a throw.
 */

import { canonicalJobUrl } from "./storage/index.ts";
import type { JobRecord } from "./storage/index.ts";

/**
 * How strongly two records look like one posting.
 *
 * - `certain` — their URL sets intersect: one record's `url` is the other's, or
 *   appears in the other's `aliasUrls`. Somebody with more context than a URL
 *   parser (a user who merged, a producer that followed an "Apply" link) said
 *   these are the same page.
 * - `probable` — same normalised company AND same normalised title. Strong, but
 *   inference: a company really can post two identically-titled roles.
 * - `possible` — same company, similar title, overlapping description. Weak by
 *   construction, and deliberately below the bar {@link isActionableDuplicate}
 *   sets, so no merge affordance is ever offered on it.
 */
export type JobDuplicateConfidence = "certain" | "probable" | "possible";

const CONFIDENCE_RANK: Record<JobDuplicateConfidence, number> = {
  possible: 1,
  probable: 2,
  certain: 3,
};

/**
 * Whether a confidence is strong enough to put a *merge* in front of the user.
 * `probable` and up. A `possible` match is computed, and is worth having as a
 * distinct answer, but offering a destructive action on "same company, similar
 * title" would invert the asymmetry this whole module is written around.
 */
export function isActionableDuplicate(confidence: JobDuplicateConfidence): boolean {
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK.probable;
}

/**
 * Fraction of the SMALLER token set the two share. Containment rather than
 * Jaccard: "Senior Frontend Engineer" against a 900-word job description is a
 * containment of 1 and a Jaccard of ~0.003, and it is containment that says
 * what we mean — does the shorter text appear inside the longer one.
 */
function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / small.size;
}

/** Title-token containment at or above which two titles count as "similar".
 *  A guess, not a measurement — it only ever gates the `possible` tier, which
 *  no affordance acts on, so the cost of it being wrong is bounded to a value
 *  nothing renders. */
const SIMILAR_TITLE = 0.6;

/** Description-token containment at or above which two job descriptions count
 *  as overlapping. Same bounded blast radius as {@link SIMILAR_TITLE}. */
const OVERLAPPING_DESCRIPTION = 0.5;

/** Description tokens shorter than this are dropped before comparing: "a",
 *  "of", "to" appear in every posting ever written and would float the
 *  containment of two unrelated descriptions. Titles are NOT filtered this way —
 *  "QA" and "ML" are the whole signal in a title. */
const DESCRIPTION_TOKEN_MIN_LENGTH = 3;

/** Anything that is not a letter or a number, in any script. `\p{L}\p{N}` and
 *  not `a-z0-9`, so "Nestlé" and "楽天" normalise to themselves rather than to
 *  a stump. */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/** A field's value if it is really a string, otherwise the empty string — see
 *  the totality note in the module docblock. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Lowercased, punctuation-flattened, whitespace-collapsed. The one place
 *  "normalised" is defined for this module. */
function normalise(value: unknown): string {
  return text(value).toLowerCase().replace(NON_WORD, " ").trim();
}

function tokenSet(value: unknown, minLength: number): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalise(value).split(" ")) {
    if (token.length >= minLength) tokens.add(token);
  }
  return tokens;
}

/**
 * Trailing legal-form words dropped from a company name, so the ATS's
 * "Acme, Inc." and the aggregator's "Acme" are one company. Only ever stripped
 * from the END, where a legal form actually sits — a leading or interior match
 * ("Co-operative Bank") is a real word.
 *
 * Stripping widens what counts as the same company, which widens what can be
 * offered as a merge, so the list stays short and boring: only forms that are
 * legal suffixes and nothing else in ordinary company-name usage.
 */
const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "company",
  "gmbh",
  "plc",
  "ag",
  "bv",
  "nv",
  "pty",
  "pvt",
  "pte",
  "oy",
  "ab",
]);

function normaliseCompany(value: unknown): string {
  const words = normalise(value).split(" ").filter((word) => word.length > 0);
  // `> 1`, so a company whose whole name is a legal form ("Limited") keeps it
  // rather than normalising to the empty string, which would then match every
  // other blank-company record.
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/**
 * One record reduced to what a comparison needs. Built once per record per
 * sweep so {@link findDuplicatePairs} normalises N records instead of N²
 * pairs — at a few hundred saved jobs the difference is the whole cost.
 */
interface Fingerprint {
  id: string;
  /** Canonical form of `url`, or undefined when there is none to canonicalise. */
  canonicalUrl?: string;
  /** Canonical forms of `aliasUrls`. Entries that do not canonicalise are
   *  dropped: they can never match anything, and the capture contract refuses
   *  them at the boundary anyway (§9). */
  aliases: Set<string>;
  company: string;
  title: string;
  titleTokens: Set<string>;
  jdText: string;
  /** Filled by {@link jdTokensOf} on first use. Tokenising a job description is
   *  the one expensive step here and only the `possible` tier ever needs it, so
   *  a library where no pair has a similar title never pays for it. */
  jdTokens?: Set<string>;
}

function jdTokensOf(print: Fingerprint): Set<string> {
  print.jdTokens ??= tokenSet(print.jdText, DESCRIPTION_TOKEN_MIN_LENGTH);
  return print.jdTokens;
}

function fingerprint(job: JobRecord): Fingerprint {
  const aliases = new Set<string>();
  // `Array.isArray`, not `?? []`: a stored record's `aliasUrls` is only as
  // typed as whatever wrote it, and `for…of` over a non-iterable throws.
  if (Array.isArray(job.aliasUrls)) {
    for (const alias of job.aliasUrls) {
      const canonical = canonicalJobUrl(text(alias));
      if (canonical !== undefined) aliases.add(canonical);
    }
  }
  return {
    id: job.id,
    canonicalUrl: canonicalJobUrl(text(job.url)),
    aliases,
    company: normaliseCompany(job.company),
    title: normalise(job.title),
    titleTokens: tokenSet(job.title, 1),
    jdText: text(job.jdText),
  };
}

/**
 * Do the two records' URL sets intersect?
 *
 * Both directions of the alias check, plus the degenerate case where the two
 * records simply hold the same posting URL. That last one is not a new identity
 * rule and changes nothing about `deriveJobId`: it is the *existing* rule read
 * as evidence. Two records with one canonical URL are the same posting by the
 * capture contract's own definition (§2) — they only exist as two rows because
 * the tracker's own "Add a job" mints a UUID rather than deriving an id, so the
 * one duplicate a user can produce entirely inside this app would otherwise be
 * the one duplicate this module could not see.
 */
function sharesAUrl(a: Fingerprint, b: Fingerprint): boolean {
  if (a.canonicalUrl !== undefined && a.canonicalUrl === b.canonicalUrl) return true;
  if (a.canonicalUrl !== undefined && b.aliases.has(a.canonicalUrl)) return true;
  if (b.canonicalUrl !== undefined && a.aliases.has(b.canonicalUrl)) return true;

  // Intersecting alias sets (#746) — both records are aliases of a common third URL,
  // indicating they are views of the same underlying posting.
  for (const alias of a.aliases) {
    if (b.aliases.has(alias)) return true;
  }
  return false;
}

function compare(a: Fingerprint, b: Fingerprint): JobDuplicateConfidence | null {
  if (sharesAUrl(a, b)) return "certain";
  // An empty company is the common case for a half-filled record, not a match:
  // without this, every blank-company job would pair with every other one.
  if (a.company === "" || a.company !== b.company) return null;
  if (a.title !== "" && a.title === b.title) return "probable";
  if (containment(a.titleTokens, b.titleTokens) < SIMILAR_TITLE) return null;
  if (containment(jdTokensOf(a), jdTokensOf(b)) < OVERLAPPING_DESCRIPTION) return null;
  return "possible";
}

/**
 * How strongly `a` and `b` look like the same posting, or null for no evidence.
 *
 * Symmetric, and deliberately does NOT check that the two ids differ: "are
 * these the same posting" has an honest answer for a record compared with
 * itself, and it is the caller's business not to ask. {@link findDuplicatePairs}
 * never does.
 */
export function jobDuplicateConfidence(
  a: JobRecord,
  b: JobRecord,
): JobDuplicateConfidence | null {
  return compare(fingerprint(a), fingerprint(b));
}

/** One unordered pairing, with `a` < `b` so a pair has exactly one
 *  representation whichever side found it. */
export interface JobDuplicatePair {
  a: string;
  b: string;
  confidence: JobDuplicateConfidence;
}

function pushInto<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
}

/**
 * The one identity of an unordered pairing of two records: sorted, so a pair
 * has the same key whichever side found it, and NUL-joined — the separator
 * `JobTrackerStatusGroup` already picked, because an id here is whatever a
 * backup carried rather than necessarily a UUID, and a printable separator
 * would let `("a b", "c")` and `("a", "b c")` collide on one key.
 *
 * Exported because `job-duplicate-dismissals.ts` keys the user's "Not the
 * same" decisions on exactly this pairing, and two definitions of "the same
 * pair" would silently stop suppressing what the user dismissed.
 */
export function jobPairKey(a: string, b: string): string {
  return (a < b ? [a, b] : [b, a]).join("\u0000");
}

/** Record a pairing, keeping the strongest confidence when two passes find the
 *  same pair. */
function keepStrongest(
  found: Map<string, JobDuplicatePair>,
  x: Fingerprint,
  y: Fingerprint,
  confidence: JobDuplicateConfidence,
): void {
  const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
  const key = jobPairKey(a, b);
  const existing = found.get(key);
  if (existing && CONFIDENCE_RANK[existing.confidence] >= CONFIDENCE_RANK[confidence]) return;
  found.set(key, { a, b, confidence });
}

function indexByUrl(prints: readonly Fingerprint[]): Map<string, Fingerprint[]> {
  const byUrl = new Map<string, Fingerprint[]>();
  for (const print of prints) {
    if (print.canonicalUrl !== undefined) pushInto(byUrl, print.canonicalUrl, print);
  }
  return byUrl;
}

function findUrlPairs(
  prints: readonly Fingerprint[],
  byUrl: Map<string, Fingerprint[]>,
  found: Map<string, JobDuplicatePair>
): void {
  // Direct canonicalUrl matches
  for (const sharing of byUrl.values()) {
    for (let i = 0; i < sharing.length; i++) {
      for (let j = i + 1; j < sharing.length; j++) {
        keepStrongest(found, sharing[i], sharing[j], "certain");
      }
    }
  }

  // Canonical-alias intersections
  for (const print of prints) {
    for (const alias of print.aliases) {
      for (const other of byUrl.get(alias) ?? []) {
        if (other.id !== print.id) keepStrongest(found, print, other, "certain");
      }
    }
  }

  // Alias-alias intersections
  const byAlias = new Map<string, Fingerprint[]>();
  for (const print of prints) {
    for (const alias of print.aliases) {
      pushInto(byAlias, alias, print);
    }
  }
  for (const sharing of byAlias.values()) {
    for (let i = 0; i < sharing.length; i++) {
      for (let j = i + 1; j < sharing.length; j++) {
        if (sharing[i].id !== sharing[j].id) {
          keepStrongest(found, sharing[i], sharing[j], "certain");
        }
      }
    }
  }
}

function findCompanyPairs(
  prints: readonly Fingerprint[],
  found: Map<string, JobDuplicatePair>
): void {
  const byCompany = new Map<string, Fingerprint[]>();
  for (const print of prints) {
    if (print.company !== "") pushInto(byCompany, print.company, print);
  }
  for (const bucket of byCompany.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const confidence = compare(bucket[i], bucket[j]);
        if (confidence !== null) keepStrongest(found, bucket[i], bucket[j], confidence);
      }
    }
  }
}

/**
 * Every pairing in one library that looks like a duplicate, at any confidence.
 *
 * Indexed rather than quadratic, because the caller is a tracker render over a
 * library that reaches into the hundreds. Two passes, because the two kinds of
 * evidence have different reach:
 *
 *  - a shared URL relates records that may disagree about the company entirely
 *    (an aggregator's "Acme Corp" against the ATS's "Acme"), so it is found
 *    through a URL index over the whole library;
 *  - company+title evidence requires the companies to match by definition, so
 *    it only ever compares within one normalised-company bucket.
 *
 * A record whose company normalises empty is in no bucket and can still be
 * found by the URL pass, which is right: a blank company is missing evidence,
 * not evidence of difference.
 */
export function findDuplicatePairs(jobs: readonly JobRecord[]): JobDuplicatePair[] {
  const prints = jobs.map(fingerprint);
  const found = new Map<string, JobDuplicatePair>();

  const byUrl = indexByUrl(prints);
  findUrlPairs(prints, byUrl, found);
  findCompanyPairs(prints, found);

  return [...found.values()];
}
