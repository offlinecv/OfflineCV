// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The L1 journey derivation (#812).
 *
 * What is pinned here is the BEHAVIOUR a user reads off the rail — which stage
 * says "you are here", and which stages claim to have something behind them —
 * for each of the five states the two entries can be in. The shape of
 * `JOURNEY_STAGES` is not asserted beyond the two rules a future edit is most
 * likely to break silently: `download` is never current, and the first stage
 * has no empty state to fall back to.
 */

import { describe, it, expect } from "vitest";
import {
  JOURNEY_STAGES,
  deriveJourney,
  isStageReachable,
  journeyStage,
  type JourneySignals,
} from "./journey.ts";

const signals = (over: Partial<JourneySignals> = {}): JourneySignals => ({
  entry: "root",
  hasResume: false,
  jdSteering: false,
  ...over,
});

describe("deriveJourney — where the user is", () => {
  it("puts a first-time visitor on Add résumé, with nothing else populated", () => {
    const journey = deriveJourney(signals());
    expect(journey.current).toBe("add");
    expect(journey.availability).toEqual({
      add: false,
      fix: false,
      match: false,
      tailor: false,
      download: false,
    });
  });

  it("moves to Fix it once a résumé is on screen, opening the rest of the arc", () => {
    const journey = deriveJourney(signals({ hasResume: true }));
    expect(journey.current).toBe("fix");
    expect(journey.availability.add).toBe(true);
    expect(journey.availability.match).toBe(true);
    expect(journey.availability.download).toBe(true);
    // Tailoring needs a JD, not a résumé — a résumé alone never opens it.
    expect(journey.availability.tailor).toBe(false);
  });

  it("moves to Tailor while a JD is steering the rewrite", () => {
    const journey = deriveJourney(signals({ hasResume: true, jdSteering: true }));
    expect(journey.current).toBe("tailor");
    expect(journey.availability.tailor).toBe(true);
  });

  it("refuses to mark Tailor when steering arrives without a résumé", () => {
    // Rule 2 of the module docblock: the ✓ mark states "there is data behind
    // this stage", so marking Tailor over an empty page is a visible lie. Both
    // of today's callers already guard it — `App` because it clears the
    // steering on `parseKey`, `JobsApp` because it passes literal `false` — but
    // an invariant a pure function only holds when its callers remember is one
    // refactor from not holding, and nothing in the signature says the two
    // inputs are related. Called directly, on purpose: this is the shape a
    // third caller would produce.
    for (const entry of ["root", "jobs"] as const) {
      const journey = deriveJourney({ entry, hasResume: false, jdSteering: true });
      expect(journey.availability.tailor).toBe(false);
      expect(journey.current).not.toBe("tailor");
    }
  });

  it("reads /jobs/ as Match jobs when a résumé arrived with the user", () => {
    const journey = deriveJourney(signals({ entry: "jobs", hasResume: true }));
    expect(journey.current).toBe("match");
    expect(journey.availability.match).toBe(true);
  });

  it("still reads /jobs/ as Match jobs on a direct visit with no résumé", () => {
    // A user standing on the search surface with nothing to search against is
    // still standing there — the surface's own empty state says the rest.
    const journey = deriveJourney(signals({ entry: "jobs" }));
    expect(journey.current).toBe("match");
    expect(journey.availability.match).toBe(false);
    expect(journey.availability.add).toBe(false);
  });

  it("never parks the user on Download", () => {
    // The terminal action is reachable from anywhere, but it is not a place
    // you sit: exporting does not end the journey, and a rail that said so
    // would stop inviting the edit-and-re-export loop the product is built on.
    for (const entry of ["root", "jobs"] as const) {
      for (const hasResume of [false, true]) {
        for (const jdSteering of [false, true]) {
          expect(
            deriveJourney({ entry, hasResume, jdSteering }).current,
          ).not.toBe("download");
        }
      }
    }
  });
});

describe("isStageReachable — a rail, not a wizard", () => {
  it("lets a first-time visitor click straight through to any stage", () => {
    // Nothing is locked. An unpopulated stage explains itself; it never
    // refuses the click.
    const journey = deriveJourney(signals());
    expect(isStageReachable(journey, "add")).toBe(true);
  });

  it("sends an unpopulated later stage to its guidance instead of its content", () => {
    const journey = deriveJourney(signals());
    expect(isStageReachable(journey, "fix")).toBe(false);
    expect(isStageReachable(journey, "match")).toBe(false);
    expect(isStageReachable(journey, "download")).toBe(false);
  });

  it("opens every résumé-backed stage once a résumé lands", () => {
    const journey = deriveJourney(signals({ hasResume: true }));
    expect(isStageReachable(journey, "fix")).toBe(true);
    expect(isStageReachable(journey, "match")).toBe(true);
    expect(isStageReachable(journey, "download")).toBe(true);
    expect(isStageReachable(journey, "tailor")).toBe(false);
  });

  it("never shadows the stage the user is already standing on", () => {
    // `/jobs/` with no résumé: Match jobs has nothing behind it, but the user
    // is there — covering the search surface with a card telling them to go
    // elsewhere would hide the surface they just navigated to.
    const journey = deriveJourney(signals({ entry: "jobs" }));
    expect(journey.availability.match).toBe(false);
    expect(isStageReachable(journey, "match")).toBe(true);
  });
});

describe("JOURNEY_STAGES", () => {
  it("gives every stage but the first somewhere to send the user back to", () => {
    const [first, ...rest] = JOURNEY_STAGES;
    expect(first.empty).toBeNull();
    for (const stage of rest) {
      expect(stage.empty).not.toBeNull();
      // The CTA must point at a real, EARLIER stage — a prerequisite that
      // sits later in the arc would loop the user forward into the same wall.
      const target = JOURNEY_STAGES.findIndex(
        (s) => s.id === stage.empty?.prerequisite,
      );
      expect(target).toBeGreaterThanOrEqual(0);
      expect(target).toBeLessThan(JOURNEY_STAGES.indexOf(stage));
    }
  });

  it("keeps Match jobs from colliding with either surface's L2 tab labels", () => {
    // `/` has a tab labelled "Find jobs"; `/jobs/` has one labelled "Search".
    // An L1 stage sharing either name is the ambiguity this rail removes.
    const labels = JOURNEY_STAGES.map((s) => s.label);
    expect(labels).toContain("Match jobs");
    expect(labels).not.toContain("Find jobs");
    expect(labels).not.toContain("Search");
  });

  it("resolves every id, and refuses one it does not know", () => {
    expect(journeyStage("tailor").label).toBe("Tailor");
    expect(() =>
      journeyStage("nope" as Parameters<typeof journeyStage>[0]),
    ).toThrow();
  });

  it("puts Download ahead of the job-search half of the arc", () => {
    // A user who came only to repair what an extractor reads back is finished
    // at Download and never needs a job board, so it cannot be the last stage.
    const ids = JOURNEY_STAGES.map((s) => s.id);
    expect(ids).toEqual(["add", "fix", "download", "match", "tailor"]);
    expect(ids.indexOf("download")).toBeLessThan(ids.indexOf("match"));
  });

  it("omits Tailor everywhere it could not be started from", () => {
    // Tailoring only ever begins at a specific posting's button, so a rail
    // entry for it on a cold `/` names a step with no way in.
    const ids = (s: Partial<JourneySignals>) =>
      deriveJourney({
        entry: "root",
        hasResume: false,
        jdSteering: false,
        ...s,
      }).stages.map((x) => x.id);

    expect(ids({})).not.toContain("tailor");
    expect(ids({ hasResume: true })).not.toContain("tailor");
    // On `/jobs/` the button that starts it is on screen…
    expect(ids({ entry: "jobs" })).toContain("tailor");
    // …and on `/` it appears exactly while a JD is steering the rewrite.
    expect(ids({ hasResume: true, jdSteering: true })).toContain("tailor");
  });

  it("never omits a stage the user is standing on", () => {
    // A `current` id absent from `stages` would render a rail with no
    // `aria-current` at all — the one thing it exists to state.
    for (const entry of ["root", "jobs"] as const) {
      for (const hasResume of [false, true]) {
        for (const jdSteering of [false, true]) {
          const j = deriveJourney({ entry, hasResume, jdSteering });
          expect(j.stages.map((s) => s.id)).toContain(j.current);
        }
      }
    }
  });

  it("keeps availability keyed by every stage, visible or not", () => {
    // Availability is a fact about the DATA; hiding a rail entry must not
    // silently drop the answer for it.
    const j = deriveJourney({
      entry: "root",
      hasResume: true,
      jdSteering: false,
    });
    expect(j.stages.map((s) => s.id)).not.toContain("tailor");
    expect(j.availability.tailor).toBe(false);
    expect(Object.keys(j.availability).sort()).toEqual(
      JOURNEY_STAGES.map((s) => s.id).sort(),
    );
  });
});
