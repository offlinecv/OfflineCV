// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";

import { emptyRubricForError, scoreRubric } from "./rubric.ts";
import type { RawRewriteOutput } from "./types.ts";

function out(bullets: string[], raw?: string): RawRewriteOutput {
  return { bullets, raw: raw ?? bullets.join("\n") };
}

describe("scoreRubric — canned good outputs", () => {
  it("passes a strong rewrite of a weak input without inventing numbers", () => {
    // Input has zero numeric tokens, so the output must also have zero —
    // inventing a metric the input didn't contain is a number-preservation
    // failure (the guardrail's "none invented" half).
    const input = [
      "Responsible for handling marketing tasks and supporting the team as needed.",
      "Worked on campaigns to drive engagement.",
    ];
    const output = out([
      "Drove the email nurture sequence rollout, lifting lead-to-MQL conversion across the brand portfolio.",
      "Launched paid-social experiments and ran weekly performance reviews with the brand team.",
    ]);
    const r = scoreRubric({ input, output, fixtureKind: "weak" });
    expect(r.actionVerbLead).toBe(true);
    expect(r.oneLinePerBullet).toBe(true);
    expect(r.lengthSanity).toBe(true);
    expect(r.noPreambleLeak).toBe(true);
    expect(r.numbersPreserved).toBe(true);
    expect(r.dedupEffective).toBeNull(); // n/a for weak fixtures
  });

  it("passes a numeric input whose output preserves every metric", () => {
    const input = [
      "Grew users from 120K to 1.8M between 2022 and 2024, lifting retention 14%.",
      "Drove $4.2M ARR through a 2-tier paywall redesign.",
    ];
    const output = out([
      "Grew weekly actives from 120K to 1.8M (2022-2024), lifting day-7 retention 14% via 7 onboarding tests.",
      "Drove $4.2M incremental ARR with a 2-tier paywall redesign across 3 surfaces.",
    ]);
    const r = scoreRubric({ input, output, fixtureKind: "numeric" });
    expect(r.numbersPreserved).toBe(true);
    expect(r.droppedNumbers).toEqual([]);
    expect(r.addedNumbers).toEqual([]);
  });

  it("passes a redundant input whose output collapses duplicates", () => {
    const input = [
      "Triaged 200+ support tickets per week.",
      "Managed a 200/week ticket queue.",
      "Handled support tickets at 200 per week.",
      "Resolved $85K in disputed enterprise charges.",
    ];
    const output = out([
      "Triaged 200+ inbound support tickets per week across email and chat.",
      "Resolved escalated billing disputes for 40 enterprise accounts, recovering $85K.",
    ]);
    const r = scoreRubric({ input, output, fixtureKind: "redundant" });
    expect(r.dedupEffective).toBe(true);
  });
});

describe("scoreRubric — canned bad outputs", () => {
  it("flags a dropped number", () => {
    const input = ["Drove $4.2M ARR via a 2-tier paywall lift of 23%."];
    const output = out(["Drove ARR via a paywall redesign lifting conversion 23%."]);
    const r = scoreRubric({ input, output, fixtureKind: "numeric" });
    expect(r.numbersPreserved).toBe(false);
    expect(r.droppedNumbers).toContain("$4.2M");
  });

  it("flags an invented number", () => {
    const input = ["Drove ARR via a paywall redesign."];
    const output = out(["Drove $1.2M ARR via a paywall redesign."]);
    const r = scoreRubric({ input, output, fixtureKind: "numeric" });
    expect(r.numbersPreserved).toBe(false);
    expect(r.addedNumbers).toContain("$1.2M");
  });

  it("flags a weak verb lead", () => {
    const input = ["Responsible for marketing."];
    const output = out([
      "Worked on marketing campaigns across 3 channels with the brand team.",
    ]);
    const r = scoreRubric({ input, output, fixtureKind: "weak" });
    expect(r.actionVerbLead).toBe(false);
  });

  it("flags a too-short bullet (length sanity floor)", () => {
    const input = ["Worked on stuff."];
    const output = out(["Did things."]);
    const r = scoreRubric({ input, output, fixtureKind: "weak" });
    expect(r.lengthSanity).toBe(false);
  });

  it("flags a too-long bullet (length sanity ceiling)", () => {
    const input = ["Worked on stuff."];
    const long = `Drove ${"a ".repeat(150)}thing across multiple teams.`;
    const r = scoreRubric({
      input,
      output: out([long]),
      fixtureKind: "weak",
    });
    expect(r.lengthSanity).toBe(false);
  });

  it("flags preamble leakage in the raw response", () => {
    const input = ["Worked on marketing."];
    const output = out(
      ["Drove a 4-touchpoint nurture sequence that lifted MQL conversion 12%."],
      "Here is the rewritten bullets:\nDrove a 4-touchpoint nurture sequence that lifted MQL conversion 12%.",
    );
    const r = scoreRubric({ input, output, fixtureKind: "weak" });
    expect(r.noPreambleLeak).toBe(false);
  });

  it("does NOT flag preamble when the phrase appears only inside a bullet", () => {
    const input = ["Drafted the rules of engagement for the eng-marketing handoff."];
    const output = out([
      "Drafted the rules of engagement document for cross-team handoffs across 4 teams.",
    ]);
    const r = scoreRubric({ input, output, fixtureKind: "weak" });
    expect(r.noPreambleLeak).toBe(true);
  });

  // ── #151: preamble-as-bullet blind spot ─────────────────────────────
  // Llama 3.2 (3B) emits "Here are the rewritten bullets:" as its own
  // line; the runner's line-splitter then makes it `outputBullets[0]`.
  // Before #151, the raw-minus-bullets scan would erase the leaked
  // preamble (because the leaked preamble IS one of the bullets) and the
  // rubric would falsely report `noPreambleLeak = true`. Pin both shapes
  // so a regression here is caught immediately.
  it("flags a preamble line that survived as a bullet (#151)", () => {
    const input = ["Worked on marketing."];
    const output = out(
      [
        "Here are the rewritten bullets:",
        "Drove a 4-touchpoint nurture sequence that lifted MQL conversion 12%.",
      ],
      "Here are the rewritten bullets:\nDrove a 4-touchpoint nurture sequence that lifted MQL conversion 12%.",
    );
    const r = scoreRubric({ input, output, fixtureKind: "weak" });
    expect(r.noPreambleLeak).toBe(false);
  });

  it("flags a preamble-as-bullet even when raw text is empty (#151)", () => {
    // Synthetic edge case: a test-supplied output that splits "weirdly"
    // and produces a preamble bullet without any matching raw text. The
    // per-bullet check must still catch it independently of the raw scan.
    const input = ["A"];
    const output = out(
      ["Here is the rewritten bullets:", "Shipped a real bullet about something concrete."],
      "",
    );
    const r = scoreRubric({ input, output, fixtureKind: "weak" });
    expect(r.noPreambleLeak).toBe(false);
  });

  it("does NOT flag a legitimate bullet that contains a preamble phrase mid-text (#151)", () => {
    // Defensive: the per-bullet check uses `startsWith`, not `includes`,
    // so a bullet that mentions one of the leak phrases inside its body
    // shouldn't trip the rubric. Without this anchor, "Worked as an AI
    // engineer …" would false-positive on the "as an ai" phrase.
    const input = ["W"];
    const output = out([
      "Worked as an AI engineer on the recommendation model pipeline for 3 teams.",
      "Built the alerting system: 12 services, 99.9% uptime over the last 2 quarters.",
    ]);
    const r = scoreRubric({ input, output, fixtureKind: "weak" });
    expect(r.noPreambleLeak).toBe(true);
  });

  it("flags a redundant fixture whose output did NOT collapse", () => {
    const input = ["A", "B", "C"];
    const output = out([
      "Triaged 200+ support tickets per week across email channels.",
      "Triaged 200+ inbound queue items weekly via the email pipeline.",
      "Handled 200 tickets per week through the support inbox.",
    ]);
    const r = scoreRubric({ input, output, fixtureKind: "redundant" });
    expect(r.dedupEffective).toBe(false);
  });

  it("flags an embedded newline as a one-line violation", () => {
    const input = ["Worked on X."];
    const output = out(["Drove a multi-team launch\nacross the org with strong outcomes."]);
    const r = scoreRubric({ input, output, fixtureKind: "weak" });
    expect(r.oneLinePerBullet).toBe(false);
  });
});

describe("scoreRubric — empty output (model returned nothing parseable)", () => {
  it("fails one-line, verb, length, and dedup criteria when bullets is empty", () => {
    // A model returning zero bullets is a failure, not a vacuous pass.
    // The criteria that quantify per-bullet quality must reflect "no
    // bullets to score" as a fail, including dedup (which would otherwise
    // trivially satisfy `output < input`).
    const r = scoreRubric({
      input: ["A", "B", "C"],
      output: { bullets: [], raw: "" },
      fixtureKind: "redundant",
    });
    expect(r.oneLinePerBullet).toBe(false);
    expect(r.actionVerbLead).toBe(false);
    expect(r.lengthSanity).toBe(false);
    expect(r.dedupEffective).toBe(false);
    // The non-bullet-dependent criteria still report honestly.
    expect(r.numbersPreserved).toBe(true); // input had no numeric tokens
    expect(r.noPreambleLeak).toBe(true); // raw was empty
  });
});

describe("emptyRubricForError", () => {
  it("returns all-fail with no per-bullet rows", () => {
    const r = emptyRubricForError();
    expect(r.numbersPreserved).toBe(false);
    expect(r.actionVerbLead).toBe(false);
    expect(r.lengthSanity).toBe(false);
    expect(r.noPreambleLeak).toBe(false);
    expect(r.oneLinePerBullet).toBe(false);
    expect(r.dedupEffective).toBeNull();
    expect(r.judgeCoherence).toBeNull();
    expect(r.perBullet).toEqual([]);
  });
});
