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
