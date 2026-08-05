// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * LinkedIn title/company parsing.
 *
 * LinkedIn is the highest-volume source in the `job-hunt` lane and the one host
 * that ships neither JSON-LD nor `og:` tags on its logged-in job view, so these
 * two strategies are the only thing standing between it and the weakest tier.
 *
 * The two-stage split order is the subtle part: pipes are LinkedIn's own branding
 * separator, dashes appear inside company names, so splitting on dashes globally
 * would shred a company like "Acme - EMEA".
 */

import {
  extractLinkedInCompanyFromDOM,
  isLinkedInJobUrl,
  parseLinkedInTitle,
} from "./linkedin-parse";

function docWith(html: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    "text/html",
  );
}

describe("extractLinkedInCompanyFromDOM", () => {
  // The accessibility layer is the stable surface — LinkedIn's class names are
  // hashed and rotate between deploys.
  it("reads the company from the aria-label", () => {
    expect(
      extractLinkedInCompanyFromDOM(docWith('<div aria-label="Company, Visa.">x</div>')),
    ).toBe("Visa");
  });

  it("strips the trailing period and surrounding whitespace", () => {
    expect(
      extractLinkedInCompanyFromDOM(
        docWith('<div aria-label="Company,   Acme Corp.  ">x</div>'),
      ),
    ).toBe("Acme Corp");
  });

  it("returns null when the element is absent", () => {
    expect(extractLinkedInCompanyFromDOM(docWith("<div>nothing</div>"))).toBeNull();
  });

  it("returns null rather than an empty string when the label has no name", () => {
    expect(
      extractLinkedInCompanyFromDOM(docWith('<div aria-label="Company,">x</div>')),
    ).toBeNull();
  });
});

describe("parseLinkedInTitle", () => {
  it("splits title, team and company", () => {
    expect(
      parseLinkedInTitle(
        "Director, Engineering - Agentic Systems | Visa | LinkedIn",
      ),
    ).toEqual({ title: "Director, Engineering", company: "Visa" });
  });

  it("handles a title with no team segment", () => {
    expect(parseLinkedInTitle("Software Engineer | Google | LinkedIn")).toEqual({
      title: "Software Engineer",
      company: "Google",
    });
  });

  it("keeps a comma inside the job title", () => {
    expect(parseLinkedInTitle("Director, Engineering | Acme | LinkedIn")).toEqual({
      title: "Director, Engineering",
      company: "Acme",
    });
  });

  it("splits on an en dash as well as a hyphen", () => {
    expect(parseLinkedInTitle("Engineer – Platform | Acme | LinkedIn")).toEqual({
      title: "Engineer",
      company: "Acme",
    });
  });

  it("handles the fullwidth pipe some locales emit", () => {
    expect(parseLinkedInTitle("Engineer ｜ Acme ｜ LinkedIn")).toEqual({
      title: "Engineer",
      company: "Acme",
    });
  });

  it("returns an empty company for the two-part shape that carries none", () => {
    expect(parseLinkedInTitle("Software Engineer | LinkedIn")).toEqual({
      title: "Software Engineer",
      company: "",
    });
  });

  // Without the trailing "LinkedIn" this is some other page's title, and guessing
  // would invent a company name.
  it.each([
    ["Some Blog Post | Medium", "a non-LinkedIn title"],
    ["", "an empty string"],
    ["No separators at all", "a title with no pipes"],
  ])("returns null for %s (%s)", (input) => {
    expect(parseLinkedInTitle(input)).toBeNull();
  });
});

/**
 * The dashes that are NOT the team separator (#725).
 *
 * These are the shape LinkedIn actually serves, not the shape the parser expected:
 * the first case is the live `<title>` observed on 2026-08-01, and the value it
 * used to yield — `"Head of Engineering ($225k"` — was written into the user's
 * tracker as the record of the job. A truncated title is worse than no capture,
 * because it looks like a successful one.
 */
describe("parseLinkedInTitle — dashes inside the title", () => {
  it("keeps a parenthesised salary range whole", () => {
    expect(
      parseLinkedInTitle("Head of Engineering ($225k - $275k) | Clera | LinkedIn"),
    ).toEqual({
      title: "Head of Engineering ($225k - $275k)",
      company: "Clera",
    });
  });

  it("keeps an en-dash comp band whole", () => {
    expect(
      parseLinkedInTitle("Staff Platform Engineer ($180k – $220k) | Acme | LinkedIn"),
    ).toEqual({
      title: "Staff Platform Engineer ($180k – $220k)",
      company: "Acme",
    });
  });

  it("keeps a square-bracketed qualifier whole", () => {
    expect(
      parseLinkedInTitle("Data Engineer [Contract - 12 months] | Acme | LinkedIn"),
    ).toEqual({
      title: "Data Engineer [Contract - 12 months]",
      company: "Acme",
    });
  });

  // A hyphen with no space around it is part of a token, not a separator.
  it.each([
    ["Full-Stack Engineer | Acme | LinkedIn", "Full-Stack Engineer", "Acme"],
    [
      "Head of Engineering $225k-$275k | Clera | LinkedIn",
      "Head of Engineering $225k-$275k",
      "Clera",
    ],
    ["E-commerce Analytics Lead | Acme | LinkedIn", "E-commerce Analytics Lead", "Acme"],
  ])("keeps the hyphenated token in %s", (input, title, company) => {
    expect(parseLinkedInTitle(input)).toEqual({ title, company });
  });

  // The team separator still separates once the brackets close.
  it("splits at the first dash outside the brackets", () => {
    expect(
      parseLinkedInTitle(
        "Head of Engineering ($225k - $275k) - Payments | Clera | LinkedIn",
      ),
    ).toEqual({ title: "Head of Engineering ($225k - $275k)", company: "Clera" });
  });

  // Unbalanced brackets mean the left side of every candidate dash is unbalanced
  // too, so nothing splits and the segment survives whole — the safe direction.
  it("declines to split a segment with an unbalanced bracket", () => {
    expect(parseLinkedInTitle("Engineer (Platform - Core | Acme | LinkedIn")).toEqual({
      title: "Engineer (Platform - Core",
      company: "Acme",
    });
  });

  // The two-part shape never dash-split, and must not start.
  it("keeps a comp band whole in the two-part shape", () => {
    expect(parseLinkedInTitle("Head of Engineering ($225k - $275k) | LinkedIn")).toEqual({
      title: "Head of Engineering ($225k - $275k)",
      company: "",
    });
  });
});

describe("isLinkedInJobUrl", () => {
  it("accepts a job view page", () => {
    expect(isLinkedInJobUrl("https://www.linkedin.com/jobs/view/4437835690/")).toBe(true);
  });

  it("accepts a URL object", () => {
    expect(isLinkedInJobUrl(new URL("https://linkedin.com/jobs/view/123"))).toBe(true);
  });

  // Deliberately narrower than "is this LinkedIn" — these are not postings.
  it.each([
    "https://www.linkedin.com/jobs/search/?keywords=eng",
    "https://www.linkedin.com/company/acme/",
    "https://www.linkedin.com/feed/",
    "https://example.com/jobs/view/123",
  ])("rejects %s", (url) => {
    expect(isLinkedInJobUrl(url)).toBe(false);
  });

  // A malformed href off a page must not throw inside a matches() call.
  it("returns false for a malformed URL rather than throwing", () => {
    expect(isLinkedInJobUrl("not a url at all")).toBe(false);
  });
});
