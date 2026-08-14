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
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DB_NAME, closeDB } from "../lib/storage/index.ts";
import { createJob } from "../lib/job-tracker.ts";
import { saveResumeToLibrary } from "../lib/resume-library.ts";
import type { CascadeResult } from "../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../lib/score/score.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import { writeJobsHandoff } from "../lib/jobs-handoff.ts";
import { markJourneyMilestone } from "../lib/journey-progress.ts";
import JobsApp from "./JobsApp.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLElement;
let root: Root;

beforeAll(async () => {
  // Warm the module `useSavedJobRatings` dynamic-imports — see that hook's own
  // test for why: cold, the first import pulls the whole rating graph and can
  // outlast a fixed poll budget under a loaded runner.
  await import("../lib/job-search/rate-saved-jobs.ts");
});

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

  it("lands on Saved jobs when arriving via the #saved hash (#715)", async () => {
    window.history.pushState({}, "", "/jobs/#saved");

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

  it("switches to Saved jobs when the hash changes on a page ALREADY open (#715)", async () => {
    // The regression this pins: a user sitting on `/jobs/` who follows the
    // `/jobs/#saved` link the cover-letter skill hands out changes only the
    // fragment. Same document, no navigation, no remount — so a mount-only
    // read leaves the tab where it was and nothing visible happens.
    window.history.pushState({}, "", "/jobs/");

    await act(async () => {
      root.render(<JobsApp />);
    });
    await flushIndexedDb();
    expect(
      container.querySelector<HTMLElement>("#jobs-panel-library")?.hidden,
    ).toBe(true);

    await act(async () => {
      window.location.hash = "#saved";
      // jsdom queues `hashchange` as a task rather than firing it inline.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      container.querySelector<HTMLElement>("#jobs-panel-search")?.hidden,
    ).toBe(true);
    expect(
      container.querySelector<HTMLElement>("#jobs-panel-library")?.hidden,
    ).toBe(false);
  });
});

describe("JobsApp: Saved jobs fit rating falls back to the library résumé (#724)", () => {
  /** Minimal stand-in for `runCascade`'s output — `saveResumeToLibrary` stores
   *  this opaquely and hands it back unchanged (its stamped shapeVersion
   *  matches on read), so only the one field `useFallbackResume` actually
   *  reads (`canonical.fields`) needs to be real. */
  function fakeResult(skills: string[]): CascadeResult {
    return {
      canonical: { fields: { skills, experience: [], education: [] } },
    } as unknown as CascadeResult;
  }
  const FAKE_SCORE = { overall: 80 } as unknown as AnonymousAtsScore;

  const JD =
    "We need a React and TypeScript engineer for our frontend web application.";

  it("rates a saved job against the most recently saved résumé, and names it, with no handoff present", async () => {
    // No `writeJobsHandoff` call — this is exactly the direct-visit case the
    // issue describes: a bookmark, a pasted link, or a fresh tab.
    await saveResumeToLibrary({
      filename: "my-resume.pdf",
      sourceKind: "pdf",
      result: fakeResult(["React", "TypeScript"]),
      score: FAKE_SCORE,
    });
    await createJob({ title: "Frontend Engineer", company: "Acme", jdText: JD });

    await act(async () => {
      root.render(<JobsApp />);
    });
    await flushIndexedDb(50);

    clickTab("Saved jobs");
    const libraryPanel = container.querySelector<HTMLElement>(
      "#jobs-panel-library",
    );
    expect(libraryPanel?.textContent).toContain("Fit vs.");
    expect(libraryPanel?.textContent).toContain("my-resume.pdf");
    // The shared `RatingStars` widget, not just the attribution text — the
    // row is actually rated, not merely labeled.
    expect(libraryPanel?.querySelector('[role="img"]')).not.toBeNull();
  });

  it("shows neither stars nor an attribution with no saved résumé and no handoff", async () => {
    await createJob({ title: "Frontend Engineer", company: "Acme", jdText: JD });

    await act(async () => {
      root.render(<JobsApp />);
    });
    await flushIndexedDb(20);

    clickTab("Saved jobs");
    const libraryPanel = container.querySelector<HTMLElement>(
      "#jobs-panel-library",
    );
    expect(libraryPanel?.textContent).not.toContain("Fit vs.");
    expect(libraryPanel?.querySelector('[role="img"]')).toBeNull();
    // Unchanged empty-resume copy (#700) — the fallback must not paper over a
    // genuinely resume-less library with a misleading message.
    expect(libraryPanel?.textContent).toContain(
      "Open this workbench from your resume",
    );
  });
});

describe("JobsApp: the rail reads the ledger the handoff pointed at (#826)", () => {
  const parsed: HeuristicParsedResume = {
    full_name: "Dana Fixture",
    skills: ["React"],
    experience: [],
    education: [],
  };

  /** The rail trigger whose accessible sentence names this stage. */
  function railStage(label: string): HTMLElement {
    const found = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(`: ${label}.`),
    );
    if (!found) throw new Error(`no rail trigger for ${label}`);
    return found;
  }

  it("marks a stage this résumé already completed on `/`", async () => {
    // `/jobs/` cannot derive the ledger key — it receives the APPLIED parse and
    // the key is the pristine one — so the key riding the handoff is the ONLY
    // thing that makes the arc continuous across the two entries.
    writeJobsHandoff({ parsed, journeyKey: "a1b2c3d4" });
    markJourneyMilestone("a1b2c3d4", "download");

    await act(async () => {
      root.render(<JobsApp />);
    });
    await flushIndexedDb(20);

    expect(railStage("Download").textContent).toContain("Download. Done.");
    expect(railStage("Download").textContent).toContain("\u2713");
  });

  it("shows fewer marks, never a wrong one, when the handoff carried no key", async () => {
    // The accepted gap: a direct visit whose résumé came from the library
    // fallback has no `/` page behind it to have minted a key.
    writeJobsHandoff({ parsed });
    markJourneyMilestone("a1b2c3d4", "download");

    await act(async () => {
      root.render(<JobsApp />);
    });
    await flushIndexedDb(20);

    expect(railStage("Download").textContent).toContain("Download. Ready.");
  });
});
