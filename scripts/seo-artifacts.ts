// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Search-engine artifacts — the decisions behind robots.txt, sitemap.xml and
 * the staging `noindex` meta, lifted out of `vite.config.ts` so they can be
 * unit-tested.
 *
 * They live here rather than inline in the config because their failure mode is
 * silent in both directions: a build that inverts the flag ships `noindex` on
 * every page and no sitemap, and the build still succeeds and the site still
 * works — you find out from Search Console weeks later. The reverse (staging
 * losing its `noindex`) is equally quiet and re-creates the duplicate-site
 * defect the flag exists to prevent. Nothing in the app surfaces either, so the
 * only thing that can catch an inversion is an assertion on the strings
 * themselves.
 *
 * Everything exported here is pure — string in, string out, no fs, no Vite —
 * except that `HTML_ENTRIES` is also the single source of the build's
 * `rollupOptions.input`, so an entry cannot be added to the build without
 * appearing in the sitemap. See `scripts/seo-artifacts.test.mjs`.
 */

/**
 * Canonical origin. Every indexable URL is advertised under this host — both in
 * the sitemap and in the hardcoded `<link rel="canonical">` each HTML entry
 * carries. Hardcoded rather than base-derived on purpose: the point of a
 * canonical is to name ONE address for a page, and the staging build serves
 * byte-identical HTML from a different host.
 */
export const SITE_ORIGIN = "https://offlinecv.org";

/**
 * The app's HTML entries, keyed by rollup input name. `file` is repo-relative;
 * `url` is the canonical trailing-slash path it is served at.
 *
 * `vite.config.ts` derives `build.rollupOptions.input` from this map and
 * `SITEMAP_PATHS` below derives from it too, so the two can no longer drift: a
 * fourth entry added to the build is advertised in the sitemap by construction,
 * rather than by someone remembering a second list. That omission is the kind
 * nobody notices — the URL is not blocked from indexing, just never advertised,
 * so it simply stays unindexed.
 */
export const HTML_ENTRIES = {
  main: { file: "index.html", url: "/" },
  jdFit: { file: "jd-fit/index.html", url: "/jd-fit/" },
  jobs: { file: "jobs/index.html", url: "/jobs/" },
} as const;

/**
 * The static content pages under `public/`. These are copied through verbatim
 * rather than bundled, so they are not derivable from the build config the way
 * `HTML_ENTRIES` is — this list is hand-kept, and the test asserts it against
 * the directories actually present under `public/`.
 */
export const STATIC_PAGE_PATHS = [
  "/how-it-works/",
  "/faq/",
  "/privacy/",
  "/open-source/",
] as const;

/** The indexable URL set, in canonical trailing-slash form. */
export const SITEMAP_PATHS: readonly string[] = [
  ...Object.values(HTML_ENTRIES).map((entry) => entry.url),
  ...STATIC_PAGE_PATHS,
];

/**
 * robots.txt. Crawling stays ALLOWED even on the noindex build, deliberately:
 * `Disallow: /` stops the crawler fetching the page at all, and a URL that is
 * *already* in the index can only be dropped by a directive the crawler is
 * permitted to read — a blocked staging copy would linger indefinitely. Crawl
 * budget on a host nothing links to is not worth trading that for. What the
 * flag removes is the `Sitemap:` line, so staging advertises nothing.
 */
export function buildRobotsTxt(noindex: boolean): string {
  const lines = ["User-agent: *", "Allow: /", ""];
  if (!noindex) lines.push(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`, "");
  return lines.join("\n");
}

/**
 * sitemap.xml. No `<lastmod>`: it is only honoured when consistently accurate,
 * and the only value available at build time is the build timestamp, which
 * changes on every redeploy whether or not the page did.
 */
export function buildSitemapXml(paths: readonly string[]): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...paths.map((path) => `  <url><loc>${SITE_ORIGIN}${path}</loc></url>`),
    `</urlset>`,
    "",
  ].join("\n");
}

/** The staging robots directive, as the literal tag injected into static HTML. */
export const NOINDEX_META = `<meta name="robots" content="noindex, nofollow" />`;

/**
 * Head tags for the bundled HTML entries. Empty on a production build — the
 * absence of a robots meta is what "index me" looks like.
 */
export function seoHeadTags(noindex: boolean): {
  tag: string;
  attrs: Record<string, string>;
  injectTo: "head-prepend";
}[] {
  if (!noindex) return [];
  return [
    {
      tag: "meta",
      attrs: { name: "robots", content: "noindex, nofollow" },
      injectTo: "head-prepend",
    },
  ];
}

/**
 * Inject the staging robots directive into a static page's HTML.
 *
 * The bundled entries get theirs through `transformIndexHtml`, which never sees
 * the pages under `public/` — Vite copies those through verbatim. Without this
 * the flag would mean two different things on one deploy: a hard directive on
 * the three entries that have nothing to index anyway (empty `#root`), and a
 * canonical — a hint a search engine may decline — on the four content pages
 * that carry the actual crawlable prose. Those are the staging URLs most able to
 * rank against production, which is the whole defect.
 *
 * Returns `null` when the file already carries a robots meta (404.html ships its
 * own `noindex`) or has no `<head>` to inject into, so the caller can skip the
 * write rather than double-tagging.
 */
export function withNoindexMeta(html: string): string | null {
  // `<meta\b[^>]*\bname=` and not `<meta\s+name=`: HTML attribute order carries no
  // meaning, so a hand-written `<meta content="…" name="robots">` is the same
  // directive. Anchoring on position would let that page through and double-tag it.
  if (/<meta\b[^>]*\bname=["']robots["']/i.test(html)) return null;
  const head = html.match(/<head[^>]*>/i);
  if (!head) return null;
  const at = html.indexOf(head[0]) + head[0].length;
  return `${html.slice(0, at)}\n    ${NOINDEX_META}${html.slice(at)}`;
}
