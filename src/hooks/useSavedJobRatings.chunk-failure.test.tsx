// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * What `useSavedJobRatings` does when its dynamic import FAILS — a real case,
 * not a hypothetical: a tab left open across a deploy asks for a chunk hash
 * that no longer exists.
 *
 * Its own file because the failure has to be injected by mocking the imported
 * module, which is file-scoped: the sibling `useSavedJobRatings.test.tsx` needs
 * the real one.
 *
 * The losing behaviour is silent, which is why it needs a test at all. The hook
 * keeps returning null, and because a résumé IS present the tracker suppresses
 * the line that would explain why no ratings are shown — so the library renders
 * an unexplained blank forever while the only trace, an unhandled promise
 * rejection, goes nowhere.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSavedJobRatings } from "./useSavedJobRatings.ts";
import type { JobRating } from "../lib/job-search/rating.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";

vi.mock("../lib/job-search/rate-saved-jobs.ts", () => {
  throw new Error("Failed to fetch dynamically imported module (simulated)");
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const parsed: HeuristicParsedResume = {
  skills: ["React"],
  experience: [],
  education: [],
};

let container: HTMLElement;
let root: Root;
let latest: ReadonlyMap<string, JobRating> | null = null;

function Probe() {
  latest = useSavedJobRatings([{ id: "j1", title: "SWE", jdText: "React" }], parsed);
  return null;
}

beforeEach(() => {
  latest = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useSavedJobRatings when the rating chunk fails to load", () => {
  it("reports the failure and stays null instead of rejecting unhandled", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      root.render(<Probe />);
    });
    // Let the rejected import settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Null, not an empty map — "we could not rate" must never be readable as
    // "rated, and none of them matched".
    expect(latest).toBeNull();
    // Unhandled, this rejection is invisible to everyone: the console line is
    // the only evidence a user's blank library has a cause.
    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0][0])).toContain("useSavedJobRatings");
  });
});
