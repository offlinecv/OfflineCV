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
import type { JobTracker as Tracker } from "../../hooks/useJobTracker.ts";
import type { JobRecord } from "../../lib/storage/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
    saveFromMatch: vi.fn(async () => "new-id"),
    exportBackup: vi.fn(async () => {}),
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
