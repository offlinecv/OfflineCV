// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * JobArchiveSweepDialog (#759). Covers the acceptance criteria the issue
 * names for the dialog itself: the count and the write agree because they
 * are the SAME predicate, and a cutoff matching zero rows disables Confirm
 * rather than running a no-op. The predicate itself
 * (`isSweepable`/`jobsToArchive`) is unit-tested at module scope in
 * `job-archive-sweep.test.ts`; the domain-layer write is covered in
 * `job-tracker.test.ts`. This file only exercises the UI wiring between them.
 *
 * jsdom has no `HTMLDialogElement.showModal`/`close` — the polyfill, the
 * per-test root, and the "scope assertions to the OPEN dialog" recipe all
 * come from `__test-utils__/dialog-dom.ts`; see `JobLetterIndicator.test.tsx`
 * for the same shape.
 */

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { JobArchiveSweepDialog } from "./JobArchiveSweepDialog.tsx";
import { installDialogPolyfill, setupDomRoot } from "./__test-utils__/dialog-dom.ts";
import type { JobRecord } from "../../lib/storage/index.ts";

installDialogPolyfill();
const dom = setupDomRoot();

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function job(over: Partial<JobRecord>): JobRecord {
  return {
    id: over.id ?? crypto.randomUUID(),
    createdAt: NOW - 60 * DAY_MS,
    updatedAt: NOW - 60 * DAY_MS,
    title: "SWE",
    company: "Acme",
    status: "interested",
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

function setCutoff(value: number) {
  const input = openDialogEl().querySelector(
    "input[type='number']",
  ) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("JobArchiveSweepDialog", () => {
  it("previews the count jobsToArchive would compute for the default cutoff", () => {
    const jobs = [
      job({ title: "Old", createdAt: NOW - 60 * DAY_MS }),
      job({ title: "Fresh", createdAt: NOW - 1 * DAY_MS }),
      job({ title: "Pipeline", status: "applied", createdAt: NOW - 400 * DAY_MS }),
    ];
    dom.render(<JobArchiveSweepDialog jobs={jobs} archiveOlderThan={vi.fn()} />);
    clickButton(dom.container, "Archive old jobs");
    // Default cutoff (30 days): only "Old" qualifies — "Fresh" is too recent
    // and "Pipeline" is outside the Interested bucket however old.
    expect(openDialogEl().textContent).toContain("1 job");
  });

  it("disables Confirm when the cutoff matches zero rows, rather than running a no-op", () => {
    const jobs = [job({ title: "Fresh", createdAt: NOW - 1 * DAY_MS })];
    dom.render(<JobArchiveSweepDialog jobs={jobs} archiveOlderThan={vi.fn()} />);
    clickButton(dom.container, "Archive old jobs");
    const confirm = [...openDialogEl().querySelectorAll("button")].find(
      (b) => b.textContent === "Archive",
    ) as HTMLButtonElement | undefined;
    expect(confirm?.disabled).toBe(true);
  });

  it("enables Confirm once the cutoff matches at least one row, and calls archiveOlderThan with it", async () => {
    const jobs = [job({ title: "Old", createdAt: NOW - 60 * DAY_MS })];
    const archiveOlderThan = vi.fn(async () => 1);
    dom.render(<JobArchiveSweepDialog jobs={jobs} archiveOlderThan={archiveOlderThan} />);
    clickButton(dom.container, "Archive old jobs");
    const confirm = [...openDialogEl().querySelectorAll("button")].find(
      (b) => b.textContent === "Archive",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);

    await act(async () => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(archiveOlderThan).toHaveBeenCalledWith(30);
    // Confirm swaps to a done state in place — no toast primitive in this repo.
    expect(openDialogEl().textContent).toContain("Archived 1 job.");
  });

  it("recomputes the preview count and re-disables Confirm as the cutoff changes", () => {
    const jobs = [job({ title: "Old", createdAt: NOW - 60 * DAY_MS })];
    dom.render(<JobArchiveSweepDialog jobs={jobs} archiveOlderThan={vi.fn()} />);
    clickButton(dom.container, "Archive old jobs");
    const confirmFor = () =>
      [...openDialogEl().querySelectorAll("button")].find(
        (b) => b.textContent === "Archive",
      ) as HTMLButtonElement;
    expect(confirmFor().disabled).toBe(false);

    // Raise the cutoff past the one row's age — nothing qualifies anymore.
    setCutoff(90);
    expect(confirmFor().disabled).toBe(true);
    expect(openDialogEl().textContent).toContain("0 jobs");
  });
});
