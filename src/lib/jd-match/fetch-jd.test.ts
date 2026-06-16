// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { parseAtsUrl, htmlToPlaintext } from "./fetch-jd.ts";

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
