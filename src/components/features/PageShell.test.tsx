// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The "Saved jobs" header link (#707) and what it is allowed to do on the way
 * out (#706).
 *
 * `PageShell` is chrome shared by all three surfaces, so it cannot know which
 * one it is rendering on — and the departure marker means "this trip started at
 * the app root". When the shell marked the departure itself, `/jd-fit/` got a
 * link that wrote a root marker it had no right to write, which sent `/jobs/`'s
 * "Back to your resume" control to `/jd-fit/` and consumed the marker `/` had
 * written, re-arming the lost-parse bug #706 exists to fix. The shell now asks
 * (`onSavedJobsNavigate`) and the surface answers, so these tests pin BOTH
 * directions: the surface that passes nothing writes nothing, and the surface
 * that passes the real `/` callback writes the handoff `/jobs/` needs.
 *
 * The modified-click case is the second half of the same invariant: a
 * ⌘/ctrl/shift/alt-click on an `<a>` fires an ordinary `click` (unlike
 * middle-click's `auxclick`) while the browser opens a NEW tab and this
 * document stays put, so a callback that ran there would leave a marker
 * attached to no navigation at all.
 *
 * jsdom implements no navigation, so following the link logs a "Not
 * implemented: navigation" notice from the virtual console. Expected noise; the
 * assertions are on sessionStorage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageShell, type PageShellProps } from "./PageShell.tsx";
import { departToJobs } from "../../lib/jobs-departure.ts";
import { readJobsHandoff } from "../../lib/jobs-handoff.ts";
import { readDepartureMarker } from "../../lib/nav-return.ts";
import { savedJobsHref } from "../../lib/jobs-landing.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const parsed: HeuristicParsedResume = {
  full_name: "Dana Fixture",
  skills: ["React"],
  experience: [],
  education: [],
};

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<PageShellProps> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(PageShell, { badge: "alpha", children: null, ...props }),
    );
  });
  return container;
}

function savedJobsLink(el: HTMLElement): HTMLAnchorElement | undefined {
  return [...el.querySelectorAll("a")].find(
    (a) => a.textContent === "Saved jobs",
  );
}

function click(
  link: HTMLAnchorElement,
  init: MouseEventInit = {},
): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  act(() => {
    link.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  sessionStorage.clear();
  // useGitHubStars / useUpdateChecker both fetch on mount and both swallow a
  // failure — stubbed so this suite never touches the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("PageShell — the Saved jobs link", () => {
  it("points at /jobs/ landing on the library tab", () => {
    const link = savedJobsLink(render());
    expect(link?.getAttribute("href")).toBe(savedJobsHref());
  });

  it("is suppressed on /jobs/ itself", () => {
    expect(savedJobsLink(render({ hideSavedJobsLink: true }))).toBeUndefined();
  });

  it("writes NO departure marker when the surface supplies no callback", () => {
    // This is the /jd-fit/ case, and the whole reason the shell no longer marks
    // departures itself. A marker from here would make /jobs/'s "Back to your
    // resume" control land on /jd-fit/ — and swallow the marker `/` wrote.
    const link = savedJobsLink(render());
    click(link!);
    expect(sessionStorage.getItem("ocv_nav_from_root")).toBeNull();
    expect(readDepartureMarker()).toBe(false);
  });

  it("hands the parse over when `/` supplies its callback", () => {
    // Exactly what App.tsx passes: without the handoff the library rates
    // nothing (#700) and tells a user who just parsed a résumé to open the
    // workbench from their résumé.
    const link = savedJobsLink(
      render({ onSavedJobsNavigate: () => departToJobs(parsed) }),
    );
    click(link!);
    expect(readJobsHandoff()?.parsed.full_name).toBe("Dana Fixture");
    expect(readDepartureMarker()).toBe(true);
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["altKey", { altKey: true }],
    ["a non-primary button", { button: 1 }],
  ])("does not run the callback on a %s click", (_label, init) => {
    const onSavedJobsNavigate = vi.fn();
    const link = savedJobsLink(render({ onSavedJobsNavigate }));
    const event = click(link!, init);
    // The browser handled this one somewhere else (new tab / window /
    // download); this document did not move, so nothing may be recorded as if
    // it had.
    expect(onSavedJobsNavigate).not.toHaveBeenCalled();
    // …and the link must still be followable — never preventDefault.
    expect(event.defaultPrevented).toBe(false);
  });

  it("runs the callback on a plain primary click, without preventing it", () => {
    const onSavedJobsNavigate = vi.fn();
    const link = savedJobsLink(render({ onSavedJobsNavigate }));
    const event = click(link!);
    expect(onSavedJobsNavigate).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });
});
