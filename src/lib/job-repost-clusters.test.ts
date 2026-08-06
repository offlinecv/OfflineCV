// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Repost clusters (#754). The spine is the case the issue measured: a group of
 * same-company / same-title records spread over weeks is an employer re-listing
 * one role, not N-1 redundant rows, and merging it destroys the only trace of
 * the churn.
 *
 * Two properties carry the design and are asserted directly rather than
 * inferred from the examples:
 *
 *  1. **Never neither.** Every title-identical pairing at one company is either
 *     mergeable (`probable`) or inside a cluster. A pairing that got neither a
 *     merge offer nor an explanation would be the regression this whole change
 *     is written to avoid.
 *  2. **Nothing is written.** The module is derived-on-view; a stored verdict
 *     goes stale the moment a title is edited. Checked structurally against the
 *     source, the way `job-origin-reach.test.ts` checks its invariant, because
 *     "no call reaches `saveJob`" is a claim about the file and not about one
 *     run of it.
 *
 * Every company, title and URL below is invented. Minimal typed stubs over full
 * fixtures, the shape `contact.test.ts` and `job-duplicates.test.ts` use.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findRepostClusters,
  indexRepostClusters,
  isRepostSuppressed,
} from "./job-repost-clusters.ts";
import {
  REPOST_SPAN_DAYS,
  jobDuplicateConfidence,
  type JobDuplicatePair,
} from "./job-duplicates.ts";
import type { JobRecord } from "./storage/index.ts";

const DAY = 24 * 60 * 60 * 1000;
/** 2026-06-15T00:00:00Z — the start of the motivating group's span. */
const JUN_15 = Date.UTC(2026, 5, 15);

function job(over: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    createdAt: JUN_15,
    updatedAt: JUN_15,
    title: "Head of Engineering",
    company: "Bellhaven Talent",
    status: "interested",
    ...over,
  };
}

/** The measured case, generalised: `count` records of one role at one company,
 *  the first and last `spanDays` apart. */
function relisted(count: number, spanDays: number): JobRecord[] {
  return Array.from({ length: count }, (_unused, i) =>
    job({
      id: `r${i}`,
      createdAt: JUN_15 + Math.round((spanDays * DAY * i) / (count - 1)),
    }),
  );
}

describe("findRepostClusters: the motivating group", () => {
  it("collapses 6 same-company/same-title records spanning 49 days into ONE cluster", () => {
    const clusters = findRepostClusters(relisted(6, 49));
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(6);
    expect(clusters[0].ids).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
    expect(clusters[0].spanDays).toBe(49);
    expect(clusters[0].firstSeen).toBe(JUN_15);
    expect(clusters[0].lastSeen).toBe(JUN_15 + 49 * DAY);
  });

  it("names the company and title in the records' own spelling, not the normalised key", () => {
    const clusters = findRepostClusters([
      job({ id: "a", company: "Bellhaven Talent, Inc.", title: "Head of Engineering" }),
      job({
        id: "b",
        company: "bellhaven talent",
        title: "head of engineering",
        createdAt: JUN_15 + 49 * DAY,
      }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].company).toBe("Bellhaven Talent, Inc.");
    expect(clusters[0].title).toBe("Head of Engineering");
  });

  it("does NOT cluster a double-capture — two records three days apart", () => {
    expect(findRepostClusters(relisted(2, 3))).toEqual([]);
  });

  it("clusters every member once the GROUP span exceeds the boundary, including the close pairs inside it", () => {
    // 0 / 15 / 30 days. The (0,15) and (15,30) pairings are each inside the
    // span and merge-worthy on their own, but the group is churn — so all three
    // belong to the cluster and none of them keeps an offer.
    const clusters = findRepostClusters([
      job({ id: "a", createdAt: JUN_15 }),
      job({ id: "b", createdAt: JUN_15 + 15 * DAY }),
      job({ id: "c", createdAt: JUN_15 + 30 * DAY }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].ids).toEqual(["a", "b", "c"]);
  });
});

describe("findRepostClusters: the boundary is REPOST_SPAN_DAYS, inclusive", () => {
  it("a span of exactly REPOST_SPAN_DAYS is still a double-capture", () => {
    expect(
      findRepostClusters([
        job({ id: "a", createdAt: JUN_15 }),
        job({ id: "b", createdAt: JUN_15 + REPOST_SPAN_DAYS * DAY }),
      ]),
    ).toEqual([]);
  });

  it("one millisecond past it is a repost", () => {
    expect(
      findRepostClusters([
        job({ id: "a", createdAt: JUN_15 }),
        job({ id: "b", createdAt: JUN_15 + REPOST_SPAN_DAYS * DAY + 1 }),
      ]),
    ).toHaveLength(1);
  });
});

describe("findRepostClusters: what must never cluster", () => {
  it("one record on its own is not a cluster", () => {
    expect(findRepostClusters([job({ id: "a" })])).toEqual([]);
  });

  it("the same title at two different companies is two roles", () => {
    expect(
      findRepostClusters([
        job({ id: "a", company: "Bellhaven Talent" }),
        job({ id: "b", company: "Northmoor Systems", createdAt: JUN_15 + 49 * DAY }),
      ]),
    ).toEqual([]);
  });

  it("two different titles at one company are two roles", () => {
    expect(
      findRepostClusters([
        job({ id: "a", title: "Head of Engineering" }),
        job({ id: "b", title: "Director of Finance", createdAt: JUN_15 + 49 * DAY }),
      ]),
    ).toEqual([]);
  });

  it("a blank company is missing evidence, not evidence of sameness", () => {
    expect(
      findRepostClusters([
        job({ id: "a", company: "" }),
        job({ id: "b", company: "", createdAt: JUN_15 + 49 * DAY }),
      ]),
    ).toEqual([]);
  });

  it("a blank title is likewise no grouping evidence", () => {
    expect(
      findRepostClusters([
        job({ id: "a", title: "" }),
        job({ id: "b", title: "", createdAt: JUN_15 + 49 * DAY }),
      ]),
    ).toEqual([]);
  });
});

describe("findRepostClusters: totality", () => {
  it("survives a record whose fields are not the types they claim", () => {
    // Reachable: `saveJob` writes whatever a caller supplies, and a restored
    // backup predates every field read here. A throw would take the whole
    // tracker render down.
    const hostile = { id: "b", status: "interested" } as unknown as JobRecord;
    Object.assign(hostile, {
      title: 42,
      company: null,
      createdAt: "not-a-number",
      updatedAt: undefined,
    });
    expect(() => findRepostClusters([job({ id: "a" }), hostile])).not.toThrow();
    // Nothing groups with it: its company and title are unreadable, so it is in
    // no bucket at all.
    expect(findRepostClusters([job({ id: "a" }), hostile])).toEqual([]);
  });

  it("clusters a group whose capture time is unreadable, and states no span for it", () => {
    // Proximity cannot vouch for a record with no usable `createdAt`, so it
    // cannot sit inside a mergeable group either — the cluster is what keeps
    // the pairing from falling between the two behaviours. The count is still
    // true; the span is not stated rather than printed as NaN.
    const broken = job({ id: "b" });
    Object.assign(broken, { createdAt: Number.NaN });
    const clusters = findRepostClusters([job({ id: "a" }), broken]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].spanDays).toBeUndefined();
    expect(clusters[0].firstSeen).toBeUndefined();
    expect(clusters[0].lastSeen).toBeUndefined();
  });

  it("reads an Infinity capture time as missing rather than as an infinite span", () => {
    const broken = job({ id: "b", createdAt: Number.POSITIVE_INFINITY });
    const clusters = findRepostClusters([job({ id: "a" }), broken]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].spanDays).toBeUndefined();
  });
});

describe("findRepostClusters: derived, never stored", () => {
  it("does not mutate the records it swept", () => {
    const jobs = relisted(6, 49);
    const before = structuredClone(jobs);
    findRepostClusters(jobs);
    expect(jobs).toEqual(before);
  });

  it("reports ids without minting, deriving or altering one", () => {
    const jobs = relisted(3, 49);
    const [cluster] = findRepostClusters(jobs);
    expect(cluster.ids).toEqual(jobs.map((each) => each.id));
  });

  it("the module reaches no write path — structural, so it cannot rot", () => {
    // The claim is about the FILE, not about one run of it: an added call to
    // `saveJob` would still pass every behavioural test above.
    const raw = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "job-repost-clusters.ts"),
      "utf8",
    );
    // Comments stripped first, for the reason `job-origin-reach.test.ts` strips
    // them on its drift half: the module DOCUMENTS that a merge cascades letters
    // through `mergeJobs`, and naming the function you are explaining you never
    // call is not a call. Only executable text can reach a write path.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // The strip must not have eaten the module — otherwise this passes by
    // having nothing left to find.
    expect(code).toContain("export function findRepostClusters");

    for (const write of [
      "saveJob",
      "putRecord",
      "deleteRecord",
      "softDeleteRecord",
      "clearStore",
      "updateJob",
      "mergeJobs",
    ]) {
      expect(code, `job-repost-clusters.ts must not call ${write}`).not.toContain(write);
    }
    // ...and it takes only the TYPE from storage, never the module's runtime.
    expect(code).toContain('import type { JobRecord } from "./storage/index.ts"');
  });
});

describe("indexRepostClusters", () => {
  it("maps every member to the one cluster object", () => {
    const clusters = findRepostClusters(relisted(6, 49));
    const byJobId = indexRepostClusters(clusters);
    expect(byJobId.size).toBe(6);
    for (const id of clusters[0].ids) expect(byJobId.get(id)).toBe(clusters[0]);
  });

  it("leaves an unclustered record out of the map entirely", () => {
    const byJobId = indexRepostClusters(findRepostClusters(relisted(2, 3)));
    expect(byJobId.size).toBe(0);
  });
});

describe("isRepostSuppressed: cluster membership outranks inference, URL identity outranks it", () => {
  const byJobId = indexRepostClusters(findRepostClusters(relisted(6, 49)));

  function pair(
    a: string,
    b: string,
    confidence: JobDuplicatePair["confidence"],
  ): JobDuplicatePair {
    return { a, b, confidence };
  }

  it("withholds a `probable` merge between two members of one cluster", () => {
    expect(isRepostSuppressed(pair("r0", "r1", "probable"), byJobId)).toBe(true);
  });

  it("KEEPS a `certain` merge between two members of one cluster", () => {
    // Six reposts are six different postings with six different URLs, so two of
    // them sharing one URL is a genuine double-capture of a single posting —
    // the one correct offer in the group, and suppressing it would hide it.
    expect(isRepostSuppressed(pair("r0", "r1", "certain"), byJobId)).toBe(false);
  });

  it("keeps a `certain` merge that reaches OUT of the cluster", () => {
    expect(isRepostSuppressed(pair("r0", "elsewhere", "certain"), byJobId)).toBe(false);
  });

  it("keeps a `probable` merge whose other side is in no cluster", () => {
    expect(isRepostSuppressed(pair("r0", "elsewhere", "probable"), byJobId)).toBe(false);
  });

  it("keeps a `probable` merge across two DIFFERENT clusters", () => {
    const two = indexRepostClusters(
      findRepostClusters([
        ...relisted(2, 49),
        job({ id: "s0", title: "Staff Platform Engineer" }),
        job({
          id: "s1",
          title: "Staff Platform Engineer",
          createdAt: JUN_15 + 49 * DAY,
        }),
      ]),
    );
    expect(two.get("r0")?.key).not.toBe(two.get("s0")?.key);
    expect(isRepostSuppressed(pair("r0", "s0", "probable"), two)).toBe(false);
  });

  it("suppresses nothing against an empty index", () => {
    const empty = indexRepostClusters([]);
    expect(isRepostSuppressed(pair("r0", "r1", "probable"), empty)).toBe(false);
  });
});

describe("the property the two modules share: never neither", () => {
  it("every title-identical pairing is mergeable OR clustered, across the measured span range", () => {
    // The separation distribution the issue measured runs 0d…124d; these walk
    // it, plus the boundary itself from both sides.
    const spans = [0, 1, 3, 13, REPOST_SPAN_DAYS, REPOST_SPAN_DAYS + 1, 30, 40, 49, 124];
    for (const days of spans) {
      const a = job({ id: "a", createdAt: JUN_15 });
      const b = job({ id: "b", createdAt: JUN_15 + days * DAY });
      const mergeable = jobDuplicateConfidence(a, b) === "probable";
      const byJobId = indexRepostClusters(findRepostClusters([a, b]));
      const clustered =
        byJobId.get("a") !== undefined && byJobId.get("a") === byJobId.get("b");
      expect(mergeable || clustered, `${days}d apart fell into neither`).toBe(true);
      // ...and never both, for a pairing whose only evidence is proximity.
      expect(mergeable && clustered, `${days}d apart landed in both`).toBe(false);
    }
  });
});
