// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseAtsUrl,
  htmlToPlaintext,
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
});

describe("htmlToPlaintext", () => {
  it("strips tags and decodes entities", () => {
    const html = "<p>Hello&amp;</p><ul><li>A</li><li>B</li></ul>";
    const text = htmlToPlaintext(html);
    expect(text).toContain("Hello&");
    expect(text).toContain("A");
    expect(text).toContain("B");
    expect(text).not.toMatch(/<[^>]+>/);
  });

  it("removes <style> and <script> blocks", () => {
    const html =
      "<style>body{color:red}</style><p>Content</p><script>alert(1)</script>";
    const text = htmlToPlaintext(html);
    expect(text).toContain("Content");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("alert");
  });

  it("converts <br> and block-end tags to newlines", () => {
    const html = "<p>First</p><p>Second</p><br/><p>Third</p>";
    const text = htmlToPlaintext(html);
    expect(text).toContain("First");
    expect(text).toContain("Second");
    expect(text).toContain("Third");
    // No consecutive runs of 3+ newlines
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("decodes &lt; &gt; &quot; &#39; &nbsp;", () => {
    const html = "<p>&lt;tag&gt; &quot;quoted&quot; it&#39;s&nbsp;fine</p>";
    const text = htmlToPlaintext(html);
    expect(text).toContain("<tag>");
    expect(text).toContain('"quoted"');
    expect(text).toContain("it's");
    expect(text).toContain("fine");
  });

  it("trims and collapses excess newlines", () => {
    const html = "<p>A</p>\n\n\n\n<p>B</p>";
    const text = htmlToPlaintext(html);
    expect(text.startsWith("A")).toBe(true);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("decodes decimal numeric entities (&#160;)", () => {
    // &#160; is the decimal nbsp; should become a space, not leak as `&#160;`.
    const text = htmlToPlaintext("<p>Use&nbsp;Kubernetes&#160;daily.</p>");
    expect(text).toBe("Use Kubernetes daily.");
    expect(text).not.toContain("&#");
  });

  it("decodes hex numeric entities (&#x2013;)", () => {
    // &#x2013; is an en-dash (–), common in Lever-generated typographic ranges.
    const text = htmlToPlaintext("<p>2020&#x2013;2024</p>");
    expect(text).toContain("2020–2024");
    expect(text).not.toContain("&#");
  });

  it("decodes a decimal curly apostrophe (&#8217;) so skills regex sees the word", () => {
    const text = htmlToPlaintext("<p>you&#8217;ll ship</p>");
    expect(text).toContain("you’ll ship");
    expect(text).not.toContain("&#");
  });

  it("leaves a malformed numeric reference (&#x;) unchanged", () => {
    const text = htmlToPlaintext("<p>price &#x; range</p>");
    expect(text).toContain("&#x;");
  });

  it("leaves an out-of-range numeric reference unchanged", () => {
    // 0x110000 is one past the highest Unicode scalar — must not throw.
    const text = htmlToPlaintext("<p>bad &#1114112; ref</p>");
    expect(text).toContain("&#1114112;");
  });

  it("drops non-whitespace control-character references (&#0;, &#7;)", () => {
    // Null and BEL would inject invisible bytes into the matched plaintext;
    // they are stripped, not decoded and not left as raw `&#…;`.
    const text = htmlToPlaintext("<p>a&#0;b&#7;c</p>");
    expect(text).toBe("abc");
    expect(text).not.toContain("&#");
  });

  it("decodes whitespace control references (&#13;/&#10;) without leaking", () => {
    // CR/LF are legitimate whitespace — decoded then normalized by the
    // line-collapse pass, never left as a raw `&#13;` fragment.
    const text = htmlToPlaintext("<p>line1&#13;&#10;line2</p>");
    expect(text).not.toContain("&#");
    expect(text).toContain("line1");
    expect(text).toContain("line2");
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
