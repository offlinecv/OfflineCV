// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * JobTracker (#323). The properties that matter for the tracker surface: jobs
 * render grouped by status, the manual add wires to the hook, a linked resume
 * that no longer resolves degrades to "not linked" (never a dangling id) — the
 * graceful-degrade AC as seen from the UI — and the link picker only offers
 * resumes that actually exist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobTracker } from "./JobTracker.tsx";
import { SECTION_PAGE_SIZE } from "./JobTrackerStatusGroup.tsx";
import type { JobTracker as Tracker } from "../../hooks/useJobTracker.ts";
import type { JobRecord, LetterRecord } from "../../lib/storage/index.ts";
import type { JobRating } from "../../lib/job-search/rating.ts";
import type { JobDuplicateSuggestion } from "../../hooks/useJobDuplicates.ts";
import { findRepostClusters } from "../../lib/job-repost-clusters.ts";
import { installDialogPolyfill } from "./__test-utils__/dialog-dom.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The repost section's bulk-archive confirm is a `Dialog`, which jsdom cannot
// open on its own. Only the polyfill is borrowed — this suite drives its own
// `createRoot`, so `setupDomRoot` is deliberately not used.
installDialogPolyfill();

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

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

function makeTracker(jobs: JobRecord[]): Tracker {
  return {
    jobs,
    ready: true,
    persisted: true,
    usageBytes: null,
    create: vi.fn(async () => "new-id"),
    update: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    link: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    merge: vi.fn(async () => {}),
    saveFromMatch: vi.fn(async () => "new-id"),
    exportBackup: vi.fn(async () => {}),
    archiveOlderThan: vi.fn(async () => 0),
    archiveReposted: vi.fn(async () => 0),
    refresh: vi.fn(async () => {}),
  };
}

describe("JobTracker", () => {
  it("still renders a job whose status isn't in the lifecycle, so the count can't lie", () => {
    // A corrupt or future-version imported record can carry a status outside
    // JOB_STATUS_ORDER. It must not vanish from the list while still being
    // counted in the header total (rows < count) — it renders under its raw
    // status label instead.
    const tracker = makeTracker([
      job({ title: "Real", status: "applied" }),
      job({ title: "Weird", status: "ghosted" as JobRecord["status"] }),
    ]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    const text = container.textContent ?? "";
    expect(text).toContain("Real");
    expect(text).toContain("Weird");
    // The unknown status surfaces under its literal string, not a blank badge.
    expect(text).toContain("ghosted");
  });

  it("groups jobs under their status headings", () => {
    const tracker = makeTracker([
      job({ title: "A", status: "interested" }),
      job({ title: "B", status: "offer" }),
    ]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    const text = container.textContent ?? "";
    expect(text).toContain("Interested");
    expect(text).toContain("Offer");
    expect(text).toContain("Tracked jobs");
  });

  it("shows the empty-state prompt with no jobs", () => {
    act(() => root.render(<JobTracker tracker={makeTracker([])} />));
    expect(container.textContent).toContain("No tracked jobs yet");
  });

  it("wires the manual add button to the hook", () => {
    const tracker = makeTracker([]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    const add = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Add a job",
    );
    act(() => add?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(tracker.create).toHaveBeenCalledWith({ title: "New job" });
  });

  it("renders the bulk-archive control in the header (#759)", () => {
    // Deep interaction — cutoff input, preview count, confirm — lives in
    // JobArchiveSweepDialog.test.tsx; this only checks JobTracker wires
    // `tracker.jobs` / `tracker.archiveOlderThan` through to it at all.
    const tracker = makeTracker([job({ title: "SWE" })]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    const trigger = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Archive old jobs",
    );
    expect(trigger).toBeDefined();
  });

  it("degrades a stale resume link to 'not linked' instead of a dangling id", () => {
    const tracker = makeTracker([job({ resumeId: "deleted-resume" })]);
    // resumeName resolver returns undefined — the linked resume is gone.
    act(() =>
      root.render(<JobTracker tracker={tracker} resumeName={() => undefined} />),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Not linked to a resume");
    expect(text).not.toContain("deleted-resume");
  });
});

describe("JobTracker: fitness ratings (#700)", () => {
  /** Fitness-only, as every saved-job rating is — the library carries no query,
   *  so the comp/location/seniority axes are absent. */
  const RATING: JobRating = {
    overall: 4.2,
    fitness: 4.2,
    compensation: null,
    location: null,
    seniority: null,
  };

  it("shows the shared star widget and reason words for a rated job", () => {
    const tracker = makeTracker([job({ id: "j1", jdText: "React" })]);
    act(() =>
      root.render(
        <JobTracker tracker={tracker} ratings={new Map([["j1", RATING]])} hasResume />,
      ),
    );
    // `RatingStars` — the shared read-only widget, not a hand-rolled star row.
    const stars = container.querySelector('[role="img"]');
    expect(stars?.getAttribute("aria-label")).toBe("Resume fit: 4.2 out of 5 stars");
    // The same reason band the search cards print, off `describeRating`.
    expect(container.textContent).toContain("Excellent fit");
    expect(container.textContent).not.toContain("Not rated");
  });

  it("renders 'not rated' — never zero stars — for a record with no job description", () => {
    // The library HAS been rated (non-null map); this record simply has no JD to
    // match against, so it is absent from the map. A 0-star row would read as
    // "terrible fit", which is a different and false claim.
    const tracker = makeTracker([job({ id: "j1" })]);
    act(() =>
      root.render(<JobTracker tracker={tracker} ratings={new Map()} hasResume />),
    );
    expect(container.textContent).toContain("Not rated");
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it("shows no fitness block, and says why, when no résumé reached this tab", () => {
    const tracker = makeTracker([job({ id: "j1", jdText: "React" })]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    expect(container.querySelector('[role="img"]')).toBeNull();
    // "Not rated" would be wrong here: the record has a JD, we have no résumé.
    expect(container.textContent).not.toContain("Not rated");
    expect(container.textContent).toContain("Open this workbench from your resume");
  });

  it("keeps the explanation off an empty library, where it would be noise", () => {
    act(() => root.render(<JobTracker tracker={makeTracker([])} />));
    expect(container.textContent).not.toContain("Open this workbench from your resume");
  });
});

describe("JobTracker: fallback résumé attribution (#724)", () => {
  it("names the résumé when the ratings came from the fallback, not the handoff", () => {
    const tracker = makeTracker([job({ id: "j1", jdText: "React" })]);
    act(() =>
      root.render(
        <JobTracker
          tracker={tracker}
          ratings={new Map()}
          hasResume
          fallbackResumeName="resume-v1.pdf"
        />,
      ),
    );
    expect(container.textContent).toContain("Fit vs.");
    expect(container.textContent).toContain("resume-v1.pdf");
  });

  it("says nothing about a résumé source for a real handoff (no fallback name given)", () => {
    const rating: JobRating = {
      overall: 4.2,
      fitness: 4.2,
      compensation: null,
      location: null,
      seniority: null,
    };
    const tracker = makeTracker([job({ id: "j1", jdText: "React" })]);
    act(() =>
      root.render(
        <JobTracker tracker={tracker} ratings={new Map([["j1", rating]])} hasResume />,
      ),
    );
    expect(container.textContent).not.toContain("Fit vs.");
  });

  it("omits the attribution on an empty library, matching the other explanation lines", () => {
    act(() =>
      root.render(
        <JobTracker
          tracker={makeTracker([])}
          hasResume
          fallbackResumeName="resume-v1.pdf"
        />,
      ),
    );
    expect(container.textContent).not.toContain("Fit vs.");
  });
});

describe("JobTracker: resume link picker", () => {
  const RESUMES = [
    { id: "r1", filename: "resume-v1.pdf" },
    { id: "r2", filename: "resume-v2.pdf" },
  ];

  function clickButton(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
    act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    return button;
  }

  it("offers the saved resumes and links the one picked", () => {
    const tracker = makeTracker([job({ id: "j1" })]);
    act(() =>
      root.render(
        <JobTracker tracker={tracker} resumeOptions={RESUMES} />,
      ),
    );
    // Collapsed by default — a row shouldn't open with a list of every resume.
    expect(container.textContent).not.toContain("resume-v2.pdf");

    clickButton("Link a resume");
    expect(container.textContent).toContain("resume-v1.pdf");
    clickButton("resume-v2.pdf");

    expect(tracker.link).toHaveBeenCalledWith("j1", "r2");
  });

  it("hides the picker when there are no saved resumes to link", () => {
    act(() => root.render(<JobTracker tracker={makeTracker([job({})])} />));
    expect(container.textContent).toContain("Not linked to a resume");
    expect(container.textContent).not.toContain("Link a resume");
  });

  it("offers unlink, not the picker, once a resume is linked", () => {
    const tracker = makeTracker([job({ id: "j1", resumeId: "r1" })]);
    act(() =>
      root.render(
        <JobTracker
          tracker={tracker}
          resumeName={() => "resume-v1.pdf"}
          resumeOptions={RESUMES}
        />,
      ),
    );
    expect(container.textContent).not.toContain("Link a resume");
    clickButton("Unlink");
    expect(tracker.unlink).toHaveBeenCalledWith("j1");
  });
});

describe("JobTracker: letter indicator (#715)", () => {
  function letterFor(jobId: string): LetterRecord {
    return {
      id: crypto.randomUUID(),
      jobId,
      createdAt: 1,
      updatedAt: 1,
      body: "Dear hiring team,",
    };
  }

  it("shows the indicator only on the row whose id is a key in lettersById", () => {
    const tracker = makeTracker([
      job({ id: "j1", title: "Has a letter" }),
      job({ id: "j2", title: "No letter" }),
    ]);
    act(() =>
      root.render(
        <JobTracker
          tracker={tracker}
          lettersById={new Map([["j1", [letterFor("j1")]]])}
        />,
      ),
    );
    const icons = container.querySelectorAll('button[aria-label="View cover letter"]');
    expect(icons).toHaveLength(1);
  });

  it("shows no indicator on any row when lettersById is omitted", () => {
    const tracker = makeTracker([job({ id: "j1" })]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    expect(
      container.querySelector('button[aria-label="View cover letter"]'),
    ).toBeNull();
  });
});

describe("JobTracker: origin phrase on the tracker row (#745)", () => {
  it("shows a short phrase for a recognised origin", () => {
    const tracker = makeTracker([job({ id: "j1", title: "Shared job", origin: "shared" })]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    expect(container.textContent).toContain("shared with you");
  });

  it("renders nothing when origin is absent — the common case", () => {
    const tracker = makeTracker([job({ id: "j1", title: "Plain job" })]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    for (const phrase of [
      "captured from a posting",
      "from a job alert",
      "shared with you",
      "imported from a backup",
      "added manually",
    ]) {
      expect(container.textContent).not.toContain(phrase);
    }
  });

  it("never repeats the status badge's own text as the origin phrase", () => {
    // The row's badge already prints the literal status via jobStatusLabel;
    // the origin phrase exists to answer a different question ("how did this
    // get here"), not to echo it as a second chip.
    const tracker = makeTracker([
      job({ id: "j1", title: "Applied via alert", status: "applied", origin: "alert" }),
    ]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    expect(container.textContent).toContain("Applied");
    expect(container.textContent).toContain("from a job alert");
  });
});

describe("JobTracker: collapsible status sections (#740)", () => {
  /** Every mounted row is a `JobTrackerEntry`, whose root is the only `<li>` in
   *  the tree — so this counts ROWS, not a CSS-hidden class. */
  function rows(): HTMLLIElement[] {
    return [...container.querySelectorAll("li")];
  }

  /** The section disclosure for a status. Matched on the ` · ` the header count
   *  puts there, which no row control has — a row's status picker renders a
   *  button whose text is the bare label ("Rejected"). */
  function toggleFor(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(`${label} · `),
    );
    if (!button) throw new Error(`no section toggle for "${label}"`);
    return button;
  }

  function click(button: Element | undefined) {
    act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  function clickIn(scope: ParentNode, label: string) {
    click([...scope.querySelectorAll("button")].find((b) => b.textContent === label));
  }

  function rowFor(title: string): HTMLLIElement {
    const row = rows().find((li) => li.textContent?.includes(title));
    if (!row) throw new Error(`no row for "${title}"`);
    return row;
  }

  /** `n` jobs in the order the tracker actually hands down: `listJobs()` sorts
   *  the whole library by `updatedAt` DESCENDING, so index 0 is the most
   *  recently written. Fixtures that ignore this can't reproduce the reorder a
   *  plain field edit causes. Sizes derive from `SECTION_PAGE_SIZE` so a
   *  threshold change moves the tests with it rather than silently unpaging. */
  function manyJobs(n: number): JobRecord[] {
    return Array.from({ length: n }, (_, i) =>
      job({ id: `j${i}`, title: `Job ${i}`, updatedAt: n - i }),
    );
  }

  /** The bucket's page-N control, which `Pagination` labels. */
  function pageButton(n: number): Element | undefined {
    return [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === `Page ${n}`,
    );
  }

  const MIXED = [
    job({ id: "live", title: "Live one", status: "interested" }),
    job({ id: "dead", title: "Dead one", status: "rejected" }),
    job({ id: "old", title: "Old one", status: "archived" }),
  ];

  it("opens rejected and archived collapsed, with the label and count still shown", () => {
    act(() => root.render(<JobTracker tracker={makeTracker(MIXED)} />));
    const text = container.textContent ?? "";
    // Nothing is hidden without declaring its size.
    expect(text).toContain("Interested · 1");
    expect(text).toContain("Rejected · 1");
    expect(text).toContain("Archived · 1");
    // Only the live bucket mounted its row — a real render saving.
    expect(rows()).toHaveLength(1);
    expect(text).toContain("Live one");
    expect(text).not.toContain("Dead one");
    expect(text).not.toContain("Old one");
    expect(toggleFor("Rejected").getAttribute("aria-expanded")).toBe("false");
    expect(toggleFor("Archived").getAttribute("aria-expanded")).toBe("false");
    expect(toggleFor("Interested").getAttribute("aria-expanded")).toBe("true");
  });

  it("expands and re-collapses a section from its header, tracking aria-expanded", () => {
    act(() => root.render(<JobTracker tracker={makeTracker(MIXED)} />));

    click(toggleFor("Rejected"));
    expect(toggleFor("Rejected").getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Dead one");
    expect(rows()).toHaveLength(2);
    // Toggling one section leaves its neighbours alone.
    expect(container.textContent).not.toContain("Old one");

    click(toggleFor("Rejected"));
    expect(toggleFor("Rejected").getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Dead one");
    expect(rows()).toHaveLength(1);
  });

  it.each(["rejected", "archived"] as const)(
    "expands %s when it is the only non-empty bucket",
    (status) => {
      const tracker = makeTracker([job({ title: "Only one", status })]);
      act(() => root.render(<JobTracker tracker={tracker} />));
      expect(rows()).toHaveLength(1);
      expect(container.textContent).toContain("Only one");
    },
  );

  it("expands both terminal buckets when the library is nothing else", () => {
    // Neither is "the only" non-empty bucket, but between them they are the
    // whole library — collapsing both would render a page of headers and no
    // rows, which is the failure the rule exists to prevent.
    const tracker = makeTracker([
      job({ title: "Dead one", status: "rejected" }),
      job({ title: "Old one", status: "archived" }),
    ]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    expect(rows()).toHaveLength(2);
    expect(container.textContent).toContain("Dead one");
    expect(container.textContent).toContain("Old one");
  });

  it("expands a bucket whose status it cannot explain", () => {
    // A corrupt or future-version imported record. Unknown is NOT treated as
    // terminal: a bucket the app can't explain is the one to surface.
    const tracker = makeTracker([
      job({ title: "Live one", status: "interested" }),
      job({ title: "Dead one", status: "rejected" }),
      job({ title: "Weird one", status: "ghosted" as JobRecord["status"] }),
    ]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    expect(container.textContent).toContain("Weird one");
    expect(toggleFor("ghosted").getAttribute("aria-expanded")).toBe("true");
    // …while the terminal bucket alongside it still opens closed.
    expect(container.textContent).not.toContain("Dead one");
  });

  it("follows the default until the user touches the section, so a shrinking library still opens", () => {
    // Rejected starts collapsed behind a live bucket. Delete the live job and
    // rejected becomes the whole library — an open state frozen at mount would
    // leave the user staring at a lone header.
    act(() => root.render(<JobTracker tracker={makeTracker(MIXED.slice(0, 2))} />));
    expect(container.textContent).not.toContain("Dead one");

    act(() => root.render(<JobTracker tracker={makeTracker([MIXED[1]])} />));
    expect(container.textContent).toContain("Dead one");
    expect(toggleFor("Rejected").getAttribute("aria-expanded")).toBe("true");
  });

  it("does not slam a self-opened section shut when another bucket appears", () => {
    // The default is derived from the WHOLE library, so it can flip back down
    // under a user who did nothing. On /jobs/ that is reachable: Tabs keeps both
    // panels mounted, so saving a job from Search grows the library while the
    // user is reading an open Saved-jobs section. The latch is one-way.
    act(() => root.render(<JobTracker tracker={makeTracker([MIXED[1]])} />));
    expect(container.textContent).toContain("Dead one");

    act(() => root.render(<JobTracker tracker={makeTracker(MIXED.slice(0, 2))} />));
    expect(container.textContent).toContain("Dead one");
    expect(toggleFor("Rejected").getAttribute("aria-expanded")).toBe("true");

    // Still the user's to close, and it stays closed once they say so.
    click(toggleFor("Rejected"));
    expect(container.textContent).not.toContain("Dead one");
  });

  it("keeps a collapsed-then-expanded row fully actionable", () => {
    const tracker = makeTracker(MIXED);
    act(() => root.render(<JobTracker tracker={tracker} />));
    click(toggleFor("Rejected"));

    const row = rowFor("Dead one");
    // The row's own status picker still moves the job out of the bucket…
    clickIn(row, "Applied");
    expect(tracker.setStatus).toHaveBeenCalledWith("dead", "applied");
    // …and the two-click remove still removes it. A terminal bucket is not a
    // read-only archive.
    clickIn(rowFor("Dead one"), "Remove");
    clickIn(rowFor("Dead one"), "Confirm");
    expect(tracker.remove).toHaveBeenCalledWith("dead");
  });

  /** Rows past a full page, so the bucket splits into exactly two. */
  const OVERFLOW = 5;
  const LAST_TITLE = `Job ${SECTION_PAGE_SIZE + OVERFLOW - 1}`;

  it("pages an expanded section past the row threshold, leaving every row reachable", () => {
    const many = manyJobs(SECTION_PAGE_SIZE + OVERFLOW);
    act(() => root.render(<JobTracker tracker={makeTracker(many)} />));

    expect(rows()).toHaveLength(SECTION_PAGE_SIZE);
    expect(container.textContent).toContain("Job 0");
    expect(container.textContent).not.toContain(LAST_TITLE);
    // The shared Pagination control, not a hand-rolled "Show more".
    const nav = container.querySelector("nav[aria-label]");
    expect(nav?.getAttribute("aria-label")).toContain("Interested jobs pagination");

    click(pageButton(2));
    expect(rows()).toHaveLength(OVERFLOW);
    expect(container.textContent).toContain(LAST_TITLE);
    expect(container.textContent).not.toContain("Job 0");
  });

  it("does not page a section at the threshold", () => {
    act(() => root.render(<JobTracker tracker={makeTracker(manyJobs(SECTION_PAGE_SIZE))} />));
    expect(rows()).toHaveLength(SECTION_PAGE_SIZE);
    expect(container.querySelector("nav[aria-label]")).toBeNull();
  });

  it("resets a section's page when its membership changes, not when a row is edited", () => {
    const many = manyJobs(SECTION_PAGE_SIZE + OVERFLOW);
    act(() => root.render(<JobTracker tracker={makeTracker(many)} />));
    click(pageButton(2));
    expect(container.textContent).toContain(LAST_TITLE);

    // An inline edit does NOT hand down the same order. `updateJob()` bumps
    // `updatedAt` and `listJobs()` re-sorts descending, so the edited job floats
    // to the front of the bucket — modelled here by patching a job that is not
    // already first and re-sorting exactly as the hook would. Page 2 must
    // survive that reorder, or every note edit yanks the reader back to the top.
    const edited = many
      .map((j) =>
        j.id === "j27"
          ? { ...j, notes: "touched", updatedAt: many[0].updatedAt + 1 }
          : { ...j },
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    act(() => root.render(<JobTracker tracker={makeTracker(edited)} />));
    // Still the last page: its tail row is on screen and page 1's head is not.
    expect(container.textContent).toContain(LAST_TITLE);
    expect(container.textContent).not.toContain("Job 0");

    // Dropping a job changes what page 2 even means, so the page resets.
    const shorter = many.slice(0, SECTION_PAGE_SIZE + 1);
    act(() => root.render(<JobTracker tracker={makeTracker(shorter)} />));
    expect(container.textContent).toContain("Job 0");
    expect(container.textContent).not.toContain(`Job ${SECTION_PAGE_SIZE}`);
  });

  it("keeps the header total equal to the sum of every section count, open or not", () => {
    const tracker = makeTracker([
      ...MIXED,
      job({ id: "dead2", title: "Dead two", status: "rejected" }),
      job({ id: "weird", title: "Weird one", status: "ghosted" as JobRecord["status"] }),
    ]);
    act(() => root.render(<JobTracker tracker={tracker} />));

    const sum = [...container.querySelectorAll("h3")]
      .map((h) => Number((h.textContent ?? "").split("·").pop()))
      .reduce((a, b) => a + b, 0);
    expect(sum).toBe(5);
    // Three of the five rows sit behind a collapsed header, and the total still
    // matches — the counts are the bucket length, never the rendered slice.
    expect(rows()).toHaveLength(2);
  });
});

describe("JobTracker: lifecycle buckets over raw statuses (#744)", () => {
  /** A record carrying a status outside this build's lifecycle, the way a synced
   *  one does. The cast is the same deliberate lie `JobRecord.status` makes: the
   *  record contract accepts and preserves any string. FROZEN, so a view-time
   *  normalisation would throw here rather than pass quietly. */
  function synced(
    over: Omit<Partial<JobRecord>, "status"> & { status: string },
  ): JobRecord {
    return Object.freeze(
      job({ ...over, status: over.status as JobRecord["status"] }),
    );
  }

  function sectionHeadings(): string[] {
    return [...container.querySelectorAll("h3")].map((h) => h.textContent ?? "");
  }

  function rowFor(title: string): HTMLLIElement {
    const row = [...container.querySelectorAll("li")].find((li) =>
      li.textContent?.includes(title),
    );
    if (!row) throw new Error(`no row for "${title}"`);
    return row;
  }

  /** That row's status picker specifically — scoped by the group's own label so
   *  the assertions can't be satisfied by some other pressed control. */
  function pickerFor(title: string): HTMLElement {
    const picker = rowFor(title).querySelector<HTMLElement>(
      '[role="group"][aria-label="Application status"]',
    );
    if (!picker) throw new Error(`no status picker in the row for "${title}"`);
    return picker;
  }

  function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
    const button = [...scope.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
    if (!button) throw new Error(`no "${label}" button in scope`);
    return button;
  }

  function click(button: Element) {
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  /** The four pre-application statuses a Recruidea sync produces — one stage of
   *  a job search, spelled four ways. */
  const PRE_APPLICATION = [
    synced({ id: "a", title: "Ours", status: "interested" }),
    synced({ id: "b", title: "Manually saved", status: "saved" }),
    synced({ id: "c", title: "From an alert", status: "scouted" }),
    synced({ id: "d", title: "Sponsor share", status: "shared" }),
  ];

  it("renders one Interested section holding every pre-application status", () => {
    act(() => root.render(<JobTracker tracker={makeTracker(PRE_APPLICATION)} />));

    expect(sectionHeadings()).toHaveLength(1);
    expect(sectionHeadings()[0]).toContain("Interested · 4");
    // No parallel Saved / Scouted / Shared sections beside it.
    const headings = sectionHeadings().join(" ");
    for (const gone of ["Saved ·", "Scouted ·", "Shared ·"]) {
      expect(headings).not.toContain(gone);
    }
    // And the section is open, so all four rows are actually on screen.
    expect(container.querySelectorAll("li")).toHaveLength(4);
    for (const { title } of PRE_APPLICATION) {
      expect(container.textContent).toContain(title);
    }
  });

  it("leaves the stored status byte-identical through a render", () => {
    // Asserted on the RECORD, not the DOM: grouping is a view concern and must
    // not normalise what a producer wrote. The fixtures are frozen, so a write
    // would throw here rather than pass quietly.
    const jobs = PRE_APPLICATION;
    act(() => root.render(<JobTracker tracker={makeTracker(jobs)} />));
    expect(jobs.map((j) => j.status)).toEqual([
      "interested",
      "saved",
      "scouted",
      "shared",
    ]);
  });

  it("shows Interested as the selected button on a shared row", () => {
    act(() => root.render(<JobTracker tracker={makeTracker(PRE_APPLICATION)} />));
    const picker = pickerFor("Sponsor share");
    expect(buttonIn(picker, "Interested").getAttribute("aria-pressed")).toBe("true");
    // …and exactly one button is selected, not zero (the pre-#744 bug) and not
    // several.
    expect(picker.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
  });

  it("writes nothing when the user clicks the bucket a shared row is already in", () => {
    const tracker = makeTracker([...PRE_APPLICATION]);
    act(() => root.render(<JobTracker tracker={tracker} />));

    click(buttonIn(pickerFor("Sponsor share"), "Interested"));

    expect(tracker.setStatus).not.toHaveBeenCalled();
    // The record still says what its producer said — no idempotent-looking
    // write of `interested` over `shared`.
    expect(tracker.jobs.find((j) => j.id === "d")?.status).toBe("shared");
  });

  it("writes the canonical status when a shared row moves to a different bucket", () => {
    const tracker = makeTracker([...PRE_APPLICATION]);
    act(() => root.render(<JobTracker tracker={tracker} />));

    click(buttonIn(pickerFor("Sponsor share"), "Applied"));

    // The ordinary transition, and it writes the lifecycle's own vocabulary —
    // never an echo of the foreign status.
    expect(tracker.setStatus).toHaveBeenCalledWith("d", "applied");
  });

  it("folds withdrawn into the rejected bucket", () => {
    const tracker = makeTracker([
      synced({ id: "w", title: "Pulled out", status: "withdrawn" }),
      synced({ id: "r", title: "Turned down", status: "rejected" }),
    ]);
    act(() => root.render(<JobTracker tracker={tracker} />));
    expect(sectionHeadings()).toHaveLength(1);
    expect(sectionHeadings()[0]).toContain("Rejected · 2");
  });

  it("still gives a status outside both vocabularies its own expanded section", () => {
    // The escape hatch #744 narrows but does not remove. `ghosted` maps to
    // nothing, so it heads its own section under its literal string, expanded.
    const tracker = makeTracker([
      synced({ id: "s", title: "Sponsor share", status: "shared" }),
      synced({ id: "g", title: "Weird one", status: "ghosted" }),
    ]);
    act(() => root.render(<JobTracker tracker={tracker} />));

    const headings = sectionHeadings();
    expect(headings).toHaveLength(2);
    expect(headings.join(" ")).toContain("ghosted · 1");
    expect(container.textContent).toContain("Weird one");
    // No selection on a row the picker genuinely cannot place — the honest
    // state, and the one a click can repair.
    expect(
      pickerFor("Weird one").querySelectorAll('button[aria-pressed="true"]'),
    ).toHaveLength(0);
  });

  it("keeps the header total equal to the sum of section counts across buckets", () => {
    const tracker = makeTracker([
      ...PRE_APPLICATION,
      synced({ id: "w", title: "Pulled out", status: "withdrawn" }),
      synced({ id: "g", title: "Weird one", status: "ghosted" }),
    ]);
    act(() => root.render(<JobTracker tracker={tracker} />));

    const sum = sectionHeadings()
      .map((text) => Number(text.split("·").pop()))
      .reduce((a, b) => a + b, 0);
    expect(sum).toBe(6);
    expect(container.textContent).toContain("Tracked jobs");
    expect(container.querySelector("header")?.textContent).toContain("6");
  });
});

describe("JobTracker: the duplicate affordance never merges on its own (#746)", () => {
  const ATS = "https://boards.greenhouse.io/acme/jobs/1";
  const AGGREGATOR = "https://jobs.example.com/listing/1";

  function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
    expect(button, `no button labelled "${label}"`).toBeDefined();
    act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  function pairedTracker() {
    const a = job({ id: "a", title: "Senior Frontend Engineer", url: ATS });
    const b = job({ id: "b", title: "Senior Frontend Engineer", url: AGGREGATOR });
    const suggestion = (other: JobRecord): JobDuplicateSuggestion[] => [
      { job: other, confidence: "probable" },
    ];
    return {
      tracker: makeTracker([a, b]),
      duplicatesByJobId: new Map<string, readonly JobDuplicateSuggestion[]>([
        ["a", suggestion(b)],
        ["b", suggestion(a)],
      ]),
    };
  }

  it("shows the affordance for a probable match, and merges nothing by rendering it", () => {
    const { tracker, duplicatesByJobId } = pairedTracker();
    act(() =>
      root.render(
        <JobTracker
          tracker={tracker}
          duplicatesByJobId={duplicatesByJobId}
          onDismissDuplicate={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("Looks like the same posting");
    expect(container.textContent).toContain(AGGREGATOR);
    expect(tracker.merge).not.toHaveBeenCalled();
  });

  it("does not merge on the first click — the offer only opens a confirm", () => {
    const { tracker, duplicatesByJobId } = pairedTracker();
    act(() =>
      root.render(
        <JobTracker
          tracker={tracker}
          duplicatesByJobId={duplicatesByJobId}
          onDismissDuplicate={vi.fn()}
        />,
      ),
    );
    click("Merge into this one");
    expect(tracker.merge).not.toHaveBeenCalled();
    expect(container.textContent).toContain("fold the other one into it");
  });

  it("merges only on the explicit confirm, with the clicked row as the survivor", () => {
    const { tracker, duplicatesByJobId } = pairedTracker();
    act(() =>
      root.render(
        <JobTracker
          tracker={tracker}
          duplicatesByJobId={duplicatesByJobId}
          onDismissDuplicate={vi.fn()}
        />,
      ),
    );
    click("Merge into this one");
    click("Confirm merge");
    // The FIRST row's offer was clicked, so the first row survives.
    expect(tracker.merge).toHaveBeenCalledWith("a", "b");
  });

  it("cancels back to the offer without merging", () => {
    const { tracker, duplicatesByJobId } = pairedTracker();
    act(() =>
      root.render(
        <JobTracker
          tracker={tracker}
          duplicatesByJobId={duplicatesByJobId}
          onDismissDuplicate={vi.fn()}
        />,
      ),
    );
    click("Merge into this one");
    click("Cancel");
    expect(tracker.merge).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Looks like the same posting");
  });

  it("'Not the same' suppresses the pairing and merges nothing", () => {
    const { tracker, duplicatesByJobId } = pairedTracker();
    const onDismissDuplicate = vi.fn();
    act(() =>
      root.render(
        <JobTracker
          tracker={tracker}
          duplicatesByJobId={duplicatesByJobId}
          onDismissDuplicate={onDismissDuplicate}
        />,
      ),
    );
    click("Not the same");
    expect(onDismissDuplicate).toHaveBeenCalledWith("a", "b");
    expect(tracker.merge).not.toHaveBeenCalled();
  });

  it("renders no notice at all for a caller that supplied no matches", () => {
    const { tracker } = pairedTracker();
    act(() => root.render(<JobTracker tracker={tracker} />));
    expect(container.textContent).not.toContain("Looks like the same posting");
  });
});

describe("JobTracker: a repost cluster states the churn instead of offering merges (#754)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const JUN_15 = Date.UTC(2026, 5, 15);

  /** Six records of one role at one company, first and last 49 days apart, in
   *  two different status buckets — the shape the issue measured. Every name is
   *  invented. */
  function relisted(): JobRecord[] {
    return Array.from({ length: 6 }, (_unused, i) =>
      job({
        id: `r${i}`,
        title: "Head of Engineering",
        company: "Bellhaven Talent",
        status: i === 5 ? "archived" : "interested",
        createdAt: JUN_15 + Math.round((49 * DAY * i) / 5),
        updatedAt: JUN_15 + Math.round((49 * DAY * i) / 5),
      }),
    );
  }

  function mount(jobs: JobRecord[]) {
    const tracker = makeTracker(jobs);
    const clusters = findRepostClusters(jobs);
    act(() =>
      root.render(
        <JobTracker
          tracker={tracker}
          repostClusters={clusters}
          // The sweep the tracker's own hook runs, done here because this
          // component is tracker-injected: with the clusters in hand every
          // pairing in the group is suppressed, so the map is empty.
          duplicatesByJobId={new Map()}
          onDismissDuplicate={vi.fn()}
        />,
      ),
    );
    return tracker;
  }

  /** The repost section opens COLLAPSED, so a test about its rows has to open
   *  it. Identified by `aria-expanded` on a button whose label names the
   *  section, since the status sections use the same disclosure idiom. */
  function expandReposts() {
    const button = [...container.querySelectorAll("button[aria-expanded]")].find(
      (b) => b.textContent?.includes("Reposted roles"),
    );
    act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  it("renders ONE repost row for the group, stating the count and the span", () => {
    mount(relisted());
    expandReposts();
    const rows = [...container.querySelectorAll("li")].filter((li) =>
      li.textContent?.includes("Reposted"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Reposted 6×");
    expect(rows[0].textContent).toContain("Head of Engineering");
    expect(rows[0].textContent).toContain("Bellhaven Talent");
    expect(rows[0].textContent).toContain("49 days apart");
  });

  it("offers no merge anywhere in the group, and merges nothing by rendering", () => {
    const tracker = mount(relisted());
    expandReposts();
    const merge = [...container.querySelectorAll("button")].filter(
      (b) => b.textContent === "Merge into this one",
    );
    expect(merge).toEqual([]);
    expect(tracker.merge).not.toHaveBeenCalled();
  });

  it("keeps the repost section closed on mount, above an open pipeline", () => {
    // The section is a heads-up, the sections below it are the work. Rendering
    // 28 clusters open put a page of scroll between the two.
    mount(relisted());
    const reposts = [...container.querySelectorAll("button[aria-expanded]")].find(
      (b) => b.textContent?.includes("Reposted roles"),
    );
    expect(reposts?.getAttribute("aria-expanded")).toBe("false");
    // …while the Interested rows it sits above are still right there.
    expect(container.textContent).toContain("Interested · 5");
  });

  it("sweeps the clustered rows through the tracker, and only on confirm", async () => {
    const tracker = mount(relisted());
    // Rendering the trigger writes nothing.
    expect(tracker.archiveReposted).not.toHaveBeenCalled();

    const trigger = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Archive all reposted roles",
    );
    act(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    // Opening the confirm writes nothing either.
    expect(tracker.archiveReposted).not.toHaveBeenCalled();

    const dialog = container.querySelector("dialog[open]") as HTMLElement;
    const confirm = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === "Archive",
    );
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(tracker.archiveReposted).toHaveBeenCalledWith(findRepostClusters(relisted()));
  });

  it("still lists all six records in their own status sections", () => {
    // The statement collapses the OFFER, not the library: a cluster spans
    // status buckets, so collapsing the rows would strand records out of the
    // section they were filed in and make the header counts lie.
    mount(relisted());
    const header = container.querySelector("header")?.textContent;
    expect(header).toContain("6");
    expect(container.textContent).toContain("Interested · 5");
    expect(container.textContent).toContain("Archived · 1");
  });

  it("renders nothing for a library with no re-listed role", () => {
    const jobs = [
      job({ id: "a", title: "Head of Engineering", createdAt: JUN_15 }),
      job({ id: "b", title: "Head of Engineering", createdAt: JUN_15 + 3 * DAY }),
    ];
    expect(findRepostClusters(jobs)).toEqual([]);
    mount(jobs);
    expect(container.textContent).not.toContain("Reposted");
  });
});
