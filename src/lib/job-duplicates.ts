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
 * Every field is read through {@link text} / {@link epochMs} / an
 * `Array.isArray` guard rather than trusted from the type. Records reach the
 * `jobs` store through a deliberately permissive write (`saveJob`) and from a
 * backup file that may predate any field here, so a record whose `title` is not
 * a string is reachable — and this function runs on every tracker render. It
 * degrades to "no evidence", never to a throw.
 *
 * ## Company + title alone is not evidence (#754)
 *
 * Measured against a real 541-record library: 523 records carry no `jdText` at
 * all, so the `possible` tier — the only one that reads a description — can
 * never fire, and every merge the tracker offered came from title string
 * equality inside one company bucket. That is not a threshold to tune; it is a
 * destructive affordance resting on an inference. So an identical title now
 * needs one CORROBORATING fact ({@link corroborates}) before it reaches
 * `probable`, and resolves to {@link JobDuplicateConfidence} `title-only`
 * otherwise — below {@link isActionableDuplicate}, so nothing offers a merge on
 * it. `job-repost-clusters.ts` is what then speaks for those pairings.
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
 * - `probable` — same normalised company AND same normalised title, AND one
 *   corroborating fact ({@link corroborates}). Still inference — a company
 *   really can post two identically-titled roles — but no longer inference from
 *   a single string.
 * - `possible` — same company, similar title, overlapping description. Weak by
 *   construction, and deliberately below the bar {@link isActionableDuplicate}
 *   sets, so no merge affordance is ever offered on it.
 * - `title-only` — same company and same normalised title, and nothing else
 *   (#754). The tier that separates a double-capture from an employer reposting
 *   one role for four months: both used to read as `probable` and both got the
 *   same **Merge** button, and merging the second kind destroys the record of
 *   the churn. Weakest of the four and below the actionable bar, so it renders
 *   no offer; `job-repost-clusters.ts` is what speaks for these pairings.
 */
export type JobDuplicateConfidence = "certain" | "probable" | "possible" | "title-only";

const CONFIDENCE_RANK: Record<JobDuplicateConfidence, number> = {
  "title-only": 1,
  possible: 2,
  probable: 3,
  certain: 4,
};

/**
 * Whether a confidence is strong enough to put a *merge* in front of the user.
 * `probable` and up. `possible` and `title-only` are computed, and are worth
 * having as distinct answers, but offering a destructive action on "same
 * company, similar title" — or on a bare title string — would invert the
 * asymmetry this whole module is written around.
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far apart in time two captures of one company+title may sit and still be
 * read as two captures of ONE posting rather than a repost of it.
 *
 * **One constant, two uses**, and that is the point of it living here: it is
 * both the last corroborating signal in {@link corroborates} and the boundary
 * `job-repost-clusters.ts` forms a cluster on. A pair is therefore *either*
 * mergeable *or* clustered and never neither — two separately-tuned numbers
 * would open a band where a pairing gets no merge offer and no explanation.
 * That module imports this value and {@link withinRepostSpan} rather than
 * restating either, for the same reason it imports {@link jobCompanyTitleKey}:
 * the grouping and the boundary must be one definition or the two surfaces
 * disagree about the same pair.
 *
 * **21 days.** Measured separation between the two records of each pairing that
 * company+title alone used to call `probable`, over 98 pairs in a real library:
 * min 0d, p25 3d, median 13d, p75 40d, max 124d — 13 pairs same-day, 29 more
 * than 30 days apart. Those ends are different phenomena. A same-day pair is a
 * double-capture (the capture ran twice, or an aggregator and the employer's own
 * board were both saved) and merging it is right; a 124-day pair is an employer
 * re-listing a role that never filled, and merging it destroys the only trace of
 * that. Proximity has to be a signal precisely BECAUSE the common captured
 * record carries title + company + url and nothing else: drop it and those 13
 * real duplicates lose their merge button too, and the feature stops working for
 * the case it exists for.
 *
 * A guess in the same sense {@link SIMILAR_TITLE} is — but not with the same
 * bounded blast radius, because this one gates a destructive offer. Raising it
 * offers more merges; lowering it offers fewer. The asymmetry says which
 * direction is the cheap one.
 */
export const REPOST_SPAN_DAYS = 21;

const REPOST_SPAN_MS = REPOST_SPAN_DAYS * DAY_MS;

/**
 * Were these two records captured close enough together for proximity to
 * corroborate? Takes `unknown` and is total: a capture time that is not a finite
 * number is missing evidence, so the answer is `false` — never a throw, and
 * never a silent "yes" off a `NaN` comparison.
 */
export function withinRepostSpan(a: unknown, b: unknown): boolean {
  return Math.abs(epochMs(a) - epochMs(b)) <= REPOST_SPAN_MS;
}

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

/** A timestamp field's value if it is really a finite number, otherwise `NaN` —
 *  which every comparison below answers `false` to, which is the "no evidence"
 *  reading. `Number.isFinite` and not `typeof`, so an `Infinity` or a `NaN` that
 *  survived a JSON round-trip is missing evidence rather than a span of
 *  infinity. */
function epochMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
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
  /** Filled by {@link jdNormalisedOf} on first use, for the same reason
   *  {@link jdTokens} is: only a pair that already agrees on company and title
   *  ever asks. */
  jdNormalised?: string;

  // ─── Corroborating facts (#754) ───────────────────────────────────────────
  // Read through the same guards as everything above: a record can arrive from a
  // backup that predates any of these fields, or from a producer that wrote the
  // wrong type into one. A field that is not a string reads as absent, which is
  // "no evidence" and therefore no merge offer — the safe direction.

  /** Normalised {@link JobRecord.datePosted} — the date the POSTING declares,
   *  not when we saw it. */
  datePosted: string;
  /** Normalised {@link JobRecord.location}. */
  location: string;
  /** Normalised {@link JobRecord.salaryRange}. */
  salaryRange: string;
  /** Epoch ms this record was first written, or `NaN` when it carries no usable
   *  one. NOT `updatedAt`: editing a note bumps that, and "when did this arrive"
   *  is the question proximity answers. */
  createdAt: number;
}

function jdTokensOf(print: Fingerprint): Set<string> {
  print.jdTokens ??= tokenSet(print.jdText, DESCRIPTION_TOKEN_MIN_LENGTH);
  return print.jdTokens;
}

function jdNormalisedOf(print: Fingerprint): string {
  print.jdNormalised ??= normalise(print.jdText);
  return print.jdNormalised;
}

/**
 * Is there any fact BESIDES the title backing "these two are one posting"?
 *
 * Only ever asked of a pair that already agrees on the normalised company and
 * has byte-identical normalised titles, and the answer is what lifts that pair
 * from `title-only` to `probable` — i.e. what puts a **Merge** in front of the
 * user. So every signal here is an equality on a fact a repost would plausibly
 * CHANGE, and each one is required non-empty: two records that both lack a
 * field agree about nothing.
 *
 * In rough order of strength:
 *
 *  1. **Identical description.** The strongest thing short of a shared URL —
 *     the six-record cluster that motivated #754 turned out to have byte-
 *     identical descriptions, which simply were never captured. Identity, not
 *     {@link OVERLAPPING_DESCRIPTION} containment: that threshold's docblock
 *     justifies itself by only ever gating a tier no affordance acts on, and
 *     promoting it to gate a destructive one would unbind exactly that.
 *  2. **The same declared `datePosted`.** A repost is a new posting with a new
 *     publication date; two captures of one posting quote the same one.
 *  3. **The same `location` AND the same `salaryRange`.** Conjunction, because
 *     either alone is nearly free — every role at a company shares "Remote (US)"
 *     and the bands repeat across a level.
 *  4. **Captured within {@link REPOST_SPAN_DAYS} of each other.** Weakest, and
 *     the only one that reaches the common captured record at all: a LinkedIn
 *     capture is title + company + url and nothing else, so without this the
 *     genuine same-day double-capture loses its merge offer along with the
 *     reposts. See {@link REPOST_SPAN_DAYS} for the measured distribution this
 *     is cut from.
 */
function corroborates(a: Fingerprint, b: Fingerprint): boolean {
  const jd = jdNormalisedOf(a);
  if (jd !== "" && jd === jdNormalisedOf(b)) return true;
  if (a.datePosted !== "" && a.datePosted === b.datePosted) return true;
  if (
    a.location !== "" &&
    a.location === b.location &&
    a.salaryRange !== "" &&
    a.salaryRange === b.salaryRange
  ) {
    return true;
  }
  return withinRepostSpan(a.createdAt, b.createdAt);
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
    datePosted: normalise(job.datePosted),
    location: normalise(job.location),
    salaryRange: normalise(job.salaryRange),
    createdAt: epochMs(job.createdAt),
  };
}

/**
 * The one key two records must share before company+title evidence is even
 * considered: normalised company, then normalised title, NUL-joined for the
 * reason {@link jobPairKey} is. `null` when either side is empty — a blank
 * company or a blank title is missing evidence, not evidence of sameness, and
 * without the guard every half-filled row would group with every other one.
 *
 * Exported because `job-repost-clusters.ts` groups on exactly this. Two
 * definitions of "the same role at the same company" would let a pairing be
 * `title-only` here and belong to no cluster there — the one gap the design
 * forbids, since such a pair would then get neither a merge offer nor an
 * explanation of why not.
 */
export function jobCompanyTitleKey(job: JobRecord): string | null {
  const company = normaliseCompany(job.company);
  const title = normalise(job.title);
  if (company === "" || title === "") return null;
  // NUL rather than a printable separator, because normalisation has already
  // collapsed punctuation to spaces: ("Acme", "Corp Dev") and ("Acme Corp",
  // "Dev") would otherwise share one key, and grouping two different roles is
  // how a merge gets offered on nothing.
  return `${company}\u0000${title}`;
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
  // An identical title is where the destructive offer used to come from with
  // nothing behind it (#754), so it resolves here and does NOT fall through to
  // the `possible` tier below: an identical title trivially clears
  // SIMILAR_TITLE, and letting it land on a tier gated by a threshold
  // documented as "a guess" would put the decision back where this change took
  // it from.
  if (a.title !== "" && a.title === b.title) {
    return corroborates(a, b) ? "probable" : "title-only";
  }
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
