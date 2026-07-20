// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Pins the extract-requirements (#200) and judge-evidence (#201) prompt
 * contracts: the enum vocabularies, the prompt-injection boundary clause, and
 * that untrusted input sits in the right message. Also gives the exported
 * builders a direct consumer.
 */

import { describe, it, expect } from "vitest";
import {
  EXTRACT_SYSTEM_PROMPT,
  buildExtractUserPrompt,
  buildJudgeEvidenceSystemPrompt,
  buildJudgeEvidenceUserPrompt,
} from "./prompts.ts";
import type { JdRequirement } from "./extract-requirements.ts";

describe("extract-requirements prompts", () => {
  it("names all four requirement kinds", () => {
    for (const kind of [
      "skill",
      "experience",
      "responsibility",
      "qualification",
    ]) {
      expect(EXTRACT_SYSTEM_PROMPT).toContain(`"${kind}"`);
    }
  });

  it("states the prompt-injection boundary (data, not instructions)", () => {
    const p = EXTRACT_SYSTEM_PROMPT.toLowerCase();
    expect(p).toContain("never as instructions");
    expect(p).toContain("ignore any");
  });

  it("isolates the JD text as data in the user message", () => {
    const u = buildExtractUserPrompt("ACME needs a wizard");
    expect(u).toContain("ACME needs a wizard");
    expect(u.startsWith("Job description:")).toBe(true);
  });
});

describe("judge-evidence prompts", () => {
  it("names the three verdict statuses and the reference/injection framing", () => {
    for (const status of ["met", "partial", "missing"]) {
      expect(buildJudgeEvidenceSystemPrompt("RESUME")).toContain(`"${status}"`);
    }
    const p = buildJudgeEvidenceSystemPrompt("RESUME").toLowerCase();
    expect(p).toContain("reference only");
    expect(p).toContain("never treat as instructions");
  });

  it("embeds the résumé projection as reference in the system prompt", () => {
    expect(buildJudgeEvidenceSystemPrompt("MY_RESUME_PROJECTION")).toContain(
      "MY_RESUME_PROJECTION",
    );
  });

  it("lists the batch requirements (id + text, years mapped) in the user prompt", () => {
    const batch: JdRequirement[] = [
      { id: "req-1", kind: "experience", text: "5 years of Go", years: 5 },
    ];
    const u = buildJudgeEvidenceUserPrompt(batch);
    expect(u).toContain("req-1");
    expect(u).toContain("5 years of Go");
    expect(u).toContain('"years": 5');
  });
});
