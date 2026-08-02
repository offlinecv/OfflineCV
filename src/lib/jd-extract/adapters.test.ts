// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// `matches()` is pure URL/fingerprint dispatch, so these run in the node
// environment against minimal stubs — no jsdom, no fixture pages. The extraction
// half of each adapter needs a real DOM and is covered in `./detect.test.ts`.
//
// The exclusivity matrix at the bottom is the load-bearing part. Dispatch is
// first-match-wins over an ordered list, so an adapter that over-matches does not
// merely add a wrong result — it *silently steals* pages from the adapter written
// for them, and the symptom (a slightly worse extraction) looks nothing like the
// cause.

import { greenhouse } from "./adapters/greenhouse";
import { lever } from "./adapters/lever";
import { linkedin } from "./adapters/linkedin";
import { workday } from "./adapters/workday";
import { oracleHcm } from "./adapters/oracle-hcm";
import { smartrecruiters } from "./adapters/smartrecruiters";
import { generic } from "./adapters/generic";
import type { ATSExtractor } from "./types";

const emptyDoc = {
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
} as unknown as Document;

/** A stub whose only readable feature is one `<meta>` tag — Oracle's last resort. */
function docWithGenerator(content: string): Document {
  return {
    querySelector: (selector: string) =>
      selector === 'meta[name="generator"]'
        ? { getAttribute: () => content }
        : null,
    querySelectorAll: () => [],
    getElementById: () => null,
  } as unknown as Document;
}

describe("greenhouse.matches", () => {
  it.each([
    ["https://boards.greenhouse.io/acme/jobs/123", true],
    ["https://acme.greenhouse.io/jobs/123", true],
    ["https://jobs.lever.co/acme/123", false],
    ["https://acme.wd5.myworkdayjobs.com/job/123", false],
    ["https://careers.google.com/jobs/123", false],
  ])("%s → %s", (url, expected) => {
    expect(greenhouse.matches(new URL(url), emptyDoc)).toBe(expected);
  });

  // The embedded case is why Greenhouse has fingerprints beyond its hostname: the
  // visible URL is the company's own domain and says nothing about Greenhouse.
  it("matches an embedded board via the gh_jid parameter", () => {
    expect(
      greenhouse.matches(new URL("https://acme.com/careers?gh_jid=456"), emptyDoc),
    ).toBe(true);
  });

  it("matches an embedded board via the widget iframe", () => {
    const doc = {
      querySelector: () => null,
      getElementById: (id: string) => (id === "grnhse_iframe" ? {} : null),
    } as unknown as Document;
    expect(greenhouse.matches(new URL("https://acme.com/careers"), doc)).toBe(true);
  });

  it("matches an embedded board via the embed script", () => {
    const doc = {
      querySelector: (s: string) =>
        s === 'script[src*="boards.greenhouse.io/embed"]' ? {} : null,
      getElementById: () => null,
    } as unknown as Document;
    expect(greenhouse.matches(new URL("https://acme.com/careers"), doc)).toBe(true);
  });
});

describe("lever.matches", () => {
  it.each([
    ["https://jobs.lever.co/acme/abc-123", true],
    ["https://boards.greenhouse.io/acme/jobs/123", false],
    // Exact-host match: `lever.co` marketing pages are not postings...
    ["https://lever.co/about", false],
    // ...and a hostname merely *containing* the string is a different company.
    ["https://notlever.co/jobs/123", false],
  ])("%s → %s", (url, expected) => {
    expect(lever.matches(new URL(url), emptyDoc)).toBe(expected);
  });
});

describe("workday.matches", () => {
  it.each([
    ["https://acme.myworkdayjobs.com/en-US/External/job/NYC/Eng_R123", true],
    ["https://acme.wd5.myworkdayjobs.com/job/123", true],
    ["https://acme.wd1.myworkdayjobs.com/job/123", true],
    ["https://boards.greenhouse.io/acme/jobs/123", false],
    ["https://careers.acme.com/jobs/123", false],
  ])("%s → %s", (url, expected) => {
    expect(workday.matches(new URL(url), emptyDoc)).toBe(expected);
  });
});

describe("oracleHcm.matches", () => {
  it.each([
    ["https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/job/123", true],
    // Tenant-owned domains keep Oracle's UI path segments even when the host
    // reveals nothing.
    ["https://careers.acme.com/hcmUI/CandidateExperience/job/123", true],
    ["https://careers.acme.com/fscmUI/jobs/123", true],
    ["https://boards.greenhouse.io/acme/jobs/123", false],
  ])("%s → %s", (url, expected) => {
    expect(oracleHcm.matches(new URL(url), emptyDoc)).toBe(expected);
  });

  it("matches on the Oracle generator meta tag as a last resort", () => {
    expect(
      oracleHcm.matches(
        new URL("https://careers.acme.com/jobs/123"),
        docWithGenerator("Oracle HCM Cloud"),
      ),
    ).toBe(true);
  });

  it("does not match a non-Oracle page with an empty generator", () => {
    expect(
      oracleHcm.matches(
        new URL("https://careers.acme.com/jobs/123"),
        docWithGenerator(""),
      ),
    ).toBe(false);
  });
});

describe("smartrecruiters.matches", () => {
  it.each([
    ["https://jobs.smartrecruiters.com/Acme/744000112520307-engineer", true],
    ["https://careers.smartrecruiters.com/Acme/123", true],
    ["https://boards.greenhouse.io/acme/jobs/123", false],
  ])("%s → %s", (url, expected) => {
    expect(smartrecruiters.matches(new URL(url), emptyDoc)).toBe(expected);
  });
});

describe("linkedin.matches", () => {
  it("matches a job view page", () => {
    expect(
      linkedin.matches(new URL("https://www.linkedin.com/jobs/view/4437835690/"), emptyDoc),
    ).toBe(true);
  });

  // Narrower than "is this LinkedIn" on purpose — search, company and feed pages
  // live on the same host and are not postings.
  it.each([
    "https://www.linkedin.com/jobs/search/?keywords=engineer",
    "https://www.linkedin.com/company/acme/",
    "https://www.linkedin.com/feed/",
  ])("does not match %s", (url) => {
    expect(linkedin.matches(new URL(url), emptyDoc)).toBe(false);
  });
});

describe("generic.matches", () => {
  it("always matches, which is why it must be registered last", () => {
    expect(generic.matches(new URL("https://anything.example/whatever"), emptyDoc)).toBe(
      true,
    );
  });
});

describe("cross-adapter exclusivity", () => {
  const owners: ReadonlyArray<[string, string]> = [
    ["greenhouse", "https://boards.greenhouse.io/acme/jobs/123"],
    ["lever", "https://jobs.lever.co/acme/abc-123"],
    ["workday", "https://acme.wd5.myworkdayjobs.com/job/123"],
    ["oracle-hcm", "https://acme.fa.us2.oraclecloud.com/hcmUI/job/123"],
    ["smartrecruiters", "https://jobs.smartrecruiters.com/Acme/744000112520307"],
    ["linkedin", "https://www.linkedin.com/jobs/view/4437835690/"],
  ];

  const adapters: ReadonlyArray<ATSExtractor> = [
    greenhouse,
    lever,
    workday,
    oracleHcm,
    smartrecruiters,
    linkedin,
  ];

  for (const [owner, url] of owners) {
    for (const adapter of adapters) {
      if (adapter.name === owner) continue;
      it(`${adapter.name} does not claim the ${owner} URL`, () => {
        expect(adapter.matches(new URL(url), emptyDoc)).toBe(false);
      });
    }
  }

  it("every owner claims its own URL", () => {
    for (const [owner, url] of owners) {
      const adapter = adapters.find((a) => a.name === owner);
      expect(adapter?.matches(new URL(url), emptyDoc)).toBe(true);
    }
  });
});
