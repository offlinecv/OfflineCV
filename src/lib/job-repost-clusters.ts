// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * job-repost-clusters — "is this one role the employer keeps re-listing?"
 * (#754). Pure, zero-storage, zero-UI, sibling of `job-duplicates.ts` and
 * `job-status-bucket.ts`, and testable at module scope for the same reason.
 *
 * ## Why a repost is not a duplicate
 *
 * Six saved records, one company, one title, spread over 49 days, are not five
 * redundant rows. They are the trace of a role that has been advertised since
 * June, which is precisely the thing a job seeker wants surfaced — and the
 * tracker used to answer it with five **Merge into this one** buttons per row.
 * Merging is destructive and cascades letters (`job-tracker.ts`'s `mergeJobs`),
 * so acting on that offer would have destroyed the churn signal outright.
 *
 * So this module says the other thing: it groups those records, states the
 * count and the span, and {@link isRepostSuppressed} withdraws the merge offer
 * for pairings inside a cluster. It never merges, never ranks, and never picks
 * a survivor — that is a user's click, and only ever on evidence this module
 * declines to weaken.
 *
 * ## Derived on VIEW, never stored
 *
 * The same rule `useJobDuplicates` and `useSavedJobRatings` follow: a stored
 * "these six are one repost cluster" verdict goes stale the moment a title is
 * edited, with nothing to invalidate it. Nothing here writes — no `JobRecord`
 * field is added, no call reaches `saveJob` / `putRecord` — and nothing here
 * reads or writes `id` beyond grouping by it and reporting which ids grouped.
 * An id is never derived, minted, or forked here.
 *
 * ## One boundary, shared with `job-duplicates.ts`
 *
 * Both the grouping key ({@link jobCompanyTitleKey}) and the time boundary
 * ({@link withinRepostSpan} / {@link REPOST_SPAN_DAYS}) are IMPORTED, never
 * restated. That is what makes the design's central property hold:
 *
 * > every title-identical pairing at one company is *either* mergeable *or*
 * > inside a repost cluster, and never neither.
 *
 * The proof is one line in each direction. A pairing is `title-only` only when
 * nothing corroborates it, and the last corroborating signal is capture
 * proximity — so a `title-only` pairing is two records more than
 * {@link REPOST_SPAN_DAYS} apart (or one with no usable capture time), which
 * makes its group's own span exceed the boundary, which is exactly
 * {@link findRepostClusters}' cluster test. Conversely a group inside the
 * boundary has every pairing corroborated by proximity, so every pairing in it
 * is `probable`. Two separately-tuned numbers would open a band where a pairing
 * gets no merge offer and no explanation of why not.
 *
 * ## Totality
 *
 * Same bar as `job-duplicates.ts`: a record can arrive from a backup predating
 * any field, so every value is guarded and a malformed one degrades to "no
 * evidence" rather than throwing. A member with no usable `createdAt` counts as
 * NOT within the span — the reading that keeps the property above true, and the
 * one that withholds a merge rather than offering one on a field nobody can
 * read.
 */

import {
  REPOST_SPAN_DAYS,
  jobCompanyTitleKey,
  withinRepostSpan,
  type JobDuplicatePair,
} from "./job-duplicates.ts";
import type { JobRecord } from "./storage/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One role a company has listed more than once over a span wider than
 * {@link REPOST_SPAN_DAYS}.
 *
 * Everything here is derived from the records handed in and none of it is
 * written back. `company` and `title` are the FIRST member's raw spellings
 * rather than the normalised key, because the key is a comparison artefact and
 * a row has to print something a user recognises.
 */
export interface JobRepostCluster {
  /** {@link jobCompanyTitleKey} for the group — stable across a re-sweep of the
   *  same library, so a row can key on it. Not an id and never stored. */
  key: string;
  /** The first member's `company`, verbatim. */
  company: string;
  /** The first member's `title`, verbatim. */
  title: string;
  /** Every member's `JobRecord.id`, in the caller's order. Grouping only: no
   *  id here is derived, minted, or written anywhere. */
  ids: readonly string[];
  /** `ids.length`, named because it is what the row states. Always >= 2. */
  count: number;
  /** Epoch ms of the earliest / latest usable capture time in the group, and
   *  the whole days between them. All three absent together when no member
   *  carries a usable `createdAt` — a cluster with a count worth stating and no
   *  span to state, which the row must render rather than print `NaN days`. */
  firstSeen?: number;
  lastSeen?: number;
  spanDays?: number;
}

/**
 * Group a library by {@link jobCompanyTitleKey}.
 *
 * Bucketed rather than quadratic, for the reason `findDuplicatePairs` is: the
 * caller is a tracker render over a library that reaches into the hundreds. A
 * record whose company or title is blank belongs to no bucket — that is missing
 * evidence, not evidence of sameness, and {@link jobCompanyTitleKey} is the one
 * place that decision is made.
 */
function bucketByCompanyTitle(
  jobs: readonly JobRecord[],
): Map<string, JobRecord[]> {
  const buckets = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const key = jobCompanyTitleKey(job);
    if (key === null) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(job);
    else buckets.set(key, [job]);
  }
  return buckets;
}

/**
 * The earliest and latest usable capture time across a group, and whether
 * EVERY member carried one.
 *
 * Only usable timestamps take part. A member with an unreadable one cannot be
 * vouched for by proximity, so `allUsable` false forces the cluster — the same
 * reading `corroborates` takes, which is what keeps a pairing from falling
 * between the two behaviours.
 *
 * `first`/`last` stay at their infinite seeds when nothing was readable, so
 * they are only meaningful once `allUsable` has been checked. That is the
 * contract {@link findRepostClusters} relies on and the reason all three come
 * back together rather than as two calls a caller could interleave wrongly.
 */
function readCapturedSpan(members: readonly JobRecord[]): {
  first: number;
  last: number;
  allUsable: boolean;
} {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let allUsable = true;
  for (const member of members) {
    const ms = member.createdAt;
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
      allUsable = false;
      continue;
    }
    if (ms < first) first = ms;
    if (ms > last) last = ms;
  }
  return { first, last, allUsable };
}

/**
 * Every repost cluster in one library.
 *
 * A bucket becomes a cluster when it holds at least two records AND they were
 * not all captured within {@link REPOST_SPAN_DAYS} of one another. Two records
 * saved three days apart are a double-capture, and `job-duplicates.ts` offers
 * the merge for them; only the spread-out group is churn.
 *
 * The grouping and the span read live in {@link bucketByCompanyTitle} and
 * {@link readCapturedSpan} so what remains here is only the cluster DECISION —
 * the one thing the module docblock's central property is proved against.
 */
export function findRepostClusters(jobs: readonly JobRecord[]): JobRepostCluster[] {
  const clusters: JobRepostCluster[] = [];
  for (const [key, members] of bucketByCompanyTitle(jobs)) {
    if (members.length < 2) continue;

    const { first, last, allUsable } = readCapturedSpan(members);
    if (allUsable && withinRepostSpan(first, last)) continue;
    // The span is stated only when it covers EVERY member. A partial span read
    // off the members that happened to be readable would understate the churn
    // it claims to measure, and the count alone is still true.
    const spanned = allUsable && first <= last;

    clusters.push({
      key,
      company: typeof members[0].company === "string" ? members[0].company : "",
      title: typeof members[0].title === "string" ? members[0].title : "",
      ids: members.map((member) => member.id),
      count: members.length,
      ...(spanned
        ? {
            firstSeen: first,
            lastSeen: last,
            spanDays: Math.round((last - first) / DAY_MS),
          }
        : {}),
    });
  }
  return clusters;
}

/**
 * The same clusters keyed by member id, which is the lookup every caller wants:
 * a row asks "am I in one", and {@link isRepostSuppressed} asks "are we both in
 * the same one". Each member maps to the SAME object, so the map costs one
 * entry per clustered record and nothing else.
 */
export function indexRepostClusters(
  clusters: readonly JobRepostCluster[],
): ReadonlyMap<string, JobRepostCluster> {
  const byJobId = new Map<string, JobRepostCluster>();
  for (const cluster of clusters) {
    for (const id of cluster.ids) byJobId.set(id, cluster);
  }
  return byJobId;
}

/**
 * Should this duplicate pairing's merge offer be withheld because the two
 * records are one employer's repeated listings?
 *
 * **The precedence rule, in one sentence: cluster membership outranks every
 * INFERRED tier and is outranked by URL identity.** Both halves are load-bearing
 * and neither is symmetric with the other:
 *
 *  - A `certain` pairing is never suppressed, even with both records inside one
 *    cluster. `certain` means the two URL sets intersect — somebody with more
 *    context than a parser recorded these as one page — and that is identity,
 *    not inference. Six reposts of a role are six DIFFERENT postings with six
 *    different URLs, so a shared URL inside a cluster is a genuine
 *    double-capture of one of them and its merge is exactly right. Suppressing
 *    it would hide the one correct offer in the group.
 *  - A `probable` pairing between two members of one cluster IS suppressed, even
 *    when something corroborated it. The corroboration says "these two records
 *    describe the same role"; the cluster says "this role has been listed over
 *    and over", and merging on the first claim destroys the evidence for the
 *    second. Merging is unrecoverable, so the claim that costs nothing to be
 *    wrong about wins.
 *
 * Checked at the PAIR level — both ids in the same cluster — rather than
 * "either record is clustered". Today a `probable` pairing implies both members share a
 * {@link jobCompanyTitleKey} and therefore one cluster, so the two readings
 * agree; stating the pair-level one keeps that agreement an observation rather
 * than a dependency, and keeps a `certain` pairing that reaches OUT of a cluster
 * visibly outside the rule.
 */
export function isRepostSuppressed(
  pair: JobDuplicatePair,
  byJobId: ReadonlyMap<string, JobRepostCluster>,
): boolean {
  if (pair.confidence === "certain") return false;
  const a = byJobId.get(pair.a);
  return a !== undefined && a.key === byJobId.get(pair.b)?.key;
}
