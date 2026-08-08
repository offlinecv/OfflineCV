// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The departure marker's lifetime, exercised through the REAL surfaces that
 * write and answer it — `App` (`/`) and `JobsApp` (`/jobs/`).
 *
 * `nav-return.test.ts` covers the module in isolation and
 * `PageShell.test.tsx` covers the shell's contract with a hand-written
 * callback, but neither is evidence about the WIRING: reverting
 * `onSavedJobsNavigate={goToSavedJobs}` out of `App.tsx` left the whole
 * suite green. So the invariant the fix exists for — only `/` marks a
 * departure — is pinned here, at the surfaces themselves.
 *
 * The old two-hop test (root → second surface → Saved jobs → /jobs/) that
 * pinned the "marker consumed at CLICK time survives past its leg" bug is
 * gone with the second surface itself (#576). The single-hop invariants
 * below cover what remains: the app root marks, the workbench absorbs.
 *
 * jsdom implements no navigation, so the fallback branch assigning
 * `location.href` logs a "Not implemented: navigation" notice from the virtual
 * console. Expected noise; the assertions are on the `history.back` spy.
 */

import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../App.tsx";
import JobsApp from "../jobs/JobsApp.tsx";
import { DB_NAME, closeDB } from "./storage/index.ts";
import { markDeparture, readDepartureMarker } from "./nav-return.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root | undefined;
let back: ReturnType<typeof vi.fn>;

/** Drain `useResumeLibrary`'s (and the tracker's) initial fake-indexeddb reads
 *  — they resolve over several macrotask ticks (open → upgrade → transaction),
 *  not one, so an unmount or a `deleteDB` before they settle rejects mid-flight.
 *  Same shape as `JobsApp.test.tsx`'s loop. */
async function flushIndexedDb(turns = 10) {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
  await flushIndexedDb();
}

function unmount() {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
}

/** Click the visible chrome by its label — a `Button` renders a `<button>`,
 *  the "Saved jobs" entry point is an `<a href>`. */
function clickChrome(label: string) {
  const el = [...container.querySelectorAll("button, a")].find((node) =>
    node.textContent?.includes(label),
  );
  expect(el, `no chrome labelled "${label}"`).toBeDefined();
  act(() => {
    el!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

beforeEach(async () => {
  await closeDB();
  await deleteDB(DB_NAME);
  sessionStorage.clear();
  // useGitHubStars / useUpdateChecker both fetch on mount and both swallow a
  // failure — stubbed so this suite never touches the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
  back = vi.fn();
  vi.spyOn(window.history, "back").mockImplementation(back);
});

afterEach(async () => {
  await flushIndexedDb();
  if (root) unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the marker belongs to ONE visit, not to the next click", () => {
  it("a legitimate / → /jobs/ trip still goes back through history", async () => {
    // The feature itself: `/` marked the trip, `/jobs/`'s back control uses
    // history.back() so the parse + inline edits survive via bfcache.
    markDeparture();
    await mount(createElement(JobsApp));
    clickChrome("Back to your resume");
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("a direct /jobs/ visit falls back rather than firing into a foreign history stack", async () => {
    await mount(createElement(JobsApp));
    clickChrome("Back to your resume");
    expect(back).not.toHaveBeenCalled();
  });
});

describe("only `/` marks a departure", () => {
  it("`/` supplies the Saved jobs callback, so its header link marks the trip", async () => {
    // Pins `onSavedJobsNavigate={goToSavedJobs}` in App.tsx: removing it left
    // the entire suite green (1170 passed) before this test existed.
    await mount(createElement(App));
    clickChrome("Saved jobs");
    expect(readDepartureMarker()).toBe(true);
  });

  it("`/jobs/` does not render the link at all", async () => {
    await mount(createElement(JobsApp));
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Saved jobs",
    );
    expect(link).toBeUndefined();
  });
});
