// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * `departToJobs` — the single definition of "leave `/` for `/jobs/`".
 *
 * The defect this guards is a route that navigates but hands nothing over: the
 * saved library on `/jobs/` reads its résumé from the handoff, so a missing
 * write costs every fitness rating (#700) AND shows a "open this workbench from
 * your resume" hint to someone who did exactly that. Both writes, or the route
 * is broken — so both are asserted here rather than at the two call sites.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { departToJobs } from "./jobs-departure.ts";
import { readJobsHandoff, writeJobsHandoff } from "./jobs-handoff.ts";
import { readDepartureMarker } from "./nav-return.ts";
import type { HeuristicParsedResume } from "./heuristics/types.ts";

const parsed: HeuristicParsedResume = {
  full_name: "Dana Fixture",
  skills: ["React"],
  experience: [],
  education: [],
};

beforeEach(() => {
  sessionStorage.clear();
});

describe("departToJobs", () => {
  it("writes the handoff AND marks the departure", () => {
    departToJobs(parsed);
    expect(readJobsHandoff()?.parsed.full_name).toBe("Dana Fixture");
    expect(readDepartureMarker()).toBe(true);
  });

  it("still marks the departure when there is no parse to hand over", () => {
    // The header link renders before any parse — that is its point — and the
    // trip still started at the root, so the back control is right to go there.
    departToJobs(undefined);
    expect(readJobsHandoff()).toBeNull();
    expect(readDepartureMarker()).toBe(true);
  });

  it("CLEARS a previous launch's résumé when departing with no parse", () => {
    // The handoff key is deliberately not one-shot, so skipping the write is
    // not the same as handing over nothing: parse on `/`, visit `/jobs/`, come
    // back, reset the parse, then take the header link — and `/jobs/` ranks the
    // library against the résumé the user just discarded, with its "open this
    // workbench from your resume" hint suppressed because a handoff exists.
    writeJobsHandoff({ parsed });
    departToJobs(undefined);
    expect(readJobsHandoff()).toBeNull();
  });
});
