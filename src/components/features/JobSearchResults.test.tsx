// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Render coverage for JobSearchResults (#319) — the five-state Results region.
 * Drives each SearchPhase directly (idle / loading / failed / loaded) plus the
 * loaded sub-branches inside `Loaded` (results, paged list, empty, partial
 * degrade, total degrade → hard error) so every state from UX spec §2 renders.
 * The paging assertions are the regression guard for the old `RENDER_CAP`: they
 * check the 21st match is REACHABLE, not merely that a footnote counts it.
 * Real `RankedJob`s built via `rankPostings`; raw createRoot + act.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  JobSearchResults,
  type SearchPhase,
} from "./JobSearchResults.tsx";
import { rankPostings } from "../../lib/job-search/rank.ts";
import type { JobSearchResult } from "../../lib/job-search/search.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import type { JobPosting } from "../../lib/job-search/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const parsed: HeuristicParsedResume = {
  skills: ["React", "TypeScript"],
  experience: [],
  education: [],
};

function posting(id: string): JobPosting {
  return {
    id,
    title: `React Engineer ${id}`,
    company: `Co ${id}`,
    location: "Remote",
    url: `https://example.com/${id}`,
    description: "React and TypeScript role.",
    source: "Remotive",
  };
}

/** Shares none of the parsed résumé's skills, so `rankPostings` scores it 0. */
function weakPosting(id: string): JobPosting {
  return {
    id,
    title: `Rust Engineer ${id}`,
    company: `Co ${id}`,
    location: "Remote",
    url: `https://example.com/${id}`,
    description: "We need Rust and Kubernetes and Terraform experts.",
    source: "Remotive",
  };
}

function loaded(
  count: number,
  degradedProviders: string[] = [],
  providerCount = 3,
  excludeSuppressed = false,
  roleSuppressed = false,
  locationSuppressed = false,
  locationFilteredOut = 0,
): JobSearchResult {
  const jobs = rankPostings(
    parsed,
    Array.from({ length: count }, (_, i) => posting(String(i))),
  );
  return {
    jobs,
    degradedProviders,
    providerCount,
    excludeSuppressed,
    roleSuppressed,
    locationSuppressed,
    locationFilteredOut,
    rawPostings: [],
  };
}

let container: HTMLDivElement;
let root: Root;

/** Pagination controls, found by their visible label inside the results nav. */
function navButton(el: HTMLElement, text: string): HTMLButtonElement {
  const nav = el.querySelector("nav");
  const button = [...(nav?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) throw new Error(`no "${text}" button in the pagination nav`);
  return button as HTMLButtonElement;
}

const prevButton = (el: HTMLElement) => navButton(el, "Prev");
const nextButton = (el: HTMLElement) => navButton(el, "Next");

function render(phase: SearchPhase) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(JobSearchResults, { phase, onRetry: () => {} }),
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("JobSearchResults", () => {
  it("idle renders nothing", () => {
    expect(render({ kind: "idle" }).textContent).toBe("");
  });

  it("loading renders skeleton + status line", () => {
    const el = render({ kind: "loading" });
    expect(el.textContent).toContain("Searching remote/tech boards");
  });

  it("failed renders the hard error with a retry", () => {
    const el = render({ kind: "failed" });
    expect(el.textContent).toContain("Couldn't reach any of the job feeds");
    expect(el.textContent).toContain("Retry search");
  });

  it("loaded with results renders the sample label + cards", () => {
    const el = render({ kind: "loaded", result: loaded(2) });
    expect(el.textContent).toContain("sample");
    expect(el.textContent).toContain("2 matches ranked by fit");
    expect(el.querySelectorAll("h3").length).toBe(2);
  });

  it("pages the list instead of capping it — page 1 shows the first 20 of 25", () => {
    const el = render({ kind: "loaded", result: loaded(25) });
    expect(el.querySelectorAll("h3").length).toBe(20);
    expect(el.textContent).toContain("Showing 1–20 of 25 matches");
    // No "narrow the query" instruction: every match is reachable by paging.
    expect(el.textContent).not.toContain("Narrow the query");
    const nav = el.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toContain("page 1 of 2");
    // Prev is unreachable on the first page; Next is not.
    expect(prevButton(el).disabled).toBe(true);
    expect(nextButton(el).disabled).toBe(false);
  });

  it("Next reveals the REMAINING matches — the tail is not discarded", () => {
    const el = render({ kind: "loaded", result: loaded(25) });
    act(() => nextButton(el).click());

    expect(el.querySelectorAll("h3").length).toBe(5);
    expect(el.textContent).toContain("Showing 21–25 of 25 matches");
    // Postings 20–24 are exactly the ones page 1 could never show.
    expect(el.textContent).toContain("React Engineer 20");
    expect(el.textContent).toContain("React Engineer 24");
    expect(el.textContent).not.toContain("React Engineer 0★");
    expect(nextButton(el).disabled).toBe(true);
    expect(prevButton(el).disabled).toBe(false);
  });

  it("a numbered jump goes straight to that page", () => {
    const el = render({ kind: "loaded", result: loaded(45) });
    const page3 = [...el.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Page 3",
    ) as HTMLButtonElement;
    act(() => page3.click());

    expect(el.textContent).toContain("Showing 41–45 of 45 matches");
    expect(page3.getAttribute("aria-current")).toBe("page");
  });

  it("a single page renders no pagination control at all", () => {
    const el = render({ kind: "loaded", result: loaded(20) });
    expect(el.querySelectorAll("h3").length).toBe(20);
    expect(el.querySelector("nav")).toBeNull();
    expect(el.textContent).not.toContain("Showing 1–20");
  });

  it("a new, shorter result set resets the page instead of showing nothing", () => {
    const el = render({ kind: "loaded", result: loaded(45) });
    act(() => nextButton(el).click());
    expect(el.textContent).toContain("Showing 21–40 of 45");

    // Same component, new result identity (a fresh Search or a live re-rank).
    act(() => {
      root.render(
        createElement(JobSearchResults, {
          phase: { kind: "loaded", result: loaded(3) },
          onRetry: () => {},
        }),
      );
    });

    expect(el.querySelectorAll("h3").length).toBe(3);
    expect(el.querySelector("nav")).toBeNull();
  });

  it("loaded with a partial degrade notes the missing feed", () => {
    const el = render({
      kind: "loaded",
      result: loaded(1, ["Jobicy"]),
    });
    expect(el.textContent).toContain("Couldn't reach Jobicy");
  });

  it("loaded with zero jobs (no degrade) renders the empty state", () => {
    const el = render({ kind: "loaded", result: loaded(0) });
    expect(el.textContent).toContain("No matching postings");
  });

  it("all providers degraded → hard error with retry", () => {
    const el = render({
      kind: "loaded",
      result: loaded(0, ["Remotive", "Arbeitnow", "Jobicy"], 3),
    });
    expect(el.textContent).toContain("Couldn't reach any of the job feeds");
    expect(el.textContent).toContain("Retry search");
  });

  it("collapses below-threshold postings into a labelled, expandable weak-matches section (issue 567)", () => {
    const jobs = rankPostings(parsed, [posting("s1"), weakPosting("w1")]);
    const result: JobSearchResult = {
      jobs,
      degradedProviders: [],
      providerCount: 1,
      excludeSuppressed: false,
      roleSuppressed: false,
      locationSuppressed: false,
      locationFilteredOut: 0,
      rawPostings: [],
    };
    const el = render({ kind: "loaded", result });

    // Strong posting renders immediately; the weak one is named in the
    // collapsed toggle but its card is not yet in the DOM.
    expect(el.querySelectorAll("h3").length).toBe(1);
    expect(el.textContent).toContain("React Engineer s1");
    expect(el.textContent).not.toContain("Rust Engineer w1");
    expect(el.textContent).toContain("weak matches (1)");
    // Header names the cut, derived from the single threshold constant.
    expect(el.textContent).toContain("below 2.5★ match");

    const toggle = [...el.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-expanded") === "false" &&
      b.textContent?.includes("weak matches"),
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();

    act(() => toggle.click());

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelectorAll("h3").length).toBe(2);
    expect(el.textContent).toContain("Rust Engineer w1");
  });

  it("an all-weak result set still shows results — auto-expands rather than rendering empty (issue 567)", () => {
    const jobs = rankPostings(parsed, [weakPosting("w1"), weakPosting("w2")]);
    const result: JobSearchResult = {
      jobs,
      degradedProviders: [],
      providerCount: 1,
      excludeSuppressed: false,
      roleSuppressed: false,
      locationSuppressed: false,
      locationFilteredOut: 0,
      rawPostings: [],
    };
    const el = render({ kind: "loaded", result });

    // No strong matches, but the weak section is auto-expanded, not hidden.
    expect(el.querySelectorAll("h3").length).toBe(2);
    expect(el.textContent).toContain("Rust Engineer w1");
    expect(el.textContent).toContain("Rust Engineer w2");
    const toggle = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("weak matches"),
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("Hide weak matches (2)");
  });
});

describe("JobSearchResults local-only notices (issue 809)", () => {
  it("states how many postings the local-only filter hid, and how to get them back", () => {
    const el = render({
      kind: "loaded",
      result: loaded(2, [], 3, false, false, false, 4),
    });
    expect(el.textContent).toContain("4 postings hidden as too far away");
    expect(el.textContent).toContain("untick");
  });

  it("says posting, singular, for one", () => {
    const el = render({
      kind: "loaded",
      result: loaded(2, [], 3, false, false, false, 1),
    });
    expect(el.textContent).toContain("1 posting hidden as too far away");
  });

  it("says nothing at all when the filter removed nothing", () => {
    const el = render({ kind: "loaded", result: loaded(2) });
    expect(el.textContent).not.toContain("hidden as too far away");
  });

  it("explains a suppressed local-only filter rather than showing an empty page", () => {
    const el = render({
      kind: "loaded",
      result: loaded(2, [], 3, false, false, true, 0),
    });
    expect(el.textContent).toContain("None of these postings say where they are");
  });
});
