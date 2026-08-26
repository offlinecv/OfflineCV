// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * useJobLetters (#715, #766): the grouping + sort the Saved jobs library depends
 * on for its per-row indicator, and since #766 the three-way scope split under
 * it. Exercised through a probe component against `fake-indexeddb`, same pattern
 * as `useResumeLibrary.test.tsx`; the pure grouping gets its own describe at the
 * bottom, where the `undefined`-key hazard is visible without a render.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DB_NAME, closeDB, saveLetter } from "../lib/storage/index.ts";
import { tick } from "../lib/storage/__test-utils__/clock.ts";
import type { LetterRecord } from "../lib/storage/index.ts";
import { useJobLetters, groupByScope, type JobLetters } from "./useJobLetters.ts";

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

  it("exposes every letter flat for the resolution chain to run over (#767)", async () => {
    await saveLetter({ jobId: "job-1", body: "for the posting" });
    await saveLetter({ companyKey: "northwind", body: "why Northwind" });
    await saveLetter({ body: "my story" });
    await mount();

    // The same records the three views were built from — one store read, four
    // shapes. `resolveLetterForJob` takes this one.
    expect(latest?.all).toHaveLength(3);
    expect([...(latest?.all ?? [])].map((l) => l.body).sort()).toEqual([
      "for the posting",
      "my story",
      "why Northwind",
    ]);
  });

  it("splits the three scopes, with no undefined-keyed entry in byJobId (#766)", async () => {
    await saveLetter({ jobId: "job-1", body: "for the posting" });
    await saveLetter({ companyKey: "northwind", body: "why Northwind" });
    await saveLetter({ body: "my story" });
    await mount();

    expect([...(latest?.byJobId.keys() ?? [])]).toEqual(["job-1"]);
    expect([...(latest?.byCompanyKey.keys() ?? [])]).toEqual(["northwind"]);
    expect(latest?.standard).toHaveLength(1);
  });
});

/**
 * The grouping itself, at module scope. A rendered probe proves the hook wires
 * it up; these prove the `undefined`-key hazard specifically, which is a
 * property of the loop and not of the subscription around it.
 */
describe("groupByScope (#766)", () => {
  /** Enough of a `LetterRecord` for the grouping — everything it reads is
   *  present and nothing it does not is invented. */
  const letter = (fields: Partial<LetterRecord>): LetterRecord =>
    ({ id: "l", body: "", createdAt: 0, updatedAt: 0, ...fields }) as LetterRecord;

  it("never creates a literal `undefined` key, the failure it exists to prevent", () => {
    const grouped = groupByScope([
      letter({ id: "standard" }),
      letter({ id: "company", companyKey: "northwind" }),
    ]);
    // `Map.set(undefined)` would stringify into an entry every consumer reads as
    // a job — a bucket no `JobRecord.id` can match, holding letters nothing
    // would then find.
    expect(grouped.byJobId.size).toBe(0);
    expect([...grouped.byJobId.keys()]).not.toContain(undefined);
    expect([...grouped.byJobId.keys()]).not.toContain("undefined");
    expect(grouped.standard.map((l) => l.id)).toEqual(["standard"]);
  });

  it("reads a both-keys record as a job letter — the reading it had under v1", () => {
    // `validateLetterRecord` refuses this shape, so it can only arrive from a
    // pre-v2 store or a producer that skipped the validator. Filing it under its
    // job is the only reading that cannot hide it from a surface that already
    // existed.
    const grouped = groupByScope([
      letter({ id: "both", jobId: "job-1", companyKey: "northwind" }),
    ]);
    expect(grouped.byJobId.get("job-1")?.map((l) => l.id)).toEqual(["both"]);
    expect(grouped.byCompanyKey.size).toBe(0);
    expect(grouped.standard).toEqual([]);
  });

  it("sorts every tier most-recently-updated first, standard included", () => {
    const grouped = groupByScope([
      letter({ id: "job-old", jobId: "j", updatedAt: 1 }),
      letter({ id: "job-new", jobId: "j", updatedAt: 2 }),
      letter({ id: "co-old", companyKey: "c", updatedAt: 1 }),
      letter({ id: "co-new", companyKey: "c", updatedAt: 2 }),
      letter({ id: "std-old", updatedAt: 1 }),
      letter({ id: "std-new", updatedAt: 2 }),
    ]);
    expect(grouped.byJobId.get("j")?.map((l) => l.id)).toEqual(["job-new", "job-old"]);
    expect(grouped.byCompanyKey.get("c")?.map((l) => l.id)).toEqual(["co-new", "co-old"]);
    expect(grouped.standard.map((l) => l.id)).toEqual(["std-new", "std-old"]);
  });
});
