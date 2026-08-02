// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The dispatcher — tier ordering and fall-through.
 *
 * The ordering assertions here are the ones worth keeping. Dispatch is
 * first-hit-wins, `generic.matches()` returns `true` unconditionally, and the
 * failure mode of a wrong order is silent: the page still extracts, just by a worse
 * tier than the one written for it. Nothing else in the suite would catch that.
 */

import { DOM_EXTRACTORS, extractPostingFromDocument } from "./detect";
import { EXTRACTION_ALGORITHM_VERSION } from "./types";

function pageFrom(html: string, url: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { doc, url: new URL(url) };
}

function extract(html: string, url = "https://careers.example.com/jobs/1") {
  const { doc, url: parsed } = pageFrom(html, url);
  return extractPostingFromDocument(doc, parsed);
}

/** Enough job-page vocabulary to clear the signal gate. */
const JOB_SIGNALS_TEXT =
  "<p>Job description. Responsibilities and requirements. Equal opportunity employer.</p>";

const JSON_LD = `<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Staff Engineer",
  hiringOrganization: { "@type": "Organization", name: "Acme" },
  description: "<p>Build things.</p><ul><li>5 years TypeScript</li></ul>",
})}</script>`;

describe("DOM_EXTRACTORS ordering", () => {
  // `generic` accepts every page, so anything after it would be unreachable.
  it("registers generic last", () => {
    expect(DOM_EXTRACTORS[DOM_EXTRACTORS.length - 1].name).toBe("generic");
  });

  it("is the exact expected order", () => {
    expect(DOM_EXTRACTORS.map((e) => e.name)).toEqual([
      "greenhouse",
      "lever",
      "linkedin",
      "workday",
      "oracle-hcm",
      "smartrecruiters",
      "generic",
    ]);
  });

  it("registers linkedin before generic, or LinkedIn gets the catch-all", () => {
    const names = DOM_EXTRACTORS.map((e) => e.name);
    expect(names.indexOf("linkedin")).toBeLessThan(names.indexOf("generic"));
  });

  it("has exactly one adapter that matches unconditionally", () => {
    const alwaysMatch = DOM_EXTRACTORS.filter((e) =>
      e.matches(new URL("https://unrelated.example/x"), new DOMParser().parseFromString("<html></html>", "text/html")),
    );
    expect(alwaysMatch.map((e) => e.name)).toEqual(["generic"]);
  });
});

describe("tier 1 wins outright", () => {
  it("extracts a JSON-LD page via schema_org", async () => {
    const result = await extract(`<html><head>${JSON_LD}</head><body></body></html>`);
    expect(result!.extractionTier).toBe("schema_org");
    expect(result!.title).toBe("Staff Engineer");
    expect(result!.company).toBe("Acme");
  });

  // Tier 1 runs before the job-signal gate: a valid JobPosting block is itself
  // conclusive, so a page carrying one must never be rejected by a keyword
  // heuristic. This page has an <h1> and no job vocabulary whatsoever.
  it("extracts JSON-LD even on a page that would fail the signal gate", async () => {
    const result = await extract(
      `<html><head>${JSON_LD}</head><body><h1>x</h1></body></html>`,
      "https://example.com/",
    );
    expect(result!.extractionTier).toBe("schema_org");
  });

  // The acceptance criterion: a JSON-LD page must be read with no host-specific
  // code executing. Proved by putting the page on a Workday host and asserting
  // none of Workday's fields (which the markup does not carry) appear.
  it("runs no host adapter when JSON-LD is present", async () => {
    const result = await extract(
      `<html><head>${JSON_LD}</head><body><h1>Workday Heading</h1></body></html>`,
      "https://acme.wd5.myworkdayjobs.com/job/123",
    );
    expect(result!.extractionTier).toBe("schema_org");
    expect(result!.title).toBe("Staff Engineer");
    expect(result!.atsDetected).toBe("Workday"); // named, but not extracted by
  });
});

describe("fall-through when there is no JSON-LD", () => {
  it("falls through to a host adapter", async () => {
    const result = await extract(
      `<html><body><h1 class="app-title">Backend Engineer</h1>` +
        `<div id="content">${JOB_SIGNALS_TEXT}<ul><li>Go</li><li>Postgres</li></ul></div>` +
        `</body></html>`,
      "https://boards.greenhouse.io/acme/jobs/123",
    );
    expect(result!.extractionTier).toBe("ats_extractor");
    expect(result!.atsDetected).toBe("greenhouse");
    expect(result!.title).toBe("Backend Engineer");
    expect(result!.body).toContain("- Go");
  });

  it("falls through to the generic adapter on an unknown host", async () => {
    const result = await extract(
      `<html><head><meta property="og:site_name" content="Acme"></head><body>` +
        `<h1>Platform Engineer</h1><main>${JOB_SIGNALS_TEXT}` +
        `<ul><li>Kubernetes</li><li>Terraform</li></ul></main></body></html>`,
      "https://careers.acme.com/jobs/9",
    );
    expect(result!.extractionTier).toBe("dom_metadata");
    expect(result!.title).toBe("Platform Engineer");
    expect(result!.body).toContain("- Kubernetes");
  });

  it("does not throw on a page with no JSON-LD and nothing a host claims", async () => {
    await expect(
      extract(`<html><body>${JOB_SIGNALS_TEXT}</body></html>`),
    ).resolves.not.toThrow();
  });
});

describe("returns null rather than a partial result", () => {
  // A half-filled result looks like a successful extraction to every caller
  // downstream, which is worse than reporting nothing.
  it("returns null for a page with no job signals at all", async () => {
    expect(
      await extract(
        "<html><body><h1>About us</h1><p>We make software.</p></body></html>",
        "https://example.com/about",
      ),
    ).toBeNull();
  });

  it("returns null when a page has signals but no title", async () => {
    expect(await extract(`<html><body>${JOB_SIGNALS_TEXT}</body></html>`)).toBeNull();
  });

  it("returns null when the body is too short to be a posting", async () => {
    expect(
      await extract(
        `<html><body><h1>Engineer</h1>${JOB_SIGNALS_TEXT}<main>Tiny</main></body></html>`,
      ),
    ).toBeNull();
  });
});

describe("the LinkedIn path", () => {
  // LinkedIn ships no JSON-LD and no og: tags on the logged-in job view, so this
  // is the case where every general tier misses and only the adapter works.
  const LINKEDIN_PAGE =
    `<html><head><title>Director, Engineering - Agentic Systems | Visa | LinkedIn</title></head>` +
    `<body><div aria-label="Company, Visa.">v</div><h1>Director, Engineering</h1>` +
    `<main>${JOB_SIGNALS_TEXT}<ul><li>Distributed systems</li><li>Team leadership</li></ul>` +
    `<p>You will lead a team building agentic systems at scale.</p></main></body></html>`;

  it("extracts a logged-in job view via the LinkedIn adapter", async () => {
    const result = await extract(
      LINKEDIN_PAGE,
      "https://www.linkedin.com/jobs/view/4437835690/",
    );
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Director, Engineering");
    expect(result!.company).toBe("Visa");
    expect(result!.body).toContain("- Distributed systems");
  });

  it("recovers the company from the page title when the aria-label is absent", async () => {
    const result = await extract(
      LINKEDIN_PAGE.replace('<div aria-label="Company, Visa.">v</div>', ""),
      "https://www.linkedin.com/jobs/view/4437835690/",
    );
    expect(result!.company).toBe("Visa");
  });
});

describe("every result is stamped", () => {
  it("carries the algorithm version", async () => {
    const result = await extract(`<html><head>${JSON_LD}</head><body></body></html>`);
    expect(result!.algorithmVersion).toBe(EXTRACTION_ALGORITHM_VERSION);
  });

  // A bump must be a visible diff, not an incidental one.
  it("EXTRACTION_ALGORITHM_VERSION is a positive integer", () => {
    expect(Number.isInteger(EXTRACTION_ALGORITHM_VERSION)).toBe(true);
    expect(EXTRACTION_ALGORITHM_VERSION).toBeGreaterThan(0);
  });
});

describe("dom-metadata enrichment", () => {
  it("fills a job id the winning tier missed, without touching its other fields", async () => {
    const result = await extract(
      `<html><head>${JSON_LD}<meta name="requisitionId" content="R-9182"></head>` +
        `<body></body></html>`,
    );
    expect(result!.jobId).toBe("R-9182");
    // The tier that won still owns the fields it extracted.
    expect(result!.title).toBe("Staff Engineer");
    expect(result!.company).toBe("Acme");
  });
});
