// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Tier 1 — the schema.org JSON-LD extractor.
 *
 * Real jsdom rather than a `querySelector` stub: this tier's job is finding and
 * reading `<script type="application/ld+json">` blocks among whatever else a page
 * ships, and a stub that returns a canned list of scripts would assert nothing
 * about the selector actually being right.
 *
 * The negative cases carry most of the weight. A page ships several JSON-LD blocks
 * in arbitrary order, one of them routinely malformed by some vendor widget, and
 * this tier has to skip past all of that to the posting — so "skips a broken block
 * and finds the next" matters more than any single happy path.
 */

import { extractSchemaOrgJobPosting } from "./schema-org";

interface PageOptions {
  jsonLd?: string[];
  bodyHtml?: string;
  url?: string;
}

const DEFAULT_URL = "https://careers.example.com/jobs/1";

/**
 * Build a page and run tier 1 against it.
 *
 * The URL is passed to the extractor rather than stamped onto `doc.location`,
 * because a `DOMParser` document's location is `about:blank` and non-configurable
 * — which is exactly why the extractor takes the URL as a parameter instead of
 * reading it off the document.
 */
function extract(opts: PageOptions = {}) {
  const { jsonLd = [], bodyHtml = "", url = DEFAULT_URL } = opts;
  const scripts = jsonLd
    .map((raw) => `<script type="application/ld+json">${raw}</script>`)
    .join("");
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><head>${scripts}</head><body>${bodyHtml}</body></html>`,
    "text/html",
  );
  return extractSchemaOrgJobPosting(doc, new URL(url));
}

/** A JSON-LD block wrapping `posting` in a valid schema.org envelope. */
function jobPosting(posting: Record<string, unknown>): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    ...posting,
  });
}

const FULL_POSTING = jobPosting({
  title: "Success Engineer",
  description:
    "<p><strong>Requirements</strong></p><ul><li>Strong CS background</li><li>Proficiency in Java</li></ul>" +
    "<p><strong>Preferred</strong></p><ul><li>Experience with Data Cloud</li></ul>",
  identifier: "JR333705",
  datePosted: "2026-03-13",
  validThrough: "2026-06-13",
  employmentType: "FULL_TIME",
  hiringOrganization: { "@type": "Organization", name: "Salesforce, Inc." },
  jobLocation: [
    {
      "@type": "Place",
      address: {
        addressLocality: "Hyderabad",
        addressRegion: "Telangana",
        addressCountry: "India",
      },
    },
    {
      "@type": "Place",
      address: {
        addressLocality: "Bangalore",
        addressRegion: "Karnataka",
        addressCountry: "India",
      },
    },
  ],
});

const MINIMAL = jobPosting({
  title: "Software Engineer",
  hiringOrganization: { "@type": "Organization", name: "Acme Corp" },
});

describe("extractSchemaOrgJobPosting — happy paths", () => {
  it("extracts a complete posting", async () => {
    const result = await extract({ jsonLd: [FULL_POSTING] });

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Success Engineer");
    expect(result!.company).toBe("Salesforce, Inc.");
    expect(result!.extractionTier).toBe("schema_org");
    expect(result!.jobId).toBe("JR333705");
    expect(result!.datePosted).toBe("2026-03-13");
    expect(result!.validThrough).toBe("2026-06-13");
    expect(result!.employmentType).toBe("FULL_TIME");
    expect(result!.location).toBe(
      "Hyderabad, Telangana, India | Bangalore, Karnataka, India",
    );
  });

  it("splits the description into requirements and qualifications", async () => {
    const result = await extract({ jsonLd: [FULL_POSTING] });
    expect(result!.requirements).toEqual([
      "Strong CS background",
      "Proficiency in Java",
    ]);
    expect(result!.qualifications).toEqual(["Experience with Data Cloud"]);
  });

  // The body is what the fit rating consumes, and its list structure is what
  // yields extractable skill terms — see the note on ExtractedPosting.body.
  it("produces a Markdown body that keeps list structure", async () => {
    const result = await extract({ jsonLd: [FULL_POSTING] });
    expect(result!.body).toContain("- Strong CS background");
    expect(result!.body).toContain("**Requirements**");
    expect(result!.descriptionPreview).toBe(result!.body.slice(0, 200));
  });

  it("extracts a minimal posting carrying only a title and company", async () => {
    const result = await extract({ jsonLd: [MINIMAL] });
    expect(result!.title).toBe("Software Engineer");
    expect(result!.company).toBe("Acme Corp");
    expect(result!.body).toBe("");
  });

  it("finds a posting nested in a @graph array", async () => {
    const result = await extract({
      jsonLd: [
        JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebPage", name: "Careers" },
            {
              "@type": "JobPosting",
              title: "Product Manager",
              hiringOrganization: { "@type": "Organization", name: "GraphCo" },
            },
          ],
        }),
      ],
    });
    expect(result!.title).toBe("Product Manager");
    expect(result!.company).toBe("GraphCo");
  });

  it("extracts salary and remote work model", async () => {
    const result = await extract({
      jsonLd: [
        jobPosting({
          title: "Senior Engineer",
          hiringOrganization: { "@type": "Organization", name: "PayCo" },
          baseSalary: {
            currency: "USD",
            value: { minValue: 150000, maxValue: 200000, unitText: "YEAR" },
          },
          jobLocationType: "TELECOMMUTE",
        }),
      ],
    });
    expect(result!.salaryRange).toBe("USD 150,000 - 200,000 per year");
    expect(result!.workModel).toBe("remote");
  });

  it("joins an array employmentType", async () => {
    const result = await extract({
      jsonLd: [
        jobPosting({
          title: "Contractor",
          hiringOrganization: { "@type": "Organization", name: "FlexCo" },
          employmentType: ["PART_TIME", "CONTRACTOR"],
        }),
      ],
    });
    expect(result!.employmentType).toBe("PART_TIME, CONTRACTOR");
  });

  it("passes the original JSON-LD node through untouched", async () => {
    const result = await extract({ jsonLd: [MINIMAL] });
    expect(result!.schemaOrgRaw).toMatchObject({
      "@type": "JobPosting",
      title: "Software Engineer",
    });
  });

  it("normalizes empty section arrays to undefined", async () => {
    // A posting whose requirements are prose should read as "none extracted",
    // not as "zero requirements".
    const result = await extract({
      jsonLd: [
        jobPosting({
          title: "Engineer",
          hiringOrganization: { "@type": "Organization", name: "Acme" },
          description: "<p>We want someone great.</p>",
        }),
      ],
    });
    expect(result!.requirements).toBeUndefined();
    expect(result!.qualifications).toBeUndefined();
  });
});

describe("extractSchemaOrgJobPosting — resilience", () => {
  it("returns null when the page ships no JSON-LD at all", async () => {
    expect(await extract()).toBeNull();
  });

  it("returns null when the JSON-LD is not a JobPosting", async () => {
    const result = await extract({
      jsonLd: [JSON.stringify({ "@context": "https://schema.org", "@type": "WebPage" })],
    });
    expect(result).toBeNull();
  });

  it.each([
    ["title", { hiringOrganization: { "@type": "Organization", name: "Acme" } }],
    ["hiringOrganization", { title: "Engineer" }],
  ])("returns null when %s is missing", async (_field, partial) => {
    expect(await extract({ jsonLd: [jobPosting(partial)] })).toBeNull();
  });

  it("returns null on invalid JSON rather than throwing", async () => {
    expect(await extract({ jsonLd: ["{ this is not json"] })).toBeNull();
  });

  it("returns null when the context is not schema.org", async () => {
    const result = await extract({
      jsonLd: [
        JSON.stringify({
          "@context": "https://example.com",
          "@type": "JobPosting",
          title: "Engineer",
          hiringOrganization: { "@type": "Organization", name: "Acme" },
        }),
      ],
    });
    expect(result).toBeNull();
  });

  // Pages ship several blocks in arbitrary order — the posting is rarely first.
  it("skips non-JobPosting blocks and finds the posting in a later one", async () => {
    const result = await extract({
      jsonLd: [
        JSON.stringify({ "@context": "https://schema.org", "@type": "Organization" }),
        JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList" }),
        MINIMAL,
      ],
    });
    expect(result!.title).toBe("Software Engineer");
  });

  it("skips a malformed block and extracts from a valid later one", async () => {
    const result = await extract({ jsonLd: ["{ broken", MINIMAL] });
    expect(result!.title).toBe("Software Engineer");
  });

  it("handles CDATA-wrapped JSON-LD", async () => {
    const result = await extract({ jsonLd: [`<![CDATA[${MINIMAL}]]>`] });
    expect(result!.company).toBe("Acme Corp");
  });

  it("skips an empty block", async () => {
    const result = await extract({ jsonLd: ["", "   ", MINIMAL] });
    expect(result!.company).toBe("Acme Corp");
  });
});

describe("extractSchemaOrgJobPosting — ATS naming", () => {
  // The selector keys on "apply" appearing in the href or the class — a company's
  // careers page on its own domain reveals its ATS only through where this points.
  it("names the platform from an apply link's class", async () => {
    const result = await extract({
      jsonLd: [MINIMAL],
      bodyHtml:
        '<a class="apply-button" href="https://boards.greenhouse.io/acme/jobs/9">Apply</a>',
    });
    expect(result!.atsDetected).toBe("Greenhouse");
  });

  it("names the platform from an apply link's href", async () => {
    const result = await extract({
      jsonLd: [MINIMAL],
      bodyHtml: '<a href="https://jobs.lever.co/acme/abc/apply">Apply now</a>',
    });
    expect(result!.atsDetected).toBe("Lever");
  });

  // An off-site link that is not an apply link must not name a platform.
  it("ignores a non-apply link to an ATS domain", async () => {
    const result = await extract({
      jsonLd: [MINIMAL],
      bodyHtml: '<a href="https://boards.greenhouse.io/acme">Our other roles</a>',
    });
    expect(result!.atsDetected).toBeUndefined();
  });

  it("falls back to the page's own hostname", async () => {
    const result = await extract({
      jsonLd: [MINIMAL],
      url: "https://jobs.lever.co/acme/abc-123",
    });
    expect(result!.atsDetected).toBe("Lever");
  });

  it("leaves the platform undefined when nothing identifies one", async () => {
    expect((await extract({ jsonLd: [MINIMAL] }))!.atsDetected).toBeUndefined();
  });
});

describe("structuredDataHash", () => {
  it("is stable across two extractions of identical content", async () => {
    const a = await extract({ jsonLd: [FULL_POSTING] });
    const b = await extract({ jsonLd: [FULL_POSTING] });
    expect(a!.structuredDataHash).toBeDefined();
    expect(a!.structuredDataHash).toBe(b!.structuredDataHash);
  });

  it("differs when the posting content changes", async () => {
    const a = await extract({ jsonLd: [FULL_POSTING] });
    const b = await extract({ jsonLd: [MINIMAL] });
    expect(a!.structuredDataHash).not.toBe(b!.structuredDataHash);
  });
});
