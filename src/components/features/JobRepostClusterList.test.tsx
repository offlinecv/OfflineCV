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
 *  - **The absence of a MERGE affordance.** #754's whole decision was to replace
 *    30 destructive **Merge into this one** buttons with one sentence, and that
 *    decision survives the bulk-archive follow-up: archiving is a status move
 *    the cluster outlives, merging is not. A later change that helpfully
 *    re-adds a merge should fail a test.
 *  - **Collapsed by default.** The section sits above the pipeline, so an open
 *    28-cluster list is a page of scroll in front of the rows that are the
 *    work. Closed-on-mount is the requirement; the count in the header is what
 *    keeps that from being hiding.
 *  - **The action is reachable without opening the list.** Most users come to
 *    this section to sweep it, and burying the trigger behind the disclosure
 *    would put the scroll back in front of them.
 */

import { describe, it, expect } from "vitest";
import { act } from "react";
import { installDialogPolyfill, setupDomRoot } from "./__test-utils__/dialog-dom.ts";
import { JobRepostClusterList } from "./JobRepostClusterList.tsx";
import type { JobRepostCluster } from "../../lib/job-repost-clusters.ts";
import type { JobRecord } from "../../lib/storage/index.ts";

installDialogPolyfill();

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

function job(over: Partial<JobRecord>): JobRecord {
  return {
    id: over.id ?? crypto.randomUUID(),
    createdAt: JAN_1,
    updatedAt: JAN_1,
    title: "Staff Engineer",
    company: "Acme",
    status: "interested",
    ...over,
  };
}

/** The disclosure toggle — the only button in the header when no sweep is
 *  wired, and identified by `aria-expanded` rather than its label so the tests
 *  below assert on the label rather than depending on it. */
function toggle(): HTMLButtonElement {
  return dom.container.querySelector("button[aria-expanded]") as HTMLButtonElement;
}

function expand() {
  act(() => toggle().dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("JobRepostClusterList", () => {
  it("renders nothing at all when no role has been re-listed", () => {
    dom.render(<JobRepostClusterList clusters={[]} />);
    expect(dom.container.textContent).toBe("");
    // Not merely empty text — the whole section is absent, so it cannot leave
    // a stray heading or spacing above the pipeline.
    expect(dom.container.querySelector("section")).toBeNull();
  });

  it("opens COLLAPSED, mounting no cluster rows, and states the count anyway", () => {
    dom.render(<JobRepostClusterList clusters={[cluster(), cluster({ key: "b" })]} />);

    // The motivating defect: 28 clusters standing between the user and the
    // pipeline. Closed is a real render saving, not a CSS hide.
    expect(dom.container.querySelectorAll("li")).toHaveLength(0);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // …and nothing is hidden without saying how much.
    expect(dom.container.textContent).toContain("Reposted roles · 2");
  });

  it("states the count, the role and the span once per cluster when opened", () => {
    dom.render(<JobRepostClusterList clusters={[cluster()]} />);
    expand();

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
    expand();

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

  it("still offers no merge, and the copy still says why", () => {
    dom.render(
      <JobRepostClusterList
        clusters={[cluster(), cluster({ key: "b" })]}
        jobs={[job({ id: "a" })]}
        archiveReposted={async () => 0}
      />,
    );
    expand();

    // #754 replaced a grid of destructive merge buttons with a statement, and
    // the bulk-archive follow-up did not walk that back: nothing here folds one
    // record into another.
    const labels = [...dom.container.querySelectorAll("button")].map(
      (b) => b.textContent ?? "",
    );
    expect(labels.some((label) => /merge/i.test(label))).toBe(false);
    expect(dom.container.textContent).toContain("no merge is offered");
  });

  it("shows the archive trigger in the header, without opening the list", () => {
    dom.render(
      <JobRepostClusterList
        clusters={[cluster({ ids: ["a", "b"], count: 2 })]}
        jobs={[job({ id: "a" }), job({ id: "b" })]}
        archiveReposted={async () => 2}
      />,
    );

    // Collapsed, and the sweep is still one click away — the reason most users
    // open this section at all.
    expect(dom.container.querySelectorAll("li")).toHaveLength(0);
    const labels = [...dom.container.querySelectorAll("button")].map(
      (b) => b.textContent ?? "",
    );
    expect(labels).toContain("Archive all reposted roles");
  });

  it("renders no action at all for a caller that supplied no sweep", () => {
    dom.render(<JobRepostClusterList clusters={[cluster()]} />);

    // The display-only contract: a caller that only states clusters gets only
    // the disclosure.
    expect(dom.container.querySelectorAll("button")).toHaveLength(1);
    expect(toggle()).not.toBeNull();
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
