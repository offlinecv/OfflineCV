// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { extractContact } from "./contact.ts";
import type { PdfLine, PdfSection } from "../sections.ts";

/** Minimal PdfLine carrying only the fields extractContact reads. */
function mkLine(text: string, y = 0): PdfLine {
  return {
    page: 1,
    y,
    x: 0,
    items: [],
    text,
    maxFontSize: 12,
    allCaps: false,
  };
}

describe("extractContact — email domain is not a website", () => {
  // Regression: an address like `jane@uw.edu` carries a bare domain that
  // URL_RE's domain branch matched (the `@` is a word boundary), phantom-
  // promoting the email's host (`uw.edu`) to website_url. See contact.ts
  // extractOtherUrls — emails are blanked before the URL scan.
  it("does not promote an email's host to website_url", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine("Seattle, WA | jane@uw.edu | (312) 555-0123", 10),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);

    expect(result.email).toBe("jane@uw.edu");
    expect(result.website_url).toBeUndefined();
    expect(result.portfolio_url).toBeUndefined();
  });

  it("does not promote a dotted skill token (Node.js) to website_url", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine("jane@uw.edu", 10),
      mkLine("Skills: Node.js, React, TypeScript", 20),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);

    expect(result.website_url).toBeUndefined();
    expect(result.portfolio_url).toBeUndefined();
  });

  it("still extracts a real bare-domain website alongside an email", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine("jane@uw.edu | janedoe.com", 10),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);

    expect(result.email).toBe("jane@uw.edu");
    expect(result.website_url).toBe("https://janedoe.com");
  });
});
