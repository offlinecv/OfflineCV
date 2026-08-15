// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `useJourneyProgress` — the two things the pure ledger cannot do on its own.
 *
 * The first is the one that would ship broken and look fine in every unit test
 * of `journey-progress.ts`: **the `/jobs/` → `/` return leg is a bfcache
 * restore, not a remount.** `match` completes on `/jobs/`, the user goes Back,
 * and `/` is restored frozen — no effect re-runs — so a value read once at
 * mount is whatever it was BEFORE the trip and the ✓ the search just earned
 * never appears. `pageshow` is the signal, and the test below is a `pageshow`
 * with no remount at all, which is exactly the shape of the #783 defect.
 *
 * The second is that a mark has to be visible immediately, without waiting for
 * a navigation — the rail is on screen when the export completes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJourneyProgress } from "./useJourneyProgress.ts";
import { markJourneyMilestone } from "../lib/journey-progress.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

interface Probe {
  /** The milestones the hook currently reports, as a sorted, readable string. */
  read: () => string;
  /** Record one, the way a mark site does. */
  mark: (milestone: "fix" | "download" | "match" | "tailor") => void;
}

function mount(key: string | null): Probe {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let mark: Probe["mark"] = () => {};
  const Component = () => {
    const progress = useJourneyProgress(key);
    mark = progress.mark;
    return Object.keys(progress.completed).sort().join(",");
  };
  act(() => root.render(createElement(Component)));
  return {
    read: () => container.textContent ?? "",
    mark: (milestone) => act(() => mark(milestone)),
  };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

beforeEach(() => {
  localStorage.clear();
});

describe("useJourneyProgress", () => {
  it("reports what the ledger already held at mount", () => {
    markJourneyMilestone("a1b2c3d4", "download");
    expect(mount("a1b2c3d4").read()).toBe("download");
  });

  it("shows a mark straight away — the rail is on screen when it happens", () => {
    const probe = mount("a1b2c3d4");
    expect(probe.read()).toBe("");
    probe.mark("download");
    expect(probe.read()).toBe("download");
  });

  it("picks up a mark made elsewhere on `pageshow`, with no remount", () => {
    // The `/jobs/` → `/` return leg. `/` is restored from bfcache, so nothing
    // here re-mounts and no effect re-runs; only `pageshow` fires. Written
    // straight to the ledger, because the OTHER page is what wrote it.
    const probe = mount("a1b2c3d4");
    expect(probe.read()).toBe("");
    markJourneyMilestone("a1b2c3d4", "match");
    // Still stale — the point of the test.
    expect(probe.read()).toBe("");
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(probe.read()).toBe("match");
  });

  it("records nothing at all for a null key", () => {
    // Nothing parsed, so there is no résumé to key a completion to. Marking
    // must be inert rather than inventing a bucket.
    const probe = mount(null);
    probe.mark("download");
    expect(probe.read()).toBe("");
    expect(localStorage.getItem("ocv_journey_progress")).toBeNull();
  });
});
