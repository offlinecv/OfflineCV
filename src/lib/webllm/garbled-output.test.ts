// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getFixtureById, REWRITE_FIXTURES } from "./eval/fixtures.ts";
import { detectGarbledRewrite } from "./garbled-output.ts";
import { applyRewriteGates, cleanRewriteLine } from "./post-process.ts";

const INPUT = [
  "Assisted with production of three mainstage operas",
  "Supported the team with scheduling and logistics",
];

// The degenerate Experience rewrite seen on the PR #1016 preview, as the
// cleaned lines `rewriteSectionWithLlm` would have handed the gate.
const OBSERVED = [
  "Here’s a list of examples of how to rewrite the following to be more specific and outcome-oriented.",
  "Here are some examples of how to rewrite the following to be more specific and outcome-oriented.",
  "Support the team's support for the team's project, and the team's project, and the team's project, and the project is focused on the project.",
  "Team support, and the project is a project, and the project, and the project.",
];

describe("detectGarbledRewrite", () => {
  it("rejects the observed degenerate rewrite", () => {
    expect(detectGarbledRewrite(INPUT, OBSERVED)).toBe("instruction-echo");
  });

  it("rejects a line that narrates the task", () => {
    for (const line of [
      "Here are examples of how to rewrite the following to be more specific.",
      "Lets assume we have the following list of input:",
      "Here is the rewritten version of your bullets",
    ]) {
      expect(detectGarbledRewrite(INPUT, [line]), line).toBe("instruction-echo");
    }
  });

  it("leaves a bullet that merely opens with 'Here are'", () => {
    expect(
      detectGarbledRewrite(INPUT, ["Here are updated KPIs from Q3 for the board"]),
    ).toBeNull();
  });

  it("rejects a phrase looping inside one line", () => {
    expect(
      detectGarbledRewrite(INPUT, OBSERVED.slice(2, 3)),
    ).toBe("loop");
  });

  it("rejects one sentence re-emitted across bullets", () => {
    const repeated = "Coordinated vendor schedules for the spring season";
    expect(
      detectGarbledRewrite(INPUT, [repeated, repeated, repeated, repeated]),
    ).toBe("loop");
  });

  it("rejects a sentence of eight words or more re-emitted in three bullets", () => {
    const tail = "to deliver the spring season on time and under budget";
    expect(
      detectGarbledRewrite(INPUT, [
        `Planned rehearsals ${tail}`,
        `Booked vendors ${tail}`,
        `Scheduled crews ${tail}`,
      ]),
    ).toBe("loop");
  });

  it("leaves a summary that repeats 'years of experience'", () => {
    const summary =
      "Engineer with 8 years of experience in backend, including 3 years of experience in ML and 2 years of experience leading teams.";
    expect(detectGarbledRewrite([summary], [summary])).toBeNull();
    expect(detectGarbledRewrite(["Backend engineer, 8 years"], [summary])).toBeNull();
  });

  it("leaves a house-style opener every bullet shares", () => {
    const rewritten = [
      "Collaborated with cross-functional teams to ship the mobile app",
      "Collaborated with cross-functional teams to cut onboarding time",
      "Collaborated with cross-functional teams to launch two pricing tiers",
      "Collaborated with cross-functional teams to migrate billing",
    ];
    expect(detectGarbledRewrite(INPUT, rewritten)).toBeNull();
  });

  it("rejects narration that does not open with 'Here'", () => {
    expect(
      detectGarbledRewrite(INPUT, ["Rewrite the following bullet points to be stronger"]),
    ).toBe("instruction-echo");
  });

  it("exempts narration the user wrote themselves, on any input line", () => {
    const input = ["Ran the box office", "Taught staff how to rewrite show notes for press"];
    expect(detectGarbledRewrite(input, input)).toBeNull();
  });

  it("does not count a repetition the input already had", () => {
    const looping = "Led the team, led the team, led the team to launch";
    expect(detectGarbledRewrite([looping], [looping])).toBeNull();
  });

  it("passes every committed eval fixture rewritten as itself", () => {
    for (const fixture of REWRITE_FIXTURES) {
      expect(
        detectGarbledRewrite(fixture.bullets, fixture.bullets),
        fixture.id,
      ).toBeNull();
    }
  });

  // The committed eval reports hold ~150 real model rewrites across three
  // models. None of them is garbage, so every one must pass: this is the
  // false-positive budget for the rules above.
  it("passes every model rewrite in the committed eval reports", () => {
    const dir = join(process.cwd(), "tests/fixtures/rewrite/reports");
    let checked = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const report = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        records: {
          fixtureId: string;
          rubric: { perBullet: { text: string }[] };
        }[];
      };
      for (const record of report.records) {
        const fixture = getFixtureById(record.fixtureId);
        if (fixture === undefined) continue;
        // Through `cleanRewriteLine` as the product path does: the older
        // reports predate its chat-opener strip (#150).
        const rewritten = record.rubric.perBullet
          .map((b) => cleanRewriteLine(b.text))
          .filter((line) => line.length > 0);
        expect(
          detectGarbledRewrite(fixture.bullets, rewritten),
          `${file} ${record.fixtureId}`,
        ).toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("leaves an empty rewrite to the caller", () => {
    expect(detectGarbledRewrite(INPUT, [])).toBeNull();
  });
});

describe("cleanRewriteLine preamble strip (#1015)", () => {
  it("drops a chatty opener ending in a colon, so the rewrite under it survives", () => {
    for (const line of [
      "Here's a rewritten version of your bullets:",
      "Here is your rewritten section:",
      "Sure! Here are some examples of rewritten bullets:",
    ]) {
      expect(cleanRewriteLine(line), line).toBe("");
    }
    const rewritten = ["Here's a rewritten version of your bullets:", "Produced three mainstage operas"]
      .map(cleanRewriteLine)
      .filter((line) => line.length > 0);
    expect(applyRewriteGates(INPUT, rewritten).reverted).toBe(false);
  });

  it("keeps a bullet that opens with 'Here are' and ends in a full stop", () => {
    expect(cleanRewriteLine("Here are updated KPIs from Q3.")).toBe(
      "Here are updated KPIs from Q3.",
    );
  });
});

describe("applyRewriteGates", () => {
  it("reverts a garbled rewrite to the original and names why", () => {
    const outcome = applyRewriteGates(INPUT, OBSERVED);
    expect(outcome.bullets).toEqual(INPUT);
    expect(outcome.reverted).toBe(true);
    expect(outcome.numbersPreserved).toBe(true);
    expect(outcome.garbled).toBe("instruction-echo");
  });

  it("still reports the number diff of a garbled rewrite", () => {
    const outcome = applyRewriteGates(
      ["Cut costs by 20%"],
      ["Here are examples of how to rewrite the following"],
    );
    expect(outcome.reverted).toBe(true);
    expect(outcome.droppedNumbers).toEqual(["20%"]);
  });

  it("passes a clean rewrite through untouched", () => {
    const rewritten = ["Produced three mainstage operas", "Ran scheduling and logistics"];
    const outcome = applyRewriteGates(INPUT, rewritten);
    expect(outcome.bullets).toEqual(rewritten);
    expect(outcome.reverted).toBe(false);
    expect(outcome.garbled).toBeNull();
  });
});
