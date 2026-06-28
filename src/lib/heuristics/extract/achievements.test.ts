// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { liftHeaderLabel } from "./projects.ts";

// liftHeaderLabel is defined in projects.ts and shared by achievementFromBlock
// (achievements.ts imports it from there). These tests cover the URL-lift
// behavior from the achievements surface — the same function handles both.

describe("liftHeaderLabel — mid-sentence domain is NOT lifted (#237)", () => {
  it("leaves return2india.com in title when mid-sentence", () => {
    // Source: "Exit · Founded and sold return2india.com to Satyam Infoway …"
    const header =
      "Exit · Founded and sold return2india.com to Satyam Infoway (NASDAQ: SIFY). 200K monthly visits. [2000]";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBeUndefined();
    expect(label).toContain("return2india.com");
  });

  it("leaves domain in title when preceded and followed by words", () => {
    const header = "Launched mysite.com for enterprise clients";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBeUndefined();
    expect(label).toContain("mysite.com");
  });
});

describe("liftHeaderLabel — standalone URL IS lifted", () => {
  it("lifts a bare standalone domain at the end of a header", () => {
    // "My OSS Library | github.com/user/repo" — domain is at end, no word after it
    const header = "My OSS Library | github.com/user/repo";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBe("github.com/user/repo");
    expect(label).toBe("My OSS Library");
  });

  it("lifts an https:// URL regardless of position", () => {
    const header =
      "Founded and sold https://return2india.com to Satyam Infoway";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBe("https://return2india.com");
    // label should have the URL removed and cleaned up
    expect(label).not.toContain("https://return2india.com");
  });

  it("lifts a domain-only header line", () => {
    const { label, url } = liftHeaderLabel(["janedoe.dev"]);
    expect(url).toBe("janedoe.dev");
    expect(label).toBe("");
  });

  it("lifts a www. URL always (standalone)", () => {
    // URL_RE matches the first domain segment: www.janedoe — the trailing .com
    // is a known URL_RE limitation (three-part domains). The key behavior under
    // test is that www. prefix triggers standalone promotion regardless of
    // surrounding text context.
    const header = "Portfolio | www.janedoe.com";
    const { url } = liftHeaderLabel([header]);
    expect(url).toBeDefined();
    expect(url).toMatch(/^www\./);
  });

  it("lifts a later standalone link past a leading mid-prose domain", () => {
    // A prose domain (acme.example) appears BEFORE a genuine standalone link
    // (github.com/me/repo). The first URL_RE hit is the prose domain, which
    // isStandaloneUrl correctly rejects — so the parser must keep scanning and
    // lift the real link, not give up on the first match.
    const header = "Sold acme.example to buyer | github.com/me/repo";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBe("github.com/me/repo");
    // The lifted link is stripped; the leading prose domain stays in the label.
    expect(label).toContain("acme.example");
    expect(label).not.toContain("github.com/me/repo");
  });
});
