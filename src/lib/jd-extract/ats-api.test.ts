// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The `ats_api` tier, and the full ladder that interleaves it.
 *
 * The tier itself takes a URL rather than a `Document` — which is exactly why it
 * lives outside `./detect.ts` and outside the injectable bundle. jsdom is here only
 * for the ladder cases at the bottom, which need a real document to fall through to.
 *
 * `fetch` is stubbed rather than the module mocked, so the real `parseAtsUrl` and
 * the real platform clients run. Mocking `fetch-jd.ts` would defeat the point —
 * the thing worth asserting is that this tier delegates to that module instead of
 * carrying a second ATS-URL parser.
 */

import { extractPosting, extractPostingFromAtsApi, isAtsApiUrl } from "./ats-api";
import { EXTRACTION_ALGORITHM_VERSION } from "./types";

const GREENHOUSE_URL = "https://boards.greenhouse.io/acme/jobs/4012345";

function stubFetch(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("isAtsApiUrl", () => {
  it.each([
    ["https://boards.greenhouse.io/acme/jobs/123", true],
    ["https://jobs.lever.co/acme/0d5c1d1e-1b1e-4b1e-8b1e-1b1e4b1e8b1e", true],
    ["https://apply.workable.com/acme/j/ABC123", true],
    ["https://acme.recruitee.com/o/engineer", true],
    // Not fetchable — no public JSON API, so the DOM tiers handle these.
    ["https://www.linkedin.com/jobs/view/123/", false],
    ["https://www.indeed.com/viewjob?jk=abc", false],
    ["https://acme.wd5.myworkdayjobs.com/job/1", false],
  ])("%s → %s", (url, expected) => {
    expect(isAtsApiUrl(url)).toBe(expected);
  });
});

describe("extractPostingFromAtsApi", () => {
  it("returns null for a URL no supported platform claims, with no network call", async () => {
    const fetchStub = stubFetch({});
    vi.stubGlobal("fetch", fetchStub);

    expect(
      await extractPostingFromAtsApi("https://www.linkedin.com/jobs/view/123/"),
    ).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("extracts a Greenhouse posting", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        title: "Staff Engineer",
        company: { name: "Acme" },
        content: "<p>Build things.</p><ul><li>5 years TypeScript</li></ul>",
      }),
    );

    const result = await extractPostingFromAtsApi(GREENHOUSE_URL);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Staff Engineer");
    expect(result!.company).toBe("Acme");
    expect(result!.extractionTier).toBe("ats_api");
    expect(result!.atsDetected).toBe("greenhouse");
    expect(result!.algorithmVersion).toBe(EXTRACTION_ALGORITHM_VERSION);
  });

  // The whole reason `fetchJdFromUrl` now passes `descriptionHtml` through: the
  // plaintext it also returns has already lost the list structure that the fit
  // rating's term extraction depends on.
  it("converts the platform's HTML to Markdown rather than taking its plaintext", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        title: "Staff Engineer",
        company: { name: "Acme" },
        content: "<p>Build things.</p><ul><li>5 years TypeScript</li><li>Go</li></ul>",
      }),
    );

    const result = await extractPostingFromAtsApi(GREENHOUSE_URL);
    expect(result!.body).toContain("- 5 years TypeScript");
    expect(result!.body).toContain("- Go");
  });

  it("sets a preview capped at 200 characters", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        title: "Staff Engineer",
        company: { name: "Acme" },
        content: `<p>${"x".repeat(500)}</p>`,
      }),
    );

    const result = await extractPostingFromAtsApi(GREENHOUSE_URL);
    expect(result!.descriptionPreview).toHaveLength(200);
  });

  // An ATS API being down is a reason to read the page instead, not a reason for
  // the whole extraction to fail.
  it("returns null on an API error rather than throwing", async () => {
    vi.stubGlobal("fetch", stubFetch({}, false));
    await expect(extractPostingFromAtsApi(GREENHOUSE_URL)).resolves.toBeNull();
  });

  it("returns null on a network failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(extractPostingFromAtsApi(GREENHOUSE_URL)).resolves.toBeNull();
  });

  // Same rule as every other tier — a partial result is worse than none.
  it("returns null when the platform gives no title", async () => {
    vi.stubGlobal("fetch", stubFetch({ company: { name: "Acme" }, content: "<p>x</p>" }));
    expect(await extractPostingFromAtsApi(GREENHOUSE_URL)).toBeNull();
  });
});

describe("extractPosting — the full ladder", () => {
  function docFrom(html: string): Document {
    return new DOMParser().parseFromString(html, "text/html");
  }

  const JSON_LD_PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "From JSON-LD",
    hiringOrganization: { "@type": "Organization", name: "Acme" },
  })}</script></head><body></body></html>`;

  // Tier 1 outranks the API tier, so a page that declares itself needs no
  // network round-trip at all.
  it("prefers schema_org over the API tier, and makes no network call", async () => {
    const fetchStub = stubFetch({});
    vi.stubGlobal("fetch", fetchStub);

    const result = await extractPosting(
      docFrom(JSON_LD_PAGE),
      new URL(GREENHOUSE_URL),
    );

    expect(result!.extractionTier).toBe("schema_org");
    expect(result!.title).toBe("From JSON-LD");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("uses the API tier when the page ships no JSON-LD", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ title: "From API", company: { name: "Acme" }, content: "<p>Body.</p>" }),
    );

    const result = await extractPosting(
      docFrom("<html><body><h1>Ignored</h1></body></html>"),
      new URL(GREENHOUSE_URL),
    );

    expect(result!.extractionTier).toBe("ats_api");
    expect(result!.title).toBe("From API");
  });

  // A non-fetchable host must cost no round-trip on its way to the DOM tiers.
  it("skips the API tier entirely for a host with no public API", async () => {
    const fetchStub = stubFetch({});
    vi.stubGlobal("fetch", fetchStub);

    await extractPosting(
      docFrom(
        "<html><body><h1>Engineer</h1><main><p>Job description. Responsibilities and requirements. Equal opportunity employer.</p></main></body></html>",
      ),
      new URL("https://www.linkedin.com/jobs/view/123/"),
    );

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("falls through to the DOM tiers when the API tier fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const result = await extractPosting(
      docFrom(
        `<html><body><h1 class="app-title">From DOM</h1><div id="content"><p>Job description. Responsibilities and requirements. Equal opportunity employer. Build systems at scale.</p></div></body></html>`,
      ),
      new URL(GREENHOUSE_URL),
    );

    expect(result!.extractionTier).toBe("ats_extractor");
    expect(result!.title).toBe("From DOM");
  });
});
