// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";

import { ACTION_VERBS as SCORER_ACTION_VERBS } from "../../score/score.ts";
import { EVAL_ONLY_EXTENSIONS, startsWithActionVerb } from "./verbs.ts";

// #622: the whole point of promoting a verb out of EVAL_ONLY_EXTENSIONS and
// into the scorer's ACTION_VERBS is that the two sets stop disagreeing. If a
// verb ever ends up in both, the eval-only extension is dead weight for that
// verb and the sets can silently re-diverge the next time either is edited.
describe("EVAL_ONLY_EXTENSIONS stays disjoint from ACTION_VERBS", () => {
  it("has no verb in common with the scorer's ACTION_VERBS", () => {
    const overlap = EVAL_ONLY_EXTENSIONS.filter((v) =>
      SCORER_ACTION_VERBS.has(v),
    );
    expect(overlap).toEqual([]);
  });
});

describe("startsWithActionVerb — union of scorer + eval-only sets", () => {
  it.each([
    "Shipped", "Owned", "Won", "Ran", "Secured", "Deployed", "Engineered",
    "Rewrote", "Authored", "Analyzed", "Conducted", "Identified",
    "Presented", "Produced", "Published", "Planned", "Grew", "Founded",
    "Hired", "Partnered", "Defined", "Cut", "Ported", "Rebuilt", "Advised",
    "Shaped", "Standardized", "Instrumented",
  ])("accepts a bullet leading with %s (promoted/new #622 verb)", (verb) => {
    expect(startsWithActionVerb(`${verb} the initiative`)).toBe(true);
  });

  it.each(["Worked", "Helped", "Participated", "Responsible", "Assisted"])(
    "still rejects a bullet leading with %s",
    (verb) => {
      expect(startsWithActionVerb(`${verb} for the team`)).toBe(false);
    },
  );
});
