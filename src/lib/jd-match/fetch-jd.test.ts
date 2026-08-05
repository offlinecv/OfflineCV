// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseAtsUrl,
  classifyUnsupportedHost,
  fetchJdFromUrl,
} from "./fetch-jd.ts";

describe("parseAtsUrl", () => {
  it("parses a Greenhouse URL", () => {
    const result = parseAtsUrl(
      "https://boards.greenhouse.io/acmecorp/jobs/7654321",
    );
    expect(result).toEqual({
      platform: "greenhouse",
      company: "acmecorp",
      jobId: "7654321",
    });
  });

  it("parses a Lever URL", () => {
    const result = parseAtsUrl(
      "https://jobs.lever.co/acmecorp/abcd1234-ef56-7890-abcd-ef1234567890",
    );
    expect(result).toEqual({
      platform: "lever",
      company: "acmecorp",
      jobId: "abcd1234-ef56-7890-abcd-ef1234567890",
    });
  });

  it("parses a Workable URL", () => {
    const result = parseAtsUrl(
      "https://apply.workable.com/acmecorp/j/AB12CD34EF",
    );
    expect(result).toEqual({
      platform: "workable",
      company: "acmecorp",
      jobId: "AB12CD34EF",
    });
  });

  it("parses a Recruitee URL", () => {
    const result = parseAtsUrl(
      "https://acmecorp.recruitee.com/o/senior-software-engineer",
    );
    expect(result).toEqual({
      platform: "recruitee",
      company: "acmecorp",
      jobId: "senior-software-engineer",
    });
  });

  it("parses an Ashby URL", () => {
    const result = parseAtsUrl(
      "https://jobs.ashbyhq.com/acmecorp/12345678-90ab-cdef-1234-567890abcdef",
    );
    expect(result).toEqual({
      platform: "ashby",
      company: "acmecorp",
      jobId: "12345678-90ab-cdef-1234-567890abcdef",
    });
  });

  it("does not match an Ashby URL with a non-UUID jobId", () => {
    // The UUID-strict tail keeps a stray ATS-shaped path from producing a
    // 404 on the public API. Falls through to "unsupported" instead.
    expect(
      parseAtsUrl("https://jobs.ashbyhq.com/acmecorp/not-a-uuid"),
    ).toBeNull();
  });

  it("returns null for a non-ATS URL", () => {
    const result = parseAtsUrl(
      "https://www.linkedin.com/jobs/view/1234567890",
    );
    expect(result).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseAtsUrl("")).toBeNull();
  });

  it("returns null for a non-URL string (malformed input, must not throw)", () => {
    expect(parseAtsUrl("not a url")).toBeNull();
  });

  // #726 — host matching must be anchored to `URL.hostname`, not a substring
  // scan of the raw string. Each platform gets a positive on its real host(s),
  // a look-alike-host negative, and (Recruitee) a bare-apex-domain negative.

  describe("Greenhouse — host anchoring (#726)", () => {
    it("parses the modern `job-boards.greenhouse.io` host", () => {
      expect(
        parseAtsUrl("https://job-boards.greenhouse.io/acme/jobs/123"),
      ).toEqual({ platform: "greenhouse", company: "acme", jobId: "123" });
    });

    it("still parses the legacy `boards.greenhouse.io` host", () => {
      expect(
        parseAtsUrl("https://boards.greenhouse.io/acme/jobs/123"),
      ).toEqual({ platform: "greenhouse", company: "acme", jobId: "123" });
    });

    it("rejects a look-alike host that merely contains the string boards.greenhouse.io", () => {
      expect(
        parseAtsUrl(
          "https://evil-boards.greenhouse.io.attacker.test/acme/jobs/123",
        ),
      ).toBeNull();
    });

    it("rejects a non-Greenhouse host with the target string in the path/query", () => {
      expect(
        parseAtsUrl(
          "https://example.test/redirect?to=boards.greenhouse.io/acme/jobs/123",
        ),
      ).toBeNull();
    });
  });

  describe("Lever — host anchoring (#726)", () => {
    it("parses jobs.lever.co", () => {
      expect(
        parseAtsUrl(
          "https://jobs.lever.co/acmecorp/abcd1234-ef56-7890-abcd-ef1234567890",
        ),
      ).toEqual({
        platform: "lever",
        company: "acmecorp",
        jobId: "abcd1234-ef56-7890-abcd-ef1234567890",
      });
    });

    it("rejects a look-alike host", () => {
      expect(
        parseAtsUrl(
          "https://evil-jobs.lever.co.attacker.test/acmecorp/abcd1234-ef56-7890-abcd-ef1234567890",
        ),
      ).toBeNull();
    });
  });

  describe("Workable — host anchoring (#726)", () => {
    it("parses apply.workable.com", () => {
      expect(
        parseAtsUrl("https://apply.workable.com/acmecorp/j/AB12CD34EF"),
      ).toEqual({ platform: "workable", company: "acmecorp", jobId: "AB12CD34EF" });
    });

    it("rejects a look-alike host", () => {
      expect(
        parseAtsUrl(
          "https://apply.workable.com.attacker.test/acmecorp/j/AB12CD34EF",
        ),
      ).toBeNull();
    });
  });

  describe("Recruitee — host anchoring (#726)", () => {
    it("parses the company wildcard subdomain", () => {
      expect(
        parseAtsUrl("https://acmecorp.recruitee.com/o/senior-software-engineer"),
      ).toEqual({
        platform: "recruitee",
        company: "acmecorp",
        jobId: "senior-software-engineer",
      });
    });

    it("rejects a look-alike host", () => {
      expect(
        parseAtsUrl(
          "https://acmecorp.recruitee.com.attacker.test/o/senior-software-engineer",
        ),
      ).toBeNull();
    });

    it("rejects the bare apex domain with no company subdomain", () => {
      expect(
        parseAtsUrl("https://recruitee.com/o/senior-software-engineer"),
      ).toBeNull();
    });
  });

  describe("Ashby — host anchoring (#726)", () => {
    it("parses jobs.ashbyhq.com", () => {
      expect(
        parseAtsUrl(
          "https://jobs.ashbyhq.com/acmecorp/12345678-90ab-cdef-1234-567890abcdef",
        ),
      ).toEqual({
        platform: "ashby",
        company: "acmecorp",
        jobId: "12345678-90ab-cdef-1234-567890abcdef",
      });
    });

    it("rejects a look-alike host", () => {
      expect(
        parseAtsUrl(
          "https://jobs.ashbyhq.com.attacker.test/acmecorp/12345678-90ab-cdef-1234-567890abcdef",
        ),
      ).toBeNull();
    });
  });

  /**
   * Scheme-less input (#726 review).
   *
   * `JdInput` passes the raw trimmed string straight through, so a paste of
   * `boards.greenhouse.io/acme/jobs/123` — the shape a board's own "copy link"
   * and every job aggregator hands out — reaches `new URL` with no scheme.
   * The pre-#726 substring matcher accepted these; anchoring on `URL.hostname`
   * without a retry regressed them to "unsupported", telling the user Greenhouse
   * URLs are supported about a Greenhouse URL.
   */
  describe("scheme-less input", () => {
    it.each([
      [
        "boards.greenhouse.io/acme/jobs/123",
        { platform: "greenhouse", company: "acme", jobId: "123" },
      ],
      [
        "boards.greenhouse.io/acme/jobs/123?gh_src=https://linkedin.com",
        { platform: "greenhouse", company: "acme", jobId: "123" },
      ],
      [
        "job-boards.greenhouse.io/acme/jobs/123",
        { platform: "greenhouse", company: "acme", jobId: "123" },
      ],
      [
        "apply.workable.com/acme/j/AB12CD34EF",
        { platform: "workable", company: "acme", jobId: "AB12CD34EF" },
      ],
      [
        "acme.recruitee.com/o/senior-engineer",
        { platform: "recruitee", company: "acme", jobId: "senior-engineer" },
      ],
      [
        "jobs.lever.co/acme/abcd1234-ef56-7890-abcd-ef1234567890",
        {
          platform: "lever",
          company: "acme",
          jobId: "abcd1234-ef56-7890-abcd-ef1234567890",
        },
      ],
      [
        "jobs.ashbyhq.com/acme/12345678-90ab-cdef-1234-567890abcdef",
        {
          platform: "ashby",
          company: "acme",
          jobId: "12345678-90ab-cdef-1234-567890abcdef",
        },
      ],
    ])("parses %s with no scheme", (url, expected) => {
      expect(parseAtsUrl(url)).toEqual(expected);
    });

    /**
     * The retry must not widen what the host checks accept.
     *
     * Every case below is #726's threat model re-run through the new code path:
     * each one is a string an attacker would craft to make a hostile host read
     * as an ATS host. They stay `null` because the checks read the PARSED
     * `hostname`, which prefixing `https://` computes rather than assumes —
     * `boards.greenhouse.io@evil.test/…` has hostname `evil.test`, and burying
     * an ATS host in a path, query or fragment never moves it into the host.
     */
    it.each([
      // The four #726 negatives, restated with their scheme (unchanged path)…
      "https://evil-boards.greenhouse.io.attacker.test/acme/jobs/123",
      "https://example.test/redirect?to=boards.greenhouse.io/acme/jobs/123",
      "https://boards.greenhouse.io@evil.test/acme/jobs/123",
      "not a url",
      "",
      // …and each one again with the scheme stripped, which is the new path.
      "evil-boards.greenhouse.io.attacker.test/acme/jobs/123",
      "example.test/redirect?to=boards.greenhouse.io/acme/jobs/123",
      "boards.greenhouse.io@evil.test/acme/jobs/123",
      // Userinfo smuggling on the other platforms too.
      "acme.recruitee.com@evil.test/o/senior-engineer",
      "jobs.lever.co@evil.test/acme/abcd1234-ef56-7890-abcd-ef1234567890",
      // An ATS host as a path segment of a hostile host.
      "evil.test/x/acme.recruitee.com/o/senior-engineer",
      "evil.test/apply.workable.com/acme/j/AB12CD34EF",
      // …and in the query and the fragment.
      "evil.test/go?to=acme.recruitee.com/o/senior-engineer",
      "evil.test#boards.greenhouse.io/acme/jobs/123",
      // A protocol-relative reference to a hostile host.
      "//evil.test/acme/jobs/123",
      // A backslash ends the authority, so the ATS host survives as the host but
      // the smuggled one lands in the path, where no path pattern matches it.
      "boards.greenhouse.io\\@evil.test/acme/jobs/123",
      // Non-http schemes: these parse on the FIRST attempt (so no retry runs)
      // and carry no hostname or are otherwise rejected.
      "javascript:alert(1)",
      "javascript://boards.greenhouse.io/acme/jobs/123",
      "data:text/html,boards.greenhouse.io/acme/jobs/123",
      "file:///acme/jobs/123",
    ])("returns null for %s", (url) => {
      expect(parseAtsUrl(url)).toBeNull();
    });

    // A scheme-relative reference to a REAL board host is the board host — the
    // retry resolves it to exactly the hostname written in it, so accepting it
    // grants nothing a scheme'd paste of the same URL would not.
    it("accepts a protocol-relative reference to a real board host", () => {
      expect(parseAtsUrl("//boards.greenhouse.io/acme/jobs/123")).toEqual({
        platform: "greenhouse",
        company: "acme",
        jobId: "123",
      });
    });
  });
});

describe("classifyUnsupportedHost", () => {
  it.each([
    ["https://www.linkedin.com/jobs/view/1234567890", "linkedin"],
    ["https://linkedin.com/jobs/view/1234", "linkedin"],
    ["https://www.indeed.com/viewjob?jk=abc", "indeed"],
    ["https://www.glassdoor.com/Job/whatever-JV_IC.htm", "glassdoor"],
    ["https://www.glassdoor.co.uk/Job/whatever.htm", "glassdoor"],
    ["https://acme.wd5.myworkdayjobs.com/External/job/X", "workday"],
    ["https://acme.workday.com/jobs/foo", "workday"],
    ["https://wellfound.com/jobs/12345", "wellfound"],
  ])("classifies %s as the known unsupported host", (url, expected) => {
    expect(classifyUnsupportedHost(url)).toBe(expected);
  });

  it("returns null for a Greenhouse URL (those are supported, not unsupported)", () => {
    expect(
      classifyUnsupportedHost("https://boards.greenhouse.io/acmecorp/jobs/123"),
    ).toBeNull();
  });

  it("returns null for an unknown host", () => {
    expect(classifyUnsupportedHost("https://example.com/careers/123")).toBeNull();
  });

  it("classifies a bare host with no scheme via the fallback substring scan", () => {
    expect(classifyUnsupportedHost("linkedin.com/jobs/view/1")).toBe("linkedin");
  });

  it("returns null for an empty string", () => {
    expect(classifyUnsupportedHost("")).toBeNull();
  });
});

describe("fetchJdFromUrl — Ashby", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hits the public job-board API and returns the matched posting as plaintext", async () => {
    const targetId = "12345678-90ab-cdef-1234-567890abcdef";
    const fakeResponse = {
      jobBoard: { name: "Acme Corp" },
      jobPostings: [
        {
          id: "00000000-0000-0000-0000-000000000000",
          title: "Other Role",
          descriptionHtml: "<p>not this one</p>",
        },
        {
          id: targetId,
          title: "Staff Engineer",
          descriptionHtml: "<p>Build distributed systems with Kubernetes.</p>",
        },
      ],
    };
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.ashbyhq.com/posting-api/job-board/acmecorp",
      );
      return new Response(JSON.stringify(fakeResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchJdFromUrl(
      `https://jobs.ashbyhq.com/acmecorp/${targetId}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("ashby");
    expect(result!.title).toBe("Staff Engineer");
    expect(result!.company).toBe("Acme Corp");
    expect(result!.text).toContain("Build distributed systems with Kubernetes.");
    expect(result!.text).not.toMatch(/<[^>]+>/);
  });

  it("throws when the posting id isn't in the board listing (caller routes to network_error)", async () => {
    const fakeResponse = {
      jobBoard: { name: "Acme Corp" },
      jobPostings: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          title: "Unrelated Role",
          descriptionHtml: "<p>nope</p>",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(fakeResponse), { status: 200 }),
      ),
    );

    await expect(
      fetchJdFromUrl(
        "https://jobs.ashbyhq.com/acmecorp/22222222-2222-2222-2222-222222222222",
      ),
    ).rejects.toThrow(/Ashby/);
  });

  it("throws when the API call fails (non-2xx) so the caller can route the network_error funnel", async () => {
    // Distinguishes "URL parsed; fetch failed" (throw) from "URL didn't parse"
    // (null). Without this, a transient ATS-side 500 misroutes through the
    // `result === null` branch and gets tracked as `unsupported_unknown`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );

    await expect(
      fetchJdFromUrl(
        "https://jobs.ashbyhq.com/missingco/12345678-90ab-cdef-1234-567890abcdef",
      ),
    ).rejects.toThrow(/Ashby API 404/);
  });

  it("still returns null when the URL doesn't parse to any ATS (no network call made)", async () => {
    // Contract-pin: `null` means "couldn't identify an ATS"; throws mean "could
    // identify, but the fetch itself failed." Keeps the JdInput routing honest.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchJdFromUrl("https://example.com/careers/123");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
