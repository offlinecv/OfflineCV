// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";
import { normalizeUrl, urlSlug } from "./url-utils.ts";

describe("normalizeUrl", () => {
  it("returns undefined for empty input", () => {
    expect(normalizeUrl(undefined)).toBeUndefined();
    expect(normalizeUrl("")).toBeUndefined();
  });

  it("adds an https:// scheme to a bare host", () => {
    expect(normalizeUrl("linkedin.com/in/jane")).toBe(
      "https://linkedin.com/in/jane",
    );
  });

  it("preserves an existing http/https scheme", () => {
    expect(normalizeUrl("http://jane.dev/portfolio")).toBe(
      "http://jane.dev/portfolio",
    );
  });

  it("strips a trailing sentence punctuation mark", () => {
    expect(normalizeUrl("github.com/jane.")).toBe("https://github.com/jane");
  });

  it("canonicalizes a leading www. away (#425)", () => {
    expect(normalizeUrl("https://www.linkedin.com/in/jane")).toBe(
      "https://linkedin.com/in/jane",
    );
    expect(normalizeUrl("www.jane.dev")).toBe("https://jane.dev");
    expect(normalizeUrl("http://www.jane.dev")).toBe("http://jane.dev");
  });

  it("is symmetric: a www.-bearing source and its www-less display converge (#425)", () => {
    // The exporter shows `formatLinkDisplay`'s www-less slug; the parser re-adds
    // https:// but not www. Canonicalizing www away on BOTH sides is what keeps
    // the linkedin_url round-trip stable.
    const source = "https://www.linkedin.com/in/jane";
    const exportedDisplay = "linkedin.com/in/jane"; // formatLinkDisplay output
    expect(normalizeUrl(source)).toBe(normalizeUrl(exportedDisplay));
  });
});

describe("urlSlug", () => {
  it("reduces www / scheme / trailing-slash variants to one identity", () => {
    const slug = "github.com/jane";
    expect(urlSlug("https://github.com/jane")).toBe(slug);
    expect(urlSlug("https://www.github.com/jane/")).toBe(slug);
    expect(urlSlug("github.com/jane")).toBe(slug);
  });
});
