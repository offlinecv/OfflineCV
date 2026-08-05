// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `JobRepostClusterList` (#754) — the statement the tracker makes instead of
 * offering a merge.
 *
 * Reached indirectly through `JobTracker.test.tsx` already, which is why this
 * file stays narrow: it covers the two things that are properties of THIS
 * component rather than of the tracker wiring, and that a tracker-level test
 * would only exercise by accident.
 *
 *  - **The optional-span branch.** `firstSeen`/`lastSeen`/`spanDays` are absent
 *    together when no member of a cluster carries a readable capture time, and
 *    the row must then drop the date line rather than print `NaN days`. The
 *    tracker's own fixtures all have timestamps, so nothing above this reaches
 *    that branch.
 *  - **The absence of an affordance.** #754's whole decision was to replace 30
 *    destructive **Merge into this one** buttons with one sentence, so "there
 *    is no button here" is the requirement, not an implementation detail. A
 *    later change that helpfully re-adds one should fail a test.
 */

import { describe, it, expect } from "vitest";
import { setupDomRoot } from "./__test-utils__/dialog-dom.ts";
import { JobRepostClusterList } from "./JobRepostClusterList.tsx";
import type { JobRepostCluster } from "../../lib/job-repost-clusters.ts";

const dom = setupDomRoot();

const JAN_1 = Date.parse("2026-01-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function cluster(over: Partial<JobRepostCluster> = {}): JobRepostCluster {
  return {
    key: "acme::staff engineer",
    company: "Acme",
    title: "Staff Engineer",
    ids: ["a", "b", "c"],
    count: 3,
    firstSeen: JAN_1,
    lastSeen: JAN_1 + 49 * DAY_MS,
    spanDays: 49,
    ...over,
  };
}

describe("JobRepostClusterList", () => {
  it("renders nothing at all when no role has been re-listed", () => {
    dom.render(<JobRepostClusterList clusters={[]} />);
    expect(dom.container.textContent).toBe("");
    // Not merely empty text — the whole section is absent, so it cannot leave
    // a stray heading or spacing above the pipeline.
    expect(dom.container.querySelector("section")).toBeNull();
  });

  it("states the count, the role and the span once per cluster", () => {
    dom.render(<JobRepostClusterList clusters={[cluster()]} />);

    const text = dom.container.textContent ?? "";
    expect(text).toContain("Reposted 3×");
    expect(text).toContain("Staff Engineer");
    expect(text).toContain("Acme");
    expect(text).toContain("49 days apart");
    // One line for the cluster, not one per member — the point of the surface.
    expect(dom.container.querySelectorAll("li")).toHaveLength(1);
  });

  it("drops the date line, keeping the count, when the cluster has no readable span", () => {
    dom.render(
      <JobRepostClusterList
        clusters={[
          cluster({ firstSeen: undefined, lastSeen: undefined, spanDays: undefined }),
        ]}
      />,
    );

    const text = dom.container.textContent ?? "";
    // The count is still true and still stated…
    expect(text).toContain("Reposted 3×");
    expect(text).toContain("Staff Engineer");
    // …but nothing pretends to know a span. `NaN`/`Invalid Date` reaching the
    // user is the specific failure this branch exists to prevent.
    expect(text).not.toContain("days apart");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Invalid Date");
  });

  it("offers no action — no button, and the copy says why", () => {
    dom.render(<JobRepostClusterList clusters={[cluster(), cluster({ key: "b" })]} />);

    // #754 replaced a grid of destructive merge buttons with a statement.
    // Nothing here is for the user to accept, decline, or dismiss.
    expect(dom.container.querySelectorAll("button")).toHaveLength(0);
    expect(dom.container.textContent).toContain("no merge is offered");
  });

  it("counts the clusters in its heading, not the records inside them", () => {
    dom.render(
      <JobRepostClusterList
        clusters={[cluster(), cluster({ key: "second", count: 6 })]}
      />,
    );

    // Two clusters covering nine records: the heading says 2. Saying 9 would
    // double-count rows the status sections below already show in full.
    expect(dom.container.textContent).toContain("Reposted roles · 2");
  });
});
