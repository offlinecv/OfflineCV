// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The departure marker's lifetime, exercised through the REAL surfaces that
 * write and answer it — `App` (`/`), `JdFitApp` (`/jd-fit/`), `JobsApp`
 * (`/jobs/`).
 *
 * `nav-return.test.ts` covers the module in isolation and
 * `PageShell.test.tsx` covers the shell's contract with a hand-written
 * callback, but neither is evidence about the WIRING: reverting
 * `onSavedJobsNavigate={goToSavedJobs}` out of `App.tsx`, or adding a marking
 * callback to `JdFitApp`, left the whole suite green. So the two invariants the
 * fix exists for — only `/` marks a departure, and every non-root surface
 * retires the marker at mount — are pinned here, at the surfaces themselves.
 *
 * The headline case is the two-hop sequence a marker consumed at CLICK time
 * gets wrong: `/` → `/jd-fit/` → (header "Saved jobs") → `/jobs/` → Back. Each
 * step below is a real mount and a real click on visible chrome.
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
import JdFitApp from "../jd-fit/JdFitApp.tsx";
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
  it("/ → /jd-fit/ → Saved jobs → /jobs/: the Back control falls back, it does not land on /jd-fit/", async () => {
    // 1. On `/`, "Check fit against a job" marks the departure (App.tsx).
    markDeparture();

    // 2. `/jd-fit/` loads and absorbs the marker at mount — even though its own
    //    back control is never clicked here.
    await mount(createElement(JdFitApp));
    expect(sessionStorage.getItem("ocv_nav_from_root")).toBeNull();

    // 2b. Its header "Saved jobs" link writes nothing: this surface is not the
    //     app root, so it supplies no `onSavedJobsNavigate`.
    clickChrome("Saved jobs");
    expect(readDepartureMarker()).toBe(false);
    unmount();

    // 3. `/jobs/` loads with no marker of its own, so "Back to your resume"
    //    must NOT fire history.back() — that would land on `/jd-fit/`, a real
    //    page but not the one the label names.
    await mount(createElement(JobsApp));
    clickChrome("Back to your resume");
    expect(back).not.toHaveBeenCalled();
  });

  it("…and /jd-fit/'s own Back control still gets its real history.back()", async () => {
    // The other half of the same defect: with the marker swallowed by `/jobs/`,
    // this control fell back and pushed a fresh blank `/`, losing the parse and
    // every inline edit — the very bug #706 exists to fix.
    markDeparture();
    await mount(createElement(JdFitApp));
    clickChrome("← Parser audit");
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("a legitimate / → /jobs/ trip still goes back through history", async () => {
    // The feature itself: fixing the two-hop bug must not cost the one-hop one.
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

  it("`/jd-fit/` supplies none, so its identical-looking link marks nothing", async () => {
    // Same click, same shared chrome, opposite obligation — and re-introducing
    // a marking callback on JdFitApp also stayed green (633 passed) before.
    await mount(createElement(JdFitApp));
    clickChrome("Saved jobs");
    expect(sessionStorage.getItem("ocv_nav_from_root")).toBeNull();
  });

  it("`/jobs/` does not render the link at all", async () => {
    await mount(createElement(JobsApp));
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Saved jobs",
    );
    expect(link).toBeUndefined();
  });
});
