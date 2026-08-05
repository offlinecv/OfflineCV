// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Both directions matter here. The flag's failure mode is silent either way: a
// production build that inverts it ships `noindex` everywhere and no sitemap and
// still succeeds, and a staging build that loses its `noindex` re-creates the
// duplicate-site defect. Neither shows up in the app, so asserting only the
// happy direction would leave the expensive half uncovered.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildRobotsTxt,
  buildSitemapXml,
  HTML_ENTRIES,
  NOINDEX_META,
  seoHeadTags,
  SITE_ORIGIN,
  SITEMAP_PATHS,
  STATIC_PAGE_PATHS,
  withNoindexMeta,
} from "./seo-artifacts.ts";

describe("buildRobotsTxt", () => {
  it("advertises the sitemap on a production build", () => {
    expect(buildRobotsTxt(false)).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });

  it("advertises no sitemap on a noindex build", () => {
    expect(buildRobotsTxt(true)).not.toContain("Sitemap:");
  });

  it("allows crawling in both builds", () => {
    // Deliberate: a `Disallow: /` staging copy could never be dropped from the
    // index, because the crawler would not be permitted to read the directive
    // that drops it.
    for (const robots of [buildRobotsTxt(false), buildRobotsTxt(true)]) {
      expect(robots).toContain("User-agent: *");
      expect(robots).toContain("Allow: /");
      expect(robots).not.toContain("Disallow:");
    }
  });
});

describe("buildSitemapXml", () => {
  it("emits one absolute <loc> per path", () => {
    const xml = buildSitemapXml(["/", "/faq/"]);
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/</loc>`);
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/faq/</loc>`);
    expect(xml.match(/<loc>/g)).toHaveLength(2);
  });

  it("declares the sitemap namespace and closes the urlset", () => {
    const xml = buildSitemapXml(SITEMAP_PATHS);
    expect(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`)).toBe(true);
    expect(xml).toContain(`xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`);
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("carries no <lastmod>", () => {
    // Only honoured when consistently accurate; the build timestamp changes on
    // every redeploy whether or not the page did.
    expect(buildSitemapXml(SITEMAP_PATHS)).not.toContain("<lastmod>");
  });
});

describe("seoHeadTags", () => {
  it("injects nothing on a production build", () => {
    expect(seoHeadTags(false)).toEqual([]);
  });

  it("injects noindex, nofollow on a noindex build", () => {
    expect(seoHeadTags(true)).toEqual([
      {
        tag: "meta",
        attrs: { name: "robots", content: "noindex, nofollow" },
        injectTo: "head-prepend",
      },
    ]);
  });
});

describe("withNoindexMeta", () => {
  it("injects the directive into a static page's head", () => {
    const out = withNoindexMeta("<html><head><title>x</title></head><body></body></html>");
    expect(out).toContain(NOINDEX_META);
    expect(out.indexOf(NOINDEX_META)).toBeLessThan(out.indexOf("<title>"));
  });

  it("skips a page that already declares a robots directive", () => {
    // 404.html ships its own `noindex`; the bundled entries get theirs from
    // transformIndexHtml before this pass runs. Neither should be double-tagged.
    expect(
      withNoindexMeta(`<html><head><meta name="robots" content="noindex" /></head></html>`),
    ).toBeNull();
  });

  it("skips a robots directive whose name is not the first attribute", () => {
    // Attribute order carries no meaning in HTML, so the skip must not depend on
    // it — a hand-edit to `content` first would otherwise ship two robots metas.
    expect(
      withNoindexMeta(`<html><head><meta content="noindex" name="robots" /></head></html>`),
    ).toBeNull();
  });

  it("skips a file with no head to inject into", () => {
    expect(withNoindexMeta("<p>fragment</p>")).toBeNull();
  });
});

describe("SITEMAP_PATHS", () => {
  it("advertises every HTML entry the build ships", () => {
    for (const { url } of Object.values(HTML_ENTRIES)) {
      expect(SITEMAP_PATHS).toContain(url);
    }
  });

  it("advertises every static page directory under public/", () => {
    // The one list that is hand-kept — public/ pages are copied through, not
    // declared to the bundler, so nothing else can derive them. A page added
    // here and forgotten is not blocked from indexing, just never advertised,
    // so it silently stays unindexed.
    // The `index.html` predicate is what keeps this honest: without it the first
    // asset directory (`public/images/` for an og:image) fails the test with a
    // message that reads "you forgot to list /images/", and the obvious way to
    // green it advertises a directory with no page in sitemap.xml. A test whose
    // failure points at the wrong fix is worse than one that doesn't fire.
    const publicDir = fileURLToPath(new URL("../public", import.meta.url));
    const onDisk = readdirSync(publicDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(publicDir, entry.name, "index.html")))
      .map((entry) => `/${entry.name}/`);
    expect([...STATIC_PAGE_PATHS].sort()).toEqual(onDisk.sort());
  });

  it("lists no path twice", () => {
    expect(new Set(SITEMAP_PATHS).size).toBe(SITEMAP_PATHS.length);
  });

  it("uses canonical trailing-slash form throughout", () => {
    for (const path of SITEMAP_PATHS) {
      expect(path.startsWith("/")).toBe(true);
      expect(path.endsWith("/")).toBe(true);
    }
  });
});
