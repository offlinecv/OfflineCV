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
    gapAbove: 0,
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

describe("extractContact — additive profiles[] mirrors the legacy link keys (#335)", () => {
  it("derives a profiles[] from the four legacy link values, in fixed order", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine(
        "jane@uw.edu | linkedin.com/in/jane | github.com/jane | janedoe.dev",
        10,
      ),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);

    // Legacy keys are unchanged (still the scoring/snapshot source of truth).
    expect(result.linkedin_url).toBe("https://linkedin.com/in/jane");
    expect(result.github_url).toBe("https://github.com/jane");

    // profiles[] mirrors those legacy values, classified + order-preserving.
    const byNetwork = result.profiles.map((p) => p.network);
    expect(byNetwork).toContain("LinkedIn");
    expect(byNetwork).toContain("GitHub");
    const linkedin = result.profiles.find((p) => p.network === "LinkedIn");
    const github = result.profiles.find((p) => p.network === "GitHub");
    expect(linkedin?.url).toBe(result.linkedin_url);
    expect(linkedin?.kind).toBe("social");
    expect(github?.url).toBe(result.github_url);
    expect(github?.kind).toBe("code");
  });

  it("emits an empty profiles[] when no link was detected", () => {
    const lines: PdfLine[] = [
      mkLine("Jane Doe", 0),
      mkLine("Seattle, WA | jane@uw.edu | (312) 555-0123", 10),
    ];
    const profile: PdfSection = { name: "profile", lines };

    const result = extractContact(profile, lines);
    expect(result.profiles).toEqual([]);
  });
});

describe("extractContact — mid-sentence domain is not promoted to website_url (#237)", () => {
  // Regression: a bare domain embedded in achievement/body prose (e.g. "sold
  // return2india.com to Satyam Infoway") was being picked up by the full-doc
  // fallback scan and promoted to website_url. The standalone check in
  // extractOtherUrls now rejects domains that appear mid-sentence.

  it("does not promote a domain mid-sentence to website_url", () => {
    const contactLine = mkLine(
      "Jane Doe | jane@example.com | (312) 555-0123",
      0,
    );
    // Body line that contains a domain mid-sentence
    const bodyLine = mkLine(
      "Exit · Founded and sold return2india.com to Satyam Infoway (NASDAQ: SIFY). 200K monthly visits.",
      100,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const allLines: PdfLine[] = [contactLine, bodyLine];

    const result = extractContact(profile, allLines);

    expect(result.website_url).toBeUndefined();
  });

  it("does not promote a domain with surrounding words to website_url", () => {
    const contactLine = mkLine("Jane Doe | jane@example.com", 0);
    const bodyLine = mkLine("Launched mysite.com for 10K users in 2023", 100);
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const allLines: PdfLine[] = [contactLine, bodyLine];

    const result = extractContact(profile, allLines);

    expect(result.website_url).toBeUndefined();
  });

  it("still promotes a standalone domain on its own line to website_url", () => {
    const contactLine = mkLine(
      "Jane Doe | jane@example.com | janedoe.com",
      0,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };

    const result = extractContact(profile, [contactLine]);

    expect(result.website_url).toBe("https://janedoe.com");
  });

  it("still promotes an https:// URL even when mid-sentence text surrounds it", () => {
    const contactLine = mkLine("Jane Doe | jane@example.com", 0);
    // An explicit https:// URL is always a link regardless of surrounding text
    const bodyLine = mkLine(
      "Sold https://return2india.com to Satyam Infoway",
      100,
    );
    const profile: PdfSection = { name: "profile", lines: [contactLine] };
    const allLines: PdfLine[] = [contactLine, bodyLine];

    const result = extractContact(profile, allLines);

    expect(result.website_url).toBe("https://return2india.com");
  });
});
