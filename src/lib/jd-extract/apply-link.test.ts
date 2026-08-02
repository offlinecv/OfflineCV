// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Canonical ATS-URL discovery from an aggregator's apply button.
 *
 * This is dedup machinery, not application machinery: the same posting on
 * LinkedIn, on Indeed, and on the company's board must collapse to one record,
 * and `deriveJobId` keys on the URL. Nothing here clicks or submits anything.
 *
 * The three-way distinction in the result is what most of these cases pin down —
 * "found it", "the aggregator hosts the application so there is nothing to find",
 * and "there is an external apply but its URL is not in the DOM" call for different
 * handling, and the last one is invisible unless it is asserted.
 */

import { extractApplyLink, extractApplyLinkAsync } from "./apply-link";

function page(html: string, url: string) {
  return {
    doc: new DOMParser().parseFromString(
      `<!doctype html><html><body>${html}</body></html>`,
      "text/html",
    ),
    url: new URL(url),
  };
}

function run(html: string, url: string) {
  const { doc, url: parsed } = page(html, url);
  return extractApplyLink(doc, parsed);
}

const LINKEDIN_URL = "https://www.linkedin.com/jobs/view/123/";
const INDEED_URL = "https://www.indeed.com/viewjob?jk=abc123";
const GLASSDOOR_URL = "https://www.glassdoor.com/job-listing/eng-acme-JV_123.htm";

describe("LinkedIn", () => {
  it("finds an external apply link by aria-label", () => {
    const result = run(
      '<a aria-label="Apply to Engineer on company website" href="https://boards.greenhouse.io/acme/jobs/9">Apply</a>',
      LINKEDIN_URL,
    );
    expect(result.sourceUrl).toBe("https://boards.greenhouse.io/acme/jobs/9");
    expect(result.sourceDomain).toBe("boards.greenhouse.io");
    expect(result.isEasyApply).toBe(false);
  });

  // Left wrapped, the "canonical" URL would be a linkedin.com URL carrying a
  // per-impression tracking hash — which defeats the dedup this exists for.
  it("unwraps a /redir/redirect wrapper", () => {
    const target = "https://boards.greenhouse.io/acme/jobs/9";
    const result = run(
      `<a aria-label="Apply" href="https://www.linkedin.com/redir/redirect?url=${encodeURIComponent(target)}&urlhash=abcd">Apply</a>`,
      LINKEDIN_URL,
    );
    expect(result.sourceUrl).toBe(target);
  });

  it("unwraps a /safety/go wrapper found without a matching aria-label", () => {
    const target = "https://jobs.lever.co/acme/uuid";
    const result = run(
      `<a href="https://www.linkedin.com/safety/go?url=${encodeURIComponent(target)}">Continue</a>`,
      LINKEDIN_URL,
    );
    expect(result.sourceUrl).toBe(target);
  });

  it("reports Easy Apply, which has no external URL to find", () => {
    const result = run('<button aria-label="Easy Apply to Engineer">Easy Apply</button>', LINKEDIN_URL);
    expect(result.isEasyApply).toBe(true);
    expect(result.sourceUrl).toBeNull();
    expect(result.externalDetected).toBe(false);
  });

  it("ignores an apply link that stays on linkedin.com", () => {
    const result = run(
      '<a aria-label="Apply" href="https://www.linkedin.com/jobs/view/456/">Apply</a>',
      LINKEDIN_URL,
    );
    expect(result.sourceUrl).toBeNull();
  });
});

describe("Indeed", () => {
  it("finds an external link inside the apply container", () => {
    const result = run(
      '<div id="applyButtonLinkContainer"><a href="https://acme.wd5.myworkdayjobs.com/job/1">Apply on company site</a></div>',
      INDEED_URL,
    );
    expect(result.sourceUrl).toBe("https://acme.wd5.myworkdayjobs.com/job/1");
    expect(result.sourceDomain).toBe("acme.wd5.myworkdayjobs.com");
  });

  it("falls back to link text when no container matches", () => {
    const result = run(
      '<a href="https://boards.greenhouse.io/acme/jobs/9">Apply on company site</a>',
      INDEED_URL,
    );
    expect(result.sourceUrl).toBe("https://boards.greenhouse.io/acme/jobs/9");
  });

  it("reads a URL from a data attribute on a button", () => {
    const result = run(
      '<div id="applyButtonLinkContainer"><button data-apply-url="https://jobs.lever.co/acme/uuid">Apply</button></div>',
      INDEED_URL,
    );
    expect(result.sourceUrl).toBe("https://jobs.lever.co/acme/uuid");
  });

  it("reports Indeed-hosted apply as Easy Apply", () => {
    const result = run('<div class="indeed-apply-button">Apply now</div>', INDEED_URL);
    expect(result.isEasyApply).toBe(true);
  });
});

describe("Glassdoor", () => {
  // The one aggregator whose external apply URL is genuinely unreadable — the
  // button carries no href and resolves the destination through an API call.
  // This flag is the whole reason the result type is three-way rather than two.
  it("reports an external apply it cannot read, distinctly from finding nothing", () => {
    const result = run(
      '<button data-test="applyButton">Apply on employer site</button>',
      GLASSDOOR_URL,
    );
    expect(result.sourceUrl).toBeNull();
    expect(result.isEasyApply).toBe(false);
    expect(result.externalDetected).toBe(true);
  });

  it("distinguishes that case from a page with no apply route at all", () => {
    const result = run("<p>Nothing here</p>", GLASSDOOR_URL);
    expect(result.externalDetected).toBe(false);
    expect(result.isEasyApply).toBe(false);
    expect(result.sourceUrl).toBeNull();
  });

  it("reports Easy Apply", () => {
    const result = run('<div data-test="easyApply">Easy Apply</div>', GLASSDOOR_URL);
    expect(result.isEasyApply).toBe(true);
  });
});

describe("generic aggregator fallback", () => {
  it("finds an off-site apply link on an unrecognised host", () => {
    const result = run(
      '<a href="https://boards.greenhouse.io/acme/jobs/9">Apply for this job</a>',
      "https://jobs.example.com/listing/1",
    );
    expect(result.sourceUrl).toBe("https://boards.greenhouse.io/acme/jobs/9");
  });

  it("ignores a same-host apply link", () => {
    const result = run(
      '<a href="https://jobs.example.com/apply/1">Apply</a>',
      "https://jobs.example.com/listing/1",
    );
    expect(result.sourceUrl).toBeNull();
  });

  // A mailto: apply route is real on some postings but is not an ATS URL.
  it("ignores a non-http apply link", () => {
    const result = run(
      '<a href="mailto:jobs@example.com">Apply by email</a>',
      "https://jobs.example.com/listing/1",
    );
    expect(result.sourceUrl).toBeNull();
  });
});

describe("resilience", () => {
  it("never throws on a page with no links", () => {
    expect(() => run("<p>Empty</p>", LINKEDIN_URL)).not.toThrow();
  });

  // Data attributes are read raw via getAttribute, so an unparseable value here
  // reaches `new URL()` directly — unlike an `href`, which the DOM resolves
  // against the document base before we ever see it.
  it("skips a malformed data-attribute URL rather than throwing", () => {
    const result = run(
      '<div id="applyButtonLinkContainer"><button data-apply-url="ht!tp://[malformed">Apply</button></div>',
      INDEED_URL,
    );
    expect(result.sourceUrl).toBeNull();
  });

  it("skips a relative data-attribute URL, which points back at the aggregator", () => {
    const result = run(
      '<div id="applyButtonLinkContainer"><button data-apply-url="/apply/123">Apply</button></div>',
      INDEED_URL,
    );
    expect(result.sourceUrl).toBeNull();
  });
});

describe("extractApplyLinkAsync", () => {
  it("resolves immediately when the link is already present", async () => {
    const { doc, url } = page(
      '<a aria-label="Apply" href="https://boards.greenhouse.io/acme/jobs/9">Apply</a>',
      LINKEDIN_URL,
    );
    const result = await extractApplyLinkAsync(doc, url);
    expect(result.sourceUrl).toBe("https://boards.greenhouse.io/acme/jobs/9");
  });

  it("resolves when the apply button is rendered late", async () => {
    const { doc, url } = page("<div id=\"root\"></div>", LINKEDIN_URL);
    const pending = extractApplyLinkAsync(doc, url, 2_000);

    const link = doc.createElement("a");
    link.setAttribute("aria-label", "Apply");
    link.setAttribute("href", "https://jobs.lever.co/acme/uuid");
    doc.getElementById("root")!.appendChild(link);

    expect((await pending).sourceUrl).toBe("https://jobs.lever.co/acme/uuid");
  });

  // A caller waiting on a canonical URL must not have to handle a rejection for
  // the ordinary case of "this page has no apply button".
  it("resolves rather than rejecting when nothing ever appears", async () => {
    const { doc, url } = page("<p>Nothing</p>", LINKEDIN_URL);
    const result = await extractApplyLinkAsync(doc, url, 50);
    expect(result.sourceUrl).toBeNull();
  });
});
