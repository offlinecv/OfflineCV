// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * JobsApp (#690): Search and Library are peer `Tabs` views, not a stacked
 * flow, and neither may unmount the other's in-progress state on switch.
 *
 * `Tabs` keeps every panel MOUNTED and toggles only the `hidden` attribute
 * (see its own docblock) — a conditional `{tab === "x" && …}` render here
 * would defeat that and unmount whichever panel just went inactive. The
 * assertions below check panel `hidden` directly rather than
 * `container.textContent`, since `textContent` sees hidden nodes too and
 * would pass even for a naive conditional-render implementation.
 *
 * Tab label vs. panel content is deliberately disjoint (#597, #674 "watch
 * for"): the tab reads "Saved jobs", the panel's own heading reads "Tracked
 * jobs" — so a `toContain` on either can't accidentally pass against the
 * other.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DB_NAME, closeDB } from "../lib/storage/index.ts";
import { createJob } from "../lib/job-tracker.ts";
import JobsApp from "./JobsApp.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.pushState({}, "", "/");
});

function clickTab(label: string) {
  const tab = [...container.querySelectorAll('[role="tab"]')].find((el) =>
    el.textContent?.startsWith(label),
  );
  act(() => {
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Drain `useJobTracker`'s and `useResumeLibrary`'s initial fake-indexeddb
 *  reads — both resolve over several macrotask ticks (open → upgrade →
 *  transaction), not one, so a single flush is flaky. Same shape as
 *  `useSavedJobRatings.test.tsx`'s polling loop, just unconditional: nothing
 *  here depends on a specific value settling, only on the requests draining
 *  before the test ends and the next test's `beforeEach` tears the db down. */
async function flushIndexedDb(turns = 10) {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("JobsApp: Search / Saved jobs tabs", () => {
  it("reaches both views, and the library renders a saved record without ever unmounting", async () => {
    await createJob({ title: "Staff Frontend Engineer", company: "Acme" });

    await act(async () => {
      root.render(<JobsApp />);
    });
    // Let useJobTracker's initial listJobs() resolve.
    await act(async () => {
      await Promise.resolve();
    });

    const searchPanel = container.querySelector<HTMLElement>(
      "#jobs-panel-search",
    );
    const libraryPanel = container.querySelector<HTMLElement>(
      "#jobs-panel-library",
    );
    expect(searchPanel).not.toBeNull();
    expect(libraryPanel).not.toBeNull();

    // Search is the default view. No resume was handed off in this test, so
    // it shows the pointer back to `/` — but the library panel already
    // exists in the DOM (just hidden), with its record already loaded.
    expect(searchPanel?.hidden).toBe(false);
    expect(libraryPanel?.hidden).toBe(true);
    expect(searchPanel?.textContent).toContain("No resume loaded");
    expect(libraryPanel?.textContent).toContain("Staff Frontend Engineer");
    expect(libraryPanel?.textContent).toContain("Tracked jobs");

    clickTab("Saved jobs");

    expect(searchPanel?.hidden).toBe(true);
    expect(libraryPanel?.hidden).toBe(false);
    // Same panel elements as before the switch — not a fresh render that
    // happened to reproduce the same text.
    expect(container.querySelector("#jobs-panel-library")).toBe(libraryPanel);
    expect(libraryPanel?.textContent).toContain("Staff Frontend Engineer");

    clickTab("Search");

    expect(searchPanel?.hidden).toBe(false);
    expect(libraryPanel?.hidden).toBe(true);
    // The library's data survives the round trip — it was never unmounted,
    // so there is nothing to re-fetch.
    expect(libraryPanel?.textContent).toContain("Staff Frontend Engineer");
  });
});

describe("JobsApp: landing tab from the URL (#707)", () => {
  it("lands on Search for a plain /jobs/ visit — the losing case for the new param", async () => {
    // No pushState here: default jsdom URL carries no `tab` param, matching a
    // bookmark or a link minted before #707 existed.
    await act(async () => {
      root.render(<JobsApp />);
    });
    await flushIndexedDb();

    expect(
      container.querySelector<HTMLElement>("#jobs-panel-search")?.hidden,
    ).toBe(false);
    expect(
      container.querySelector<HTMLElement>("#jobs-panel-library")?.hidden,
    ).toBe(true);
  });

  it("lands on Saved jobs when arriving via ?tab=library", async () => {
    window.history.pushState({}, "", "/jobs/?tab=library");

    await act(async () => {
      root.render(<JobsApp />);
    });
    await flushIndexedDb();

    expect(
      container.querySelector<HTMLElement>("#jobs-panel-search")?.hidden,
    ).toBe(true);
    expect(
      container.querySelector<HTMLElement>("#jobs-panel-library")?.hidden,
    ).toBe(false);
  });
});
