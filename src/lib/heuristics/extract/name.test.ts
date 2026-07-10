// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { extractHeadline } from "./name.ts";
import type { PdfLine, PdfSection } from "../sections.ts";

/** extractHeadline only reads `line.text`; build minimal lines. */
function line(text: string): PdfLine {
  return { text } as unknown as PdfLine;
}
function profile(...texts: string[]): PdfSection {
  return { name: "profile", lines: texts.map(line) } as PdfSection;
}

describe("extractHeadline (#425 follow-up)", () => {
  it("captures a title tagline standalone under the name", () => {
    // The canonical case: name, then a professional headline, then contact.
    const p = profile(
      "Sri Annam",
      "Engineering Lead",
      "Santa Clara, CA | annam@example.com | (408) 555-0123",
      "linkedin.com/in/sannam",
    );
    expect(extractHeadline(p, "Sri Annam").value).toBe("Engineering Lead");
  });

  it("returns nothing when the header carries no headline", () => {
    const p = profile(
      "Morgan Diaz",
      "morgan.diaz@example.com  (312) 555-0155  Austin, TX",
    );
    expect(extractHeadline(p, "Morgan Diaz").value).toBeUndefined();
  });

  it("does not treat a location line as a headline", () => {
    const p = profile("Jordan Lee", "San Francisco, CA", "jordan@example.com");
    expect(extractHeadline(p, "Jordan Lee").value).toBeUndefined();
  });

  it("stops at the contact cluster — a later title-keyword line is not the headline", () => {
    // The word "Engineer" appears only AFTER the contact line has begun; the
    // header block is already over, so it must not be lifted as the headline.
    const p = profile(
      "Alex Kim",
      "alex.kim@example.com  (212) 555-0100",
      "Senior Software Engineer at Globex",
    );
    expect(extractHeadline(p, "Alex Kim").value).toBeUndefined();
  });

  it("stops at a section header", () => {
    const p = profile("Sam Rivera", "SUMMARY", "Product Manager with 8 years");
    expect(extractHeadline(p, "Sam Rivera").value).toBeUndefined();
  });

  it("still finds the headline when the name was not captured", () => {
    // name === undefined: the first line is scanned too, but a plain name fails
    // looksLikeTitle, so the second (title) line is still the one returned.
    const p = profile("Sri Annam", "Engineering Lead", "annam@example.com");
    expect(extractHeadline(p, undefined).value).toBe("Engineering Lead");
  });
});
