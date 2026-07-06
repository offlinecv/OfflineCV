// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

// @vitest-environment jsdom

/**
 * Render coverage for JobSearchResults (#319) — the five-state Results region.
 * Drives each SearchPhase directly (idle / loading / failed / loaded) plus the
 * loaded sub-branches inside `Loaded` (results, capped list, empty, partial
 * degrade, total degrade → hard error) so every state from UX spec §2 renders.
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

function loaded(
  count: number,
  degradedProviders: string[] = [],
  providerCount = 3,
): JobSearchResult {
  const jobs = rankPostings(
    parsed,
    Array.from({ length: count }, (_, i) => posting(String(i))),
  );
  return { jobs, degradedProviders, providerCount };
}

let container: HTMLDivElement;
let root: Root;

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

  it("caps the rendered list at 20 and notes the cap", () => {
    const el = render({ kind: "loaded", result: loaded(25) });
    expect(el.querySelectorAll("h3").length).toBe(20);
    expect(el.textContent).toContain("Showing the top 20 of 25");
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
});
