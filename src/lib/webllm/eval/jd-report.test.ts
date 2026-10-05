// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";

import { JD_EVAL_FIXTURES } from "./jd-fixtures.ts";
import { runJdEval } from "./jd-runner.ts";
import { renderJdMarkdownReport, renderJsonReport } from "./jd-report.ts";
import type { JdMatchFn } from "./jd-types.ts";

const STUB_MATCH_FN: JdMatchFn = async ({ fixture }) => fixture.canned;

describe("jd-report", () => {
  it("renders JSON that round-trips the report", async () => {
    const report = await runJdEval({
      modelIds: ["stub-model"],
      fixtures: JD_EVAL_FIXTURES,
      matchFn: STUB_MATCH_FN,
      now: () => 0,
    });
    const json = renderJsonReport(report);
    expect(JSON.parse(json)).toEqual(report);
  });

  it("renders a Markdown table with one row per fixture and the comparison section", async () => {
    const report = await runJdEval({
      modelIds: ["stub-model"],
      fixtures: JD_EVAL_FIXTURES,
      matchFn: STUB_MATCH_FN,
      now: () => 0,
    });
    const md = renderJdMarkdownReport(report);
    expect(md).toContain("# JD-match eval report");
    for (const fixture of JD_EVAL_FIXTURES) {
      expect(md).toContain(fixture.id);
    }
    expect(md).toContain("## Semantic vs. keyword (reported, not gated)");
    expect(md).toContain("software-engineer");
  });
});
