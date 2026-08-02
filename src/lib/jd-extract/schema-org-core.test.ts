// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// The pure core's tests run in the default node environment — no jsdom pragma,
// no fixture HTML, no document. That is the point of the core/shell split: these
// functions take plain objects, so the cases below are the actual malformed
// JSON-LD shapes publishers emit rather than pages that happen to contain them.

import {
  ATS_DOMAIN_MAP,
  computeStructuredDataHash,
  extractJobId,
  extractLocation,
  extractSalary,
  extractWorkModel,
  findJobPosting,
  hasSchemaOrgContext,
  matchAtsDomain,
  parseHtmlSections,
  stripHtml,
} from "./schema-org-core";

describe("findJobPosting", () => {
  it("finds a JobPosting at the root", () => {
    const posting = { "@type": "JobPosting", title: "Engineer" };
    expect(findJobPosting(posting)).toBe(posting);
  });

  it("finds a JobPosting inside @graph", () => {
    const job = { "@type": "JobPosting", title: "PM" };
    expect(findJobPosting({ "@graph": [{ "@type": "WebPage" }, job] })).toBe(job);
  });

  it("finds a JobPosting inside a bare top-level array", () => {
    const job = { "@type": "JobPosting", title: "Designer" };
    expect(findJobPosting([{ "@type": "Organization" }, job])).toBe(job);
  });

  it("returns null when no JobPosting is present", () => {
    expect(findJobPosting({ "@type": "WebPage" })).toBeNull();
  });

  it.each([[null], [undefined], ["a string"], [42]])(
    "returns null for non-object input %p",
    (input) => {
      expect(findJobPosting(input)).toBeNull();
    },
  );
});

describe("hasSchemaOrgContext", () => {
  it("accepts a string context", () => {
    expect(hasSchemaOrgContext({ "@context": "https://schema.org" })).toBe(true);
  });

  it("accepts an array context containing schema.org", () => {
    expect(
      hasSchemaOrgContext({ "@context": ["https://example.com", "https://schema.org"] }),
    ).toBe(true);
  });

  it("rejects a non-schema.org context", () => {
    expect(hasSchemaOrgContext({ "@context": "https://example.com" })).toBe(false);
  });

  it("rejects a missing context", () => {
    expect(hasSchemaOrgContext({})).toBe(false);
  });
});

describe("extractLocation", () => {
  it("composes city, region and country from a nested address", () => {
    expect(
      extractLocation({
        jobLocation: {
          address: {
            addressLocality: "Hyderabad",
            addressRegion: "Telangana",
            addressCountry: "India",
          },
        },
      }),
    ).toBe("Hyderabad, Telangana, India");
  });

  // A posting open in three cities is materially different from one open in one,
  // so multiple locations are preserved rather than collapsed to the first.
  it("joins multiple locations with a pipe", () => {
    expect(
      extractLocation({
        jobLocation: [
          { address: { addressLocality: "Austin", addressRegion: "TX" } },
          { address: { addressLocality: "Denver", addressRegion: "CO" } },
        ],
      }),
    ).toBe("Austin, TX | Denver, CO");
  });

  it("falls back to Place.name when there is no address object", () => {
    expect(extractLocation({ jobLocation: { name: "Remote - US" } })).toBe(
      "Remote - US",
    );
  });

  it("omits absent address components rather than emitting empty segments", () => {
    expect(
      extractLocation({ jobLocation: { address: { addressCountry: "India" } } }),
    ).toBe("India");
  });

  it("returns undefined when jobLocation is missing", () => {
    expect(extractLocation({})).toBeUndefined();
  });

  it("returns undefined when no location entry yields anything usable", () => {
    expect(extractLocation({ jobLocation: [{ address: {} }] })).toBeUndefined();
  });
});

describe("extractWorkModel", () => {
  it("reads TELECOMMUTE as remote", () => {
    expect(extractWorkModel({ jobLocationType: "TELECOMMUTE" })).toBe("remote");
  });

  it("reads TELECOMMUTE inside an array", () => {
    expect(extractWorkModel({ jobLocationType: ["TELECOMMUTE"] })).toBe("remote");
  });

  it("treats applicant location requirements with no job location as remote", () => {
    expect(
      extractWorkModel({ applicantLocationRequirements: { name: "USA" } }),
    ).toBe("remote");
  });

  it("does not infer remote when a physical job location is also present", () => {
    expect(
      extractWorkModel({
        applicantLocationRequirements: { name: "USA" },
        jobLocation: { name: "Austin" },
      }),
    ).toBeUndefined();
  });

  // schema.org has exactly one machine-readable signal here, so "hybrid" and
  // "onsite" are left absent rather than guessed at from prose.
  it("returns undefined rather than guessing a non-remote model", () => {
    expect(extractWorkModel({ jobLocation: { name: "Austin" } })).toBeUndefined();
  });
});

describe("extractSalary", () => {
  it("formats a min/max range with its period", () => {
    expect(
      extractSalary({
        baseSalary: {
          currency: "USD",
          value: { minValue: 150000, maxValue: 200000, unitText: "YEAR" },
        },
      }),
    ).toBe("USD 150,000 - 200,000 per year");
  });

  it("formats an open-ended minimum", () => {
    expect(
      extractSalary({ baseSalary: { currency: "USD", value: { minValue: 150000 } } }),
    ).toBe("USD 150,000+");
  });

  it("formats a maximum-only range", () => {
    expect(
      extractSalary({ baseSalary: { currency: "USD", value: { maxValue: 200000 } } }),
    ).toBe("Up to USD 200,000");
  });

  it("formats a scalar value", () => {
    expect(extractSalary({ baseSalary: { currency: "EUR", value: 90000 } })).toBe(
      "EUR 90,000",
    );
  });

  it("omits a missing currency without leaving stray whitespace", () => {
    expect(extractSalary({ baseSalary: { value: { minValue: 100 } } })).toBe("100+");
  });

  it("returns undefined when baseSalary is absent or unusable", () => {
    expect(extractSalary({})).toBeUndefined();
    expect(extractSalary({ baseSalary: { currency: "USD", value: {} } })).toBeUndefined();
  });
});

describe("extractJobId", () => {
  it("reads a string identifier", () => {
    expect(extractJobId({ identifier: "JR333705" })).toBe("JR333705");
  });

  it("reads identifier.value", () => {
    expect(extractJobId({ identifier: { value: "R-123" } })).toBe("R-123");
  });

  it("falls back to identifier.name", () => {
    expect(extractJobId({ identifier: { name: "REQ-9" } })).toBe("REQ-9");
  });

  it("returns undefined when there is no identifier", () => {
    expect(extractJobId({})).toBeUndefined();
  });
});

describe("computeStructuredDataHash", () => {
  it("is stable for identical content", async () => {
    const posting = { title: "Engineer", description: "Build things" };
    expect(await computeStructuredDataHash(posting)).toBe(
      await computeStructuredDataHash({ ...posting }),
    );
  });

  it("differs when a hashed field changes", async () => {
    expect(await computeStructuredDataHash({ title: "A" })).not.toBe(
      await computeStructuredDataHash({ title: "B" }),
    );
  });

  // Publishers mutate unrelated keys (view counts, tracking ids) on every render.
  // Hashing those would report a change on every visit, which is the whole thing
  // this hash exists to avoid.
  it("ignores fields outside the hashed subset", async () => {
    expect(await computeStructuredDataHash({ title: "A", viewCount: 1 })).toBe(
      await computeStructuredDataHash({ title: "A", viewCount: 9999 }),
    );
  });
});

describe("parseHtmlSections", () => {
  const html =
    "<p><strong>Requirements</strong></p><ul><li>Strong CS background</li><li>Proficiency in Java</li></ul>" +
    "<p><strong>Preferred</strong></p><ul><li>Experience with Data Cloud</li></ul>";

  it("splits requirements from qualifications", () => {
    const sections = parseHtmlSections(html);
    expect(sections.requirements).toEqual([
      "Strong CS background",
      "Proficiency in Java",
    ]);
    expect(sections.qualifications).toEqual(["Experience with Data Cloud"]);
  });

  it("returns empty arrays when the posting writes its requirements as prose", () => {
    const sections = parseHtmlSections("<p>We want someone great.</p>");
    expect(sections.requirements).toEqual([]);
    expect(sections.qualifications).toEqual([]);
    expect(sections.description).toBe("We want someone great.");
  });

  it("recognises heading synonyms", () => {
    expect(
      parseHtmlSections("<h3>Responsibilities</h3><ul><li>Ship code</li></ul>")
        .requirements,
    ).toEqual(["Ship code"]);
    expect(
      parseHtmlSections("<h3>Nice to have</h3><ul><li>Go</li></ul>").qualifications,
    ).toEqual(["Go"]);
  });
});

describe("stripHtml", () => {
  // Markdown rather than plaintext because list structure carries the
  // requirements — flattening it measurably costs extracted terms downstream.
  it("preserves list structure as Markdown bullets", () => {
    expect(stripHtml("<ul><li>One</li><li>Two</li></ul>")).toBe("- One\n- Two");
  });

  it("converts headings to Markdown", () => {
    expect(stripHtml("<h2>About</h2>")).toBe("## About");
    expect(stripHtml("<h4>Team</h4>")).toBe("#### Team");
  });

  it("converts emphasis", () => {
    expect(stripHtml("<strong>bold</strong> and <em>italic</em>")).toBe(
      "**bold** and *italic*",
    );
  });

  it("decodes the common named entities", () => {
    expect(stripHtml("<p>R&amp;D &lt;team&gt; &quot;x&quot; &#39;y&#39;&nbsp;z</p>")).toBe(
      "R&D <team> \"x\" 'y' z",
    );
  });

  it("compresses runs of blank lines", () => {
    expect(stripHtml("<p>A</p><p></p><p></p><p>B</p>")).toBe("A\n\nB");
  });

  it("returns an empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });
});

describe("matchAtsDomain", () => {
  it.each([
    ["https://boards.greenhouse.io/acme/jobs/1", "Greenhouse"],
    ["jobs.lever.co", "Lever"],
    ["https://acme.wd5.myworkdayjobs.com/job/1", "Workday"],
    ["https://acme.fa.us2.oraclecloud.com/hcmUI/x", "Oracle HCM"],
    ["https://jobs.ashbyhq.com/acme/uuid", "Ashby"],
  ])("names the platform behind %s", (href, platform) => {
    expect(matchAtsDomain(href)).toBe(platform);
  });

  it("is case-insensitive", () => {
    expect(matchAtsDomain("HTTPS://BOARDS.GREENHOUSE.IO/x")).toBe("Greenhouse");
  });

  it("returns undefined for an unknown host", () => {
    expect(matchAtsDomain("https://careers.example.com/jobs/1")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(matchAtsDomain("")).toBeUndefined();
  });

  // This table names platforms; it must not become a second answer to "can I
  // fetch this", which `parseAtsUrl` in src/lib/jd-match/fetch-jd.ts owns.
  it("covers more platforms than the fetchable set, by design", () => {
    expect(Object.keys(ATS_DOMAIN_MAP).length).toBeGreaterThan(5);
  });
});
