// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useJobDuplicates (#746, #754). The three filters the hook applies on one pass,
 * proved where they meet rather than one at a time: only actionable tiers reach
 * a row, a pairing the user dismissed stays dismissed across a remount, and a
 * pairing inside a repost cluster loses its merge offer while a shared-URL
 * pairing inside the same cluster keeps one.
 *
 * The suppression is the acceptance criterion this file exists for: six records
 * of one role spread over 49 days used to hand the tracker thirty **Merge**
 * offers, and every one of them was a destructive action on an employer's
 * repost.
 *
 * Exercised through a probe component, the pattern `useJobLetters.test.tsx`
 * uses. No `fake-indexeddb`: this hook reads nothing but its arguments and
 * localStorage. Every company and URL below is invented.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJobDuplicates, type JobDuplicates } from "./useJobDuplicates.ts";
import {
  findRepostClusters,
  indexRepostClusters,
  type JobRepostCluster,
} from "../lib/job-repost-clusters.ts";
import type { JobRecord } from "../lib/storage/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const DAY = 24 * 60 * 60 * 1000;
const JUN_15 = Date.UTC(2026, 5, 15);

let container: HTMLElement;
let root: Root;
let latest: JobDuplicates | undefined;

function Probe({
  jobs,
  reposts,
}: {
  jobs: readonly JobRecord[];
  reposts?: ReadonlyMap<string, JobRepostCluster>;
}) {
  latest = useJobDuplicates(jobs, reposts);
  return null;
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  latest = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

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

/** Six records of one role, first and last 49 days apart — the shape of the
 *  group the issue measured. */
function relisted(): JobRecord[] {
  return Array.from({ length: 6 }, (_unused, i) =>
    job({ id: `r${i}`, createdAt: JUN_15 + Math.round((49 * DAY * i) / 5) }),
  );
}

/** Total merge offers across every row — the number that used to be 30. */
function offerCount(): number {
  let total = 0;
  for (const list of latest?.byJobId.values() ?? []) total += list.length;
  return total;
}

function mount(jobs: readonly JobRecord[], reposts?: ReadonlyMap<string, JobRepostCluster>) {
  act(() => root.render(<Probe jobs={jobs} reposts={reposts} />));
}

describe("useJobDuplicates: a repost cluster withdraws the merge offer (#754)", () => {
  it("offers merges on the 49-day group when no clusters are passed", () => {
    // The pre-suppression baseline, so the assertion below cannot pass by the
    // pairings simply never existing. Records less than REPOST_SPAN_DAYS apart
    // are still corroborated by proximity, so the group is not silent.
    mount(relisted());
    expect(offerCount()).toBeGreaterThan(0);
  });

  it("withdraws every one of them once the clusters are passed", () => {
    const jobs = relisted();
    mount(jobs, indexRepostClusters(findRepostClusters(jobs)));
    expect(offerCount()).toBe(0);
    expect(latest?.byJobId.size).toBe(0);
  });

  it("keeps a shared-URL merge between two members of the same cluster", () => {
    // `certain` is identity, not inference: six reposts are six URLs, so two
    // records sharing one is a genuine double-capture of a single posting and
    // its merge is the one correct offer in the group.
    const jobs = relisted();
    const url = "https://boards.example.com/bellhaven/jobs/4012345";
    jobs[0] = { ...jobs[0], url };
    jobs[5] = { ...jobs[5], url: `${url}?utm_source=li` };
    mount(jobs, indexRepostClusters(findRepostClusters(jobs)));
    expect(latest?.byJobId.get("r0")).toEqual([
      { job: jobs[5], confidence: "certain" },
    ]);
    expect(latest?.byJobId.get("r5")).toEqual([
      { job: jobs[0], confidence: "certain" },
    ]);
    // ...and nothing else in the group regained one.
    expect(offerCount()).toBe(2);
  });

  it("leaves a double-capture outside any cluster alone", () => {
    const jobs = [
      job({ id: "a", createdAt: JUN_15 }),
      job({ id: "b", createdAt: JUN_15 + 3 * DAY }),
    ];
    mount(jobs, indexRepostClusters(findRepostClusters(jobs)));
    expect(latest?.byJobId.get("a")).toEqual([{ job: jobs[1], confidence: "probable" }]);
    expect(latest?.byJobId.get("b")).toEqual([{ job: jobs[0], confidence: "probable" }]);
  });
});

describe("useJobDuplicates: dismissal survives the new tier (#754 must not disturb #746)", () => {
  it("a dismissed pairing stays dismissed across a remount", () => {
    const jobs = [
      job({ id: "a", createdAt: JUN_15 }),
      job({ id: "b", createdAt: JUN_15 + 3 * DAY }),
    ];
    mount(jobs);
    expect(latest?.byJobId.size).toBe(2);

    act(() => latest?.dismiss("a", "b"));
    expect(latest?.byJobId.size).toBe(0);

    // A reload: fresh root, same localStorage. `jobPairKey`'s shape is what
    // carries the judgement across, which is why it is pinned in
    // `job-duplicates.test.ts`.
    act(() => root.unmount());
    root = createRoot(container);
    mount(jobs);
    expect(latest?.byJobId.size).toBe(0);
  });
});
