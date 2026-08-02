// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The `extract()` half of each host adapter, against realistic page markup.
 *
 * These are the most brittle functions in the lane by construction — every one is
 * a set of CSS selectors aimed at someone else's markup, and they rot when that
 * markup changes. Which is the argument for covering them rather than only their
 * `matches()` counterparts (`./adapters.test.ts`): when a selector does rot, the
 * adapter does not throw, it silently returns a worse result or `null`, and a page
 * that used to extract quietly falls through to the catch-all tier.
 *
 * Each case therefore asserts the *specific* selector path an adapter was written
 * for, not merely that something came back.
 */

import { greenhouse } from "./adapters/greenhouse";
import { lever } from "./adapters/lever";
import { workday } from "./adapters/workday";
import { oracleHcm } from "./adapters/oracle-hcm";
import { smartrecruiters } from "./adapters/smartrecruiters";
import { generic } from "./adapters/generic";
import { linkedin } from "./adapters/linkedin";

function doc(html: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    "text/html",
  );
}

/** Long enough to clear the adapters' 100-character body floor. */
const LONG_BODY =
  "<p>We are looking for an experienced engineer to join the platform team and " +
  "help us build reliable distributed systems at scale.</p>";

describe("greenhouse.extract — direct board page", () => {
  const url = new URL("https://boards.greenhouse.io/acme/jobs/4012345");

  it("extracts from the board's own markup", () => {
    const result = greenhouse.extract(
      doc(
        '<h1 class="app-title">Backend Engineer</h1>' +
          '<span class="company-name">Acme Inc</span>' +
          '<div class="location">Austin, TX</div>' +
          `<div id="content">${LONG_BODY}<ul><li>Go</li><li>Postgres</li></ul></div>`,
      ),
      url,
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Backend Engineer");
    expect(result!.company).toBe("Acme Inc");
    expect(result!.location).toBe("Austin, TX");
    expect(result!.extractionTier).toBe("ats_extractor");
    expect(result!.atsDetected).toBe("greenhouse");
    expect(result!.body).toContain("- Go");
  });

  // Board URLs are `/<company>/jobs/<id>`, so the path carries the company when
  // the page does not name it.
  it("falls back to the company slug in the URL path", () => {
    const result = greenhouse.extract(
      doc(`<h1>Backend Engineer</h1><div id="content">${LONG_BODY}</div>`),
      url,
    );
    expect(result!.company).toBe("acme");
  });

  it("returns null with no title", () => {
    expect(greenhouse.extract(doc(`<div id="content">${LONG_BODY}</div>`), url)).toBeNull();
  });
});

describe("greenhouse.extract — embedded widget", () => {
  // The embedded case is the one that matters for dedup: the visible URL is the
  // company's own domain, so without recovering the board URL the same posting
  // saved here and on the board itself forks into two records.
  const url = new URL("https://acme.com/careers?gh_jid=4012345");

  it("recovers the canonical board URL from the widget iframe", () => {
    const result = greenhouse.extract(
      doc(
        '<iframe id="grnhse_iframe" src="https://boards.greenhouse.io/acmecorp/jobs/4012345"></iframe>',
      ),
      url,
    );
    expect(result!.atsUrl).toBe("https://boards.greenhouse.io/acmecorp/jobs/4012345");
    expect(result!.jobId).toBe("4012345");
  });

  it("recovers the board slug from the embed script when no iframe has rendered", () => {
    const result = greenhouse.extract(
      doc(
        '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmecorp"></script>',
      ),
      url,
    );
    expect(result!.atsUrl).toBe("https://boards.greenhouse.io/acmecorp/jobs/4012345");
  });

  it("takes the job id from gh_jid when the iframe omits it", () => {
    const result = greenhouse.extract(doc("<h1>Engineer</h1>"), url);
    expect(result!.jobId).toBe("4012345");
    // No board slug anywhere, so no canonical URL can be built.
    expect(result!.atsUrl).toBeUndefined();
  });

  // atsUrl is the entire point of this path — without an id there is nothing to
  // contribute that the general tiers could not.
  it("returns null when there is no job id at all", () => {
    expect(
      greenhouse.extract(doc('<iframe id="grnhse_iframe"></iframe>'), new URL("https://acme.com/careers")),
    ).toBeNull();
  });

  // The description lives inside a cross-origin iframe and is not readable here.
  it("returns an empty body rather than scraping the host page", () => {
    const result = greenhouse.extract(
      doc(
        `<iframe id="grnhse_iframe" src="https://boards.greenhouse.io/acmecorp/jobs/4012345"></iframe>${LONG_BODY}`,
      ),
      url,
    );
    expect(result!.body).toBe("");
  });
});

describe("lever.extract", () => {
  const url = new URL("https://jobs.lever.co/acme/0d5c1d1e-1b1e-4b1e-8b1e-1b1e4b1e8b1e");

  // Lever splits the body across several .section-wrapper elements — taking only
  // the first would drop most of the JD.
  it("concatenates every section wrapper into one body", () => {
    const result = lever.extract(
      doc(
        '<div class="posting-headline"><h2>Staff Engineer</h2></div>' +
          '<div class="posting-page">' +
          `<div class="section-wrapper"><p>About the role.</p></div>` +
          `<div class="section-wrapper"><ul><li>Rust</li></ul></div>` +
          `<div class="section-wrapper"><p>Benefits.</p></div>` +
          "</div>",
      ),
      url,
    );

    expect(result!.title).toBe("Staff Engineer");
    expect(result!.body).toContain("About the role.");
    expect(result!.body).toContain("- Rust");
    expect(result!.body).toContain("Benefits.");
  });

  it("reads location and work model from Lever's own category fields", () => {
    const result = lever.extract(
      doc(
        '<div class="posting-headline"><h2>Staff Engineer</h2></div>' +
          '<div class="posting-categories"><span class="location">Remote - US</span>' +
          '<span class="workplaceType">Remote</span></div>' +
          `<div class="posting-page"><div class="section-wrapper">${LONG_BODY}</div></div>`,
      ),
      url,
    );
    expect(result!.location).toBe("Remote - US");
    expect(result!.workModel).toBe("Remote");
  });

  it("falls back to .content when no section wrappers exist", () => {
    const result = lever.extract(
      doc(`<h1>Staff Engineer</h1><div class="content">${LONG_BODY}</div>`),
      url,
    );
    expect(result!.body).toContain("experienced engineer");
  });

  it("falls back to the company slug in the URL path", () => {
    const result = lever.extract(
      doc(`<h1>Staff Engineer</h1><div class="content">${LONG_BODY}</div>`),
      url,
    );
    expect(result!.company).toBe("acme");
  });

  it("returns null with no title", () => {
    expect(lever.extract(doc(`<div class="content">${LONG_BODY}</div>`), url)).toBeNull();
  });
});

describe("workday.extract", () => {
  const url = new URL("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin/Eng_R123");

  // Selectors key on data-automation-id, Workday's own stable test-hook attribute,
  // rather than its generated CSS class names.
  it("extracts via data-automation-id attributes", () => {
    const result = workday.extract(
      doc(
        '<h1 data-automation-id="jobPostingHeader">Senior Engineer</h1>' +
          '<div data-automation-id="jobPostingCompanyName">Acme</div>' +
          '<div data-automation-id="locations">Austin, TX</div>' +
          `<div data-automation-id="jobPostingDescription">${LONG_BODY}<ul><li>Java</li></ul></div>`,
      ),
      url,
    );

    expect(result!.title).toBe("Senior Engineer");
    expect(result!.company).toBe("Acme");
    expect(result!.location).toBe("Austin, TX");
    expect(result!.atsDetected).toBe("workday");
    expect(result!.body).toContain("- Java");
  });

  it("falls back to the jobPostingTitle automation id", () => {
    const result = workday.extract(
      doc(
        '<h2 data-automation-id="jobPostingTitle">Senior Engineer</h2>' +
          `<div class="jobDescription">${LONG_BODY}</div>`,
      ),
      url,
    );
    expect(result!.title).toBe("Senior Engineer");
  });

  it("returns null with no title", () => {
    expect(workday.extract(doc(`<div class="jobDescription">${LONG_BODY}</div>`), url)).toBeNull();
  });
});

describe("oracleHcm.extract", () => {
  const url = new URL("https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/job/123");

  it("extracts from Oracle's job-detail classes", () => {
    const result = oracleHcm.extract(
      doc(
        '<div class="job-title">Data Engineer</div>' +
          '<div class="job-company">Acme</div>' +
          '<div class="job-location">Hyderabad, India</div>' +
          `<div class="job-description">${LONG_BODY}<ul><li>Python</li></ul></div>`,
      ),
      url,
    );

    expect(result!.title).toBe("Data Engineer");
    expect(result!.company).toBe("Acme");
    expect(result!.location).toBe("Hyderabad, India");
    expect(result!.atsDetected).toBe("oracle-hcm");
    expect(result!.body).toContain("- Python");
  });

  it("falls back to a partial-class description container", () => {
    const result = oracleHcm.extract(
      doc(`<h1>Data Engineer</h1><div class="jobDescriptionBody">${LONG_BODY}</div>`),
      url,
    );
    expect(result!.body).toContain("experienced engineer");
  });

  it("returns null with no title", () => {
    expect(oracleHcm.extract(doc(LONG_BODY), url)).toBeNull();
  });
});

describe("smartrecruiters.extract", () => {
  const url = new URL("https://jobs.smartrecruiters.com/Acme/744000112520307-staff-engineer");

  // SmartRecruiters serves an IE11 sunset notice whose <h1> precedes the real
  // title in document order — a generic h1 read would capture that banner, which
  // is why this adapter never falls back to h1.
  it("prefers .summary-title over an earlier unrelated h1", () => {
    const result = smartrecruiters.extract(
      doc(
        "<h1>Your browser is no longer supported</h1>" +
          '<h2 class="summary-title">Staff Engineer</h2>' +
          `<div class="jobad-container">${LONG_BODY}</div>`,
      ),
      url,
    );
    expect(result!.title).toBe("Staff Engineer");
  });

  it("extracts the requisition id from the URL path", () => {
    const result = smartrecruiters.extract(
      doc(`<h2 class="summary-title">Staff Engineer</h2><div class="jobad-container">${LONG_BODY}</div>`),
      url,
    );
    expect(result!.jobId).toBe("744000112520307");
    expect(result!.company).toBe("Acme");
  });

  it("returns null when the body is too short to be a posting", () => {
    expect(
      smartrecruiters.extract(
        doc('<h2 class="summary-title">Staff Engineer</h2><div class="jobad-container">Tiny</div>'),
        url,
      ),
    ).toBeNull();
  });

  it("returns null with no title", () => {
    expect(smartrecruiters.extract(doc(`<div class="jobad-container">${LONG_BODY}</div>`), url)).toBeNull();
  });
});

describe("generic.extract", () => {
  const url = new URL("https://careers.acme.com/jobs/9");

  it("reads company from og:site_name when present", () => {
    const d = doc(`<h1>Platform Engineer</h1><main>${LONG_BODY}</main>`);
    const meta = d.createElement("meta");
    meta.setAttribute("property", "og:site_name");
    meta.setAttribute("content", "Acme");
    d.head.appendChild(meta);

    const result = generic.extract(d, url);
    expect(result!.company).toBe("Acme");
    expect(result!.extractionTier).toBe("dom_metadata");
  });

  it("falls back to the trailing segment of the page title", () => {
    const d = doc(`<h1>Platform Engineer</h1><main>${LONG_BODY}</main>`);
    d.title = "Platform Engineer | Acme Careers";
    expect(generic.extract(d, url)!.company).toBe("Acme Careers");
  });

  // The domain is always available, which is what lets this adapter — the ladder's
  // floor — return a usable result rather than null for want of a company.
  it("falls back to the bare domain", () => {
    const result = generic.extract(doc(`<h1>Platform Engineer</h1><main>${LONG_BODY}</main>`), url);
    expect(result!.company).toBe("careers");
  });

  // Landmark elements only — body would sweep in header, nav and footer.
  it("reads only landmark elements, not the whole body", () => {
    const result = generic.extract(
      doc(
        "<header>Site navigation menu goes here</header>" +
          `<h1>Platform Engineer</h1><main>${LONG_BODY}</main>` +
          "<footer>Copyright notice</footer>",
      ),
      url,
    );
    expect(result!.body).not.toContain("Site navigation");
    expect(result!.body).not.toContain("Copyright notice");
  });

  it("returns null when the landmark holds page chrome rather than a posting", () => {
    expect(generic.extract(doc("<h1>Engineer</h1><main>Home About Contact</main>"), url)).toBeNull();
  });

  it("returns null with no h1", () => {
    expect(generic.extract(doc(`<main>${LONG_BODY}</main>`), url)).toBeNull();
  });

  it("drops a related-jobs rail, whose titles would score as this posting's terms", () => {
    const result = generic.extract(
      doc(
        `<h1>Platform Engineer</h1><main>${LONG_BODY}` +
          "<section><h2>Related jobs</h2><ul><li>Principal Kubernetes Architect at OtherCo</li></ul></section>" +
          "</main>",
      ),
      url,
    );
    expect(result!.body).not.toContain("Principal Kubernetes Architect");
    expect(result!.body).toContain("distributed systems");
  });
});

/**
 * LinkedIn is the highest-volume source in the `job-hunt` lane and the one general
 * tier that has nothing to fall back on — the logged-in job view ships neither
 * JSON-LD nor `og:` tags, so if this adapter misses, the most commonly captured
 * posting gets the worst extraction available.
 */
describe("linkedin.extract", () => {
  const url = new URL("https://www.linkedin.com/jobs/view/4437835690/");

  /** The logged-in job view's shape: description and page furniture share `<main>`. */
  function linkedInDoc(extra = ""): Document {
    const d = doc(
      "<main>" +
        "<h1>Staff Data Engineer</h1>" +
        '<div class="job-details-jobs-unified-top-card__company-name"><a>ExampleCo</a></div>' +
        '<div id="job-details"><h2>About the job</h2>' +
        "<p>Own the streaming platform end to end, from ingestion through serving.</p>" +
        "<h3>Qualifications</h3><ul><li>8+ years with Python and Spark</li></ul></div>" +
        extra +
        "</main>",
    );
    d.title = "Staff Data Engineer | ExampleCo | LinkedIn";
    return d;
  }

  it("extracts title, company and body from the logged-in view", () => {
    const result = linkedin.extract(linkedInDoc(), url);

    expect(result!.title).toBe("Staff Data Engineer");
    expect(result!.company).toBe("ExampleCo");
    expect(result!.body).toContain("Python and Spark");
    // LinkedIn is an aggregator, not an ATS — reporting one would misstate how the
    // posting was obtained.
    expect(result!.extractionTier).toBe("dom_metadata");
    expect(result!.atsDetected).toBeUndefined();
  });

  it("falls back to the page title when the DOM carries no company", () => {
    const d = doc(
      '<main><h1>Staff Data Engineer</h1><div id="job-details">' +
        `${LONG_BODY}</div></main>`,
    );
    d.title = "Staff Data Engineer | ExampleCo | LinkedIn";

    expect(linkedin.extract(d, url)!.company).toBe("ExampleCo");
  });

  // Degrades rather than returning null: the body and URL still carry real value.
  it("reports an unknown company rather than discarding the posting", () => {
    const d = doc(`<main><h1>Staff Data Engineer</h1><div>${LONG_BODY}</div></main>`);
    d.title = "";

    expect(linkedin.extract(d, url)!.company).toBe("Unknown");
  });

  it("returns null when the SPA has not rendered the posting yet", () => {
    const d = doc("<main><h1>Staff Data Engineer</h1><nav>Home Jobs Messaging</nav></main>");
    expect(linkedin.extract(d, url)).toBeNull();
  });

  it("returns null with no title", () => {
    expect(linkedin.extract(doc(`<main>${LONG_BODY}</main>`), url)).toBeNull();
  });

  /**
   * The regression this adapter's pruning exists for. `body` becomes
   * `JobRecord.jdText` and is persisted to the user's IndexedDB, so a connection's
   * name reaching it is a privacy defect, not a quality one — asserted on the names
   * themselves for that reason. Personas are synthetic.
   */
  it("keeps the 'People you can reach out to' block out of the body", () => {
    const result = linkedin.extract(
      linkedInDoc(
        '<section class="people-who-can-help"><h2>People you can reach out to</h2>' +
          "<ul><li><a>Dana Whitfield</a><span>Senior Recruiter at ExampleCo</span>" +
          "<span>Purdue University</span></li></ul></section>",
      ),
      url,
    );

    expect(result!.body).not.toContain("Dana Whitfield");
    expect(result!.body).not.toContain("Purdue University");
    expect(result!.body).toContain("Python and Spark");
  });

  it("keeps other postings' titles out of the body", () => {
    const result = linkedin.extract(
      linkedInDoc(
        "<section><h2>More jobs for you</h2>" +
          "<ul><li>Principal Data Engineer at OtherCo</li></ul></section>" +
          "<footer>Amharic Arabic Bangla Czech Danish</footer>",
      ),
      url,
    );

    expect(result!.body).not.toContain("Principal Data Engineer at OtherCo");
    expect(result!.body).not.toContain("Amharic");
    expect(result!.body).toContain("streaming platform");
  });
});
