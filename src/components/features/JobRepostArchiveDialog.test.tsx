// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * JobRepostArchiveDialog — the UI wiring between `repostedJobsToArchive` and
 * `useJobTracker.archiveReposted`. The predicate is unit-tested at module scope
 * in `job-repost-sweep.test.ts` and the write in `job-tracker.test.ts`; this
 * file covers only what is a property of the component:
 *
 *  - the preview count is the predicate's own answer, so the number the user
 *    confirms cannot drift from the rows the sweep writes;
 *  - the trigger is ABSENT, not disabled, when no clustered row is still
 *    sweepable — this dialog's zero is a settled fact, unlike the sibling
 *    age-sweep dialog's transient one;
 *  - a sweep that empties the set does not unmount the dialog out from under
 *    its own result;
 *  - the printed count is what `archiveReposted` RETURNED, not the preview.
 *
 * jsdom lacks `HTMLDialogElement.showModal`/`close` — polyfill + per-test root
 * come from `__test-utils__/dialog-dom.ts`, the shape
 * `JobArchiveSweepDialog.test.tsx` uses.
 */

import { describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { JobRepostArchiveDialog } from "./JobRepostArchiveDialog.tsx";
import { installDialogPolyfill, setupDomRoot } from "./__test-utils__/dialog-dom.ts";
import type { JobRepostCluster } from "../../lib/job-repost-clusters.ts";
import type { JobRecord } from "../../lib/storage/index.ts";

installDialogPolyfill();
const dom = setupDomRoot();

const TRIGGER = "Archive all reposted roles";

function job(over: Partial<JobRecord>): JobRecord {
  return {
    id: over.id ?? crypto.randomUUID(),
    createdAt: 1,
    updatedAt: 1,
    title: "SWE",
    company: "Acme",
    status: "interested",
    ...over,
  };
}

function cluster(ids: string[], over: Partial<JobRepostCluster> = {}): JobRepostCluster {
  return {
    key: "acme::swe",
    company: "Acme",
    title: "SWE",
    ids,
    count: ids.length,
    ...over,
  };
}

function clickButton(scope: ParentNode, label: string) {
  const button = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return button;
}

function openDialogEl(): HTMLElement {
  return dom.container.querySelector("dialog[open]") as HTMLElement;
}

describe("JobRepostArchiveDialog", () => {
  it("previews the rows repostedJobsToArchive would select, and the roles they span", () => {
    const jobs = [
      job({ id: "a" }),
      job({ id: "b" }),
      job({ id: "c", company: "Beta", title: "PM" }),
      job({ id: "d", company: "Beta", title: "PM" }),
      job({ id: "e", status: "applied" }),
      job({ id: "unclustered", company: "Gamma" }),
    ];
    dom.render(
      <JobRepostArchiveDialog
        jobs={jobs}
        clusters={[
          cluster(["a", "b", "e"]),
          cluster(["c", "d"], { key: "beta::pm", company: "Beta", title: "PM" }),
        ]}
        archiveReposted={vi.fn()}
      />,
    );
    clickButton(dom.container, TRIGGER);

    // Four sweepable rows: the Applied member and the unclustered job are out.
    expect(openDialogEl().textContent).toContain("4 jobs");
    // Two roles — counted off the rows that will actually be written, not off
    // `clusters.length`, so the two numbers describe the same set.
    expect(openDialogEl().textContent).toContain("across 2 roles");
  });

  it("counts roles off the sweepable rows, not the clusters", () => {
    // A cluster whose every member is already archived contributes nothing to
    // the write and must contribute nothing to the role count either.
    const jobs = [
      job({ id: "a" }),
      job({ id: "b" }),
      job({ id: "c", company: "Beta", title: "PM", status: "archived" }),
      job({ id: "d", company: "Beta", title: "PM", status: "archived" }),
    ];
    dom.render(
      <JobRepostArchiveDialog
        jobs={jobs}
        clusters={[
          cluster(["a", "b"]),
          cluster(["c", "d"], { key: "beta::pm", company: "Beta", title: "PM" }),
        ]}
        archiveReposted={vi.fn()}
      />,
    );
    clickButton(dom.container, TRIGGER);

    expect(openDialogEl().textContent).toContain("2 jobs");
    expect(openDialogEl().textContent).toContain("across 1 role");
  });

  it("renders no trigger at all when every clustered row is already archived", () => {
    const jobs = [
      job({ id: "a", status: "archived" }),
      job({ id: "b", status: "applied" }),
    ];
    dom.render(
      <JobRepostArchiveDialog
        jobs={jobs}
        clusters={[cluster(["a", "b"])]}
        archiveReposted={vi.fn()}
      />,
    );

    // Absent, not disabled: a permanently dead control in a header whose whole
    // problem was clutter.
    expect(dom.container.querySelectorAll("button")).toHaveLength(0);
  });

  it("calls archiveReposted with the clusters it previewed, and prints the RETURNED count", async () => {
    const jobs = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];
    const clusters = [cluster(["a", "b", "c"])];
    // Two, not three: a row that stopped being Interested mid-sweep is skipped
    // at the write. The done state must state writes that happened.
    const archiveReposted = vi.fn(async () => 2);
    dom.render(
      <JobRepostArchiveDialog
        jobs={jobs}
        clusters={clusters}
        archiveReposted={archiveReposted}
      />,
    );
    clickButton(dom.container, TRIGGER);
    expect(openDialogEl().textContent).toContain("3 jobs");

    const confirm = [...openDialogEl().querySelectorAll("button")].find(
      (b) => b.textContent === "Archive",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(archiveReposted).toHaveBeenCalledWith(clusters);
    expect(openDialogEl().textContent).toContain("Archived 2 jobs.");
  });

  it("keeps the result visible when the sweep empties its own selection", async () => {
    // The realistic case: after the write the parent re-renders with every
    // clustered row archived, so `toArchive` is empty. The `!open` half of the
    // guard is what stops the dialog vanishing mid-sentence.
    const clusters = [cluster(["a"])];
    function Harness() {
      const [swept, setSwept] = useState(false);
      return (
        <JobRepostArchiveDialog
          jobs={[job({ id: "a", status: swept ? "archived" : "interested" })]}
          clusters={clusters}
          archiveReposted={async () => {
            setSwept(true);
            return 1;
          }}
        />
      );
    }

    dom.render(<Harness />);
    clickButton(dom.container, TRIGGER);
    await act(async () => {
      [...openDialogEl().querySelectorAll("button")]
        .find((b) => b.textContent === "Archive")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openDialogEl().textContent).toContain("Archived 1 job.");
  });
});
