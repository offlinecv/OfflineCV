// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { matchSectionHeader } from "./regex.ts";

describe("matchSectionHeader — split-letter headers (#56)", () => {
  it("matches a clean header unchanged", () => {
    expect(matchSectionHeader("EXPERIENCE")).toBe("experience");
    expect(matchSectionHeader("Education")).toBe("education");
  });

  it("recovers a split lead letter on allowlisted sections", () => {
    // Designed templates letter-space the first glyph: pdfjs reads
    // "EXPERIENCE" as "E XPERIENCE".
    expect(matchSectionHeader("E XPERIENCE")).toBe("experience");
    expect(matchSectionHeader("e xperience")).toBe("experience");
    expect(matchSectionHeader("S UMMARY")).toBe("summary");
    expect(matchSectionHeader("E DUCATION")).toBe("education");
  });

  it("does NOT recover split-letter skills (sidebar S KILLS would strand roles)", () => {
    expect(matchSectionHeader("S KILLS")).toBeNull();
  });

  it("ignores a split-letter header that doesn't reduce to a keyword", () => {
    // "EXPERIENCE FOCUS AREAS" sidebar label — rejoins to multi-word text,
    // which is not an exact keyword.
    expect(matchSectionHeader("E XPERIENCE F OCUS AREAS")).toBeNull();
  });

  it("does not mint a section from prose with an incidental split word", () => {
    expect(matchSectionHeader("i have experience")).toBeNull();
    expect(matchSectionHeader("a summary of my work")).toBeNull();
  });
});
