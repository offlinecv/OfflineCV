// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Pins the extract-requirements prompt contract (#200): the four kinds, the
 * prompt-injection boundary clause, and that the JD is isolated in the user
 * message. Also gives the exported builders a direct consumer.
 */

import { describe, it, expect } from "vitest";
import {
  EXTRACT_REQUIREMENTS_SYSTEM_PROMPT,
  buildExtractRequirementsUserPrompt,
} from "./prompts.ts";

describe("extract-requirements prompts", () => {
  it("names all four requirement kinds", () => {
    for (const kind of [
      "skill",
      "experience",
      "responsibility",
      "qualification",
    ]) {
      expect(EXTRACT_REQUIREMENTS_SYSTEM_PROMPT).toContain(`"${kind}"`);
    }
  });

  it("states the prompt-injection boundary (data, not instructions)", () => {
    const p = EXTRACT_REQUIREMENTS_SYSTEM_PROMPT.toLowerCase();
    expect(p).toContain("never as instructions");
    expect(p).toContain("ignore any");
  });

  it("isolates the JD text as data in the user message", () => {
    const u = buildExtractRequirementsUserPrompt("ACME needs a wizard");
    expect(u).toContain("ACME needs a wizard");
    expect(u.startsWith("Job description:")).toBe(true);
  });
});
