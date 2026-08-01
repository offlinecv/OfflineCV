// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `useSavedJobRatings` (#700). The rating MATH is covered in
 * `rate-saved-jobs.test.ts`; what only this layer can get wrong is the wiring —
 * the three states it reports (nothing to rate / not settled / settled), and the
 * effect key, which decides when the library is re-rated. That key is the piece
 * `exhaustive-deps` cannot check for us (no `react-hooks` plugin — CLAUDE.md),
 * so it is pinned here in both directions: an edit to a field the rating does
 * not read must NOT re-rate, and an edit to one it does read MUST.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSavedJobRatings } from "./useSavedJobRatings.ts";
import type { JobRating } from "../lib/job-search/rating.ts";
import type { RatableSavedJob } from "../lib/job-search/rate-saved-jobs.ts";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const parsed: HeuristicParsedResume = {
  skills: ["React", "TypeScript"],
  experience: [
    { title: "Frontend Engineer", company: "Acme", description: "Built React apps" },
  ],
  education: [],
};

const JD = "We need a React and TypeScript engineer for our frontend web application.";

let container: HTMLElement;
let root: Root;
let latest: ReadonlyMap<string, JobRating> | null = null;

function Probe({
  jobs,
  resume,
}: {
  jobs: readonly RatableSavedJob[];
  resume?: HeuristicParsedResume;
}) {
  latest = useSavedJobRatings(jobs, resume);
  return null;
}

/**
 * Render, then settle the hook's dynamic import and the state update it feeds.
 *
 * Waits on the CONDITION, not a tick count: the first `import()` of
 * `rate-saved-jobs.ts` is a cold module load and the later ones resolve warm, so
 * any fixed number of turns would be tuned to whichever it saw first. The bound
 * is only a runaway guard.
 */
async function renderProbe(jobs: readonly RatableSavedJob[], resume?: HeuristicParsedResume) {
  await act(async () => {
    root.render(<Probe jobs={jobs} resume={resume} />);
  });
  for (let turn = 0; turn < 100 && latest === null; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // With no résumé nothing will ever resolve — one turn is enough to show the
    // hook stays null rather than settling into an empty map.
    if (resume === undefined) break;
  }
}

beforeAll(async () => {
  // Warm the module the hook dynamic-imports. Cold, it pulls the whole rating
  // graph (rank + coverage + the skill dictionary), and under a loaded runner
  // that transform can outlast any settle budget below — the wait would then be
  // measuring the module loader, not the hook. Warmed here, it waits on React.
  await import("../lib/job-search/rate-saved-jobs.ts");
});

beforeEach(() => {
  latest = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useSavedJobRatings", () => {
  it("reports null when no résumé reached this tab", async () => {
    await renderProbe([{ id: "j1", title: "SWE", jdText: JD }], undefined);
    // Null, not an empty map: "we cannot rate" must not be readable as "rated,
    // and none of them scored".
    expect(latest).toBeNull();
  });

  it("resolves to a map covering only the records with a job description", async () => {
    await renderProbe(
      [
        { id: "with", title: "SWE", jdText: JD },
        { id: "without", title: "SWE" },
      ],
      parsed,
    );
    expect(latest).not.toBeNull();
    expect(latest!.has("with")).toBe(true);
    expect(latest!.has("without")).toBe(false);
  });

  it("does not re-rate when a field the rating never reads changes", async () => {
    // `useJobTracker` hands back a FRESH array after every mutation, so keying
    // the effect on array identity would re-rate the whole library on a notes
    // edit or a status change. Same id/title/jdText ⇒ same result object.
    await renderProbe([{ id: "j1", title: "SWE", jdText: JD }], parsed);
    const first = latest;
    expect(first).not.toBeNull();

    await renderProbe([{ id: "j1", title: "SWE", jdText: JD }], parsed);
    expect(latest).toBe(first);
  });

  it("re-rates when the job description changes", async () => {
    await renderProbe([{ id: "j1", title: "SWE", jdText: JD }], parsed);
    const before = latest!.get("j1")!.fitness;

    await renderProbe(
      [{ id: "j1", title: "SWE", jdText: "We need Rust and Kubernetes and Terraform." }],
      parsed,
    );
    // A stale closure over the old `jobs` would leave this unchanged.
    expect(latest!.get("j1")!.fitness).not.toBeCloseTo(before, 10);
  });

  it("re-rates when a record joins the library — covering it without disturbing the others", async () => {
    await renderProbe([{ id: "j1", title: "SWE", jdText: JD }], parsed);
    const alone = latest!.get("j1")!.fitness;

    await renderProbe(
      [
        { id: "j1", title: "SWE", jdText: JD },
        { id: "j2", title: "SWE", jdText: "Rust, Kubernetes and Terraform, plus React." },
      ],
      parsed,
    );
    // The effect still has to re-fire — the new record needs an entry, and a map
    // missing it renders as "not rated".
    expect(latest!.size).toBe(2);
    expect(latest!.get("j2")).toBeDefined();
    // But #716 made the fitness axis absolute, so the incumbent's stars must NOT
    // move. This assertion is the inverse of what it was: while the axis was
    // set-relative, j1's rating changed the moment j2 was saved.
    expect(latest!.get("j1")!.fitness).toBe(alone);
  });
});
