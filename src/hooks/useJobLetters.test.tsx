// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useJobLetters (#715): the grouping + sort the Saved jobs library depends on
 * for its per-row indicator. Exercised through a probe component against
 * `fake-indexeddb`, same pattern as `useResumeLibrary.test.tsx`.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DB_NAME, closeDB, saveLetter } from "../lib/storage/index.ts";
import { tick } from "../lib/storage/__test-utils__/clock.ts";
import { useJobLetters, type JobLetters } from "./useJobLetters.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLElement;
let root: Root;
let latest: JobLetters | undefined;

function Probe() {
  latest = useJobLetters();
  return null;
}

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
  latest = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * Render the probe, then pump real macrotasks until `ready` flips — opening a
 * freshly `deleteDB`'d database (upgrade callback included) and reading it
 * back resolves over several real ticks in `fake-indexeddb`, not one
 * microtask, so a fixed single wait is not enough. Bounded so a genuine
 * regression fails the test instead of hanging it.
 */
async function mount(): Promise<void> {
  await act(async () => {
    root.render(<Probe />);
  });
  for (let i = 0; i < 50 && latest?.ready !== true; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("useJobLetters", () => {
  it("starts not-ready with an empty map, then resolves", async () => {
    await mount();
    expect(latest?.ready).toBe(true);
    expect(latest?.byJobId.size).toBe(0);
  });

  it("groups letters by jobId, leaving a job with none absent from the map", async () => {
    await saveLetter({ jobId: "job-1", body: "Dear hiring team," });
    await saveLetter({ jobId: "job-2", body: "Dear hiring team, v2" });
    await mount();
    expect(latest?.byJobId.has("job-1")).toBe(true);
    expect(latest?.byJobId.has("job-2")).toBe(true);
    expect(latest?.byJobId.has("job-3")).toBe(false);
    expect(latest?.byJobId.get("job-1")?.length).toBe(1);
  });

  it("sorts each job's letters most-recently-updated first", async () => {
    await saveLetter({
      jobId: "job-1",
      body: "Older draft",
      label: "Warm open",
    });
    await tick(); // strictly greater `updatedAt` for the second write
    await saveLetter({
      jobId: "job-1",
      body: "Newer draft",
      label: "Short version",
    });

    await mount();
    const forJob = latest?.byJobId.get("job-1");
    expect(forJob?.map((l) => l.label)).toEqual(["Short version", "Warm open"]);
  });

  it("refresh() re-reads the store after a write made after mount", async () => {
    await mount();
    expect(latest?.byJobId.has("job-1")).toBe(false);

    await saveLetter({ jobId: "job-1", body: "Dear hiring team," });
    await act(async () => {
      await latest?.refresh();
    });
    expect(latest?.byJobId.has("job-1")).toBe(true);
  });
});
