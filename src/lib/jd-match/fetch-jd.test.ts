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
});
