// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/// <reference types="vitest" />
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

import {
  buildRobotsTxt,
  buildSitemapXml,
  HTML_ENTRIES,
  seoHeadTags,
  SITEMAP_PATHS,
  withNoindexMeta,
} from "./scripts/seo-artifacts.ts";

// Dev-server TLS opt-out. `basicSsl()` below makes `npm run dev` serve HTTPS,
// which is what a LAN client needs for WebGPU (see the plugin's comment) — but
// it also means a plain `http://<host>.local:5173/` from another machine simply
// does not connect: the port speaks TLS and the browser is speaking cleartext.
// The self-signed cert is the other half of the friction — every LAN visitor
// has to click through an interstitial, which is a bad first ten seconds when
// you are demoing to someone.
//
// `OFFLINECV_DEV_HTTP=1 npm run dev` (or `npm run dev:http`) drops the plugin
// so the same URL works over http. The trade-off is real and one-directional:
// over http a non-localhost origin is NOT a secure context, so `navigator.gpu`
// is hidden and every on-device-AI surface degrades to "no-webgpu" — the "AI
// feedback" tab renders its unavailable notice instead of running. Parse,
// score, edit, export, JD-match keyword fallback and job search all work.
// Default stays HTTPS so nobody loses WebGPU by accident.
const DEV_HTTP = process.env.OFFLINECV_DEV_HTTP === "1";

// Token-values swap seam. `src/styles.css` imports the raw `--color-*` values
// via the bare `@design-tokens` specifier; this alias points it at the in-tree
// default (`src/design-system/styles/tokens.css`), so the standalone build is
// unaffected. A downstream productionizer can repoint this alias at their own
// complete tokens file to swap the whole brand without forking — see the README
// "Theming" section. The semantic vocabulary (src/design-system/styles/theme.css)
// is unaffected.
const DESIGN_TOKENS_DEFAULT = fileURLToPath(
  new URL("./src/design-system/styles/tokens.css", import.meta.url),
);

// Component swap seam. Feature code imports primitives + shared-composed
// components via the bare `@design-system` specifier; this alias points it at
// the in-tree barrel (`src/design-system/index.ts`). A downstream productionizer
// repoints this alias (+ tsconfig `paths`) at their own module re-exporting the
// same primitive API to swap the whole component layer without forking — see
// the README "Theming" section.
const DESIGN_SYSTEM_DEFAULT = fileURLToPath(
  new URL("./src/design-system/index.ts", import.meta.url),
);

// Build identity. CI sets GITHUB_SHA (push to main → the deployed commit); a
// local build falls back to `git rev-parse`, and a checkout without git to a
// timestamp. This single value is both baked into the bundle (__APP_VERSION__)
// and written to dist/version.json, so the running tab can compare what it is
// against what is currently deployed (see src/lib/version.ts).
function resolveAppVersion(): string {
  const sha = process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return `t${Date.now()}`;
  }
}

const APP_VERSION = resolveAppVersion();

// Base path. The custom domain (offlinecv.org) and the GCS bucket root both
// serve at "/"; the bare github.io project-Pages fallback
// (offlinecv.github.io/OfflineCV/) needs "/OfflineCV/". Env-driven so
// each deploy target builds with its own prefix without a code edit — set
// VITE_BASE_PATH to override. Default "/" is the custom-domain production
// target and local dev.
const BASE_PATH = process.env.VITE_BASE_PATH ?? "/";

// Non-canonical build marker. The `main` → GitHub Pages deploy at
// dev.offlinecv.org (.github/workflows/deploy-pages.yml) is a byte-identical
// copy of production on a subdomain of the same registrable domain, so a search
// engine sees two complete sites and picks one — which is how production ends
// up dropped. That workflow sets OFFLINECV_SEO_NOINDEX=1; this build then adds
// `<meta name="robots" content="noindex, nofollow">` to every page — bundled
// entries and static pages alike — and ships no sitemap.
//
// Its robots.txt still ALLOWS crawling, deliberately — see buildRobotsTxt in
// scripts/seo-artifacts.ts for why a blocked staging copy is the worse trade.
const SEO_NOINDEX = process.env.OFFLINECV_SEO_NOINDEX === "1";

// Recursively list every .html file under a directory.
function htmlFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFilesUnder(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

// Search-engine directives, generated at build time so the two deploy targets
// differ without a second copy of the URL list checked into public/. Emitting
// rather than shipping public/robots.txt is what makes SEO_NOINDEX possible at
// all: a file in public/ is copied identically into both builds.
//
// Note that `sitemap.xml` and `robots.txt` MUST exist as real assets. The
// Cloudflare Workers assets config used to serve unknown paths as the root
// SPA page, so both URLs answered 200 with HTML — a sitemap that cannot parse
// and a robots.txt with no valid directives in it.
//
// The decisions all three hooks below make live in scripts/seo-artifacts.ts as
// pure functions, because a plugin hook is not reachable from a unit test and
// an inverted flag is silent in both directions.
function emitSeoFiles(): Plugin {
  let outDir = "dist";
  return {
    name: "offlinecv:seo",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    transformIndexHtml() {
      return seoHeadTags(SEO_NOINDEX);
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: buildRobotsTxt(SEO_NOINDEX),
      });
      if (SEO_NOINDEX) return;
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: buildSitemapXml(SITEMAP_PATHS),
      });
    },
    // `transformIndexHtml` only ever sees the bundled entries, so the static
    // pages under public/ would otherwise ship a canonical and nothing else —
    // a hint a crawler may decline, on exactly the staging URLs that carry
    // crawlable prose and can therefore rank against production. By closeBundle
    // the public dir has been copied and outDir is on disk, so one pass over
    // it makes the flag mean one thing across every page.
    closeBundle() {
      if (!SEO_NOINDEX) return;
      for (const file of htmlFilesUnder(outDir)) {
        const tagged = withNoindexMeta(readFileSync(file, "utf8"));
        if (tagged !== null) writeFileSync(file, tagged);
      }
    },
  };
}

// Emit dist/version.json at build time only. Unhashed + at the site root so the
// proactive update checker can poll a stable URL. GitHub Pages forces its own
// short-lived Cache-Control, so the client cache-busts the fetch anyway.
function emitVersionJson(version: string): Plugin {
  return {
    name: "offlinecv:emit-version-json",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ version })}\n`,
      });
    },
  };
}

export default defineConfig({
  base: BASE_PATH,
  // Multi-page app, not SPA. The default 'spa' appType silently falls back to
  // serving the root index.html (the parser) for ANY unmatched path — so
  // `/offlinecv`, or `/jobs` without its trailing slash, would render the
  // parser instead of 404ing. 'mpa' disables that catch-all: `/` → parser,
  // `/jobs/` → job workbench, and anything else 404s honestly. The two entries
  // are real, separate HTML entries — there is no client-side router to fall
  // back for.
  appType: "mpa",
  server: {
    // Bind 0.0.0.0 so the dev server is reachable from other machines on the
    // LAN (e.g. https://<your-host>.local:5173/), not just loopback.
    host: true,
    // Allow LAN mDNS hostnames through Vite's DNS-rebind host check.
    // ".local" matches any *.local host.
    allowedHosts: [".local"],
  },
  plugins: [
    // Serve dev/preview over HTTPS with a throwaway self-signed cert. WebGPU —
    // which WebLLM needs — is gated behind a *secure context*: HTTPS, or the
    // localhost exemption. Over plain http:// a LAN client (e.g.
    // http://<host>.local:5173 from another machine) is NOT a secure context,
    // so navigator.gpu is hidden and the on-device rewrite path silently
    // disables (detectWebGpu → "no-webgpu"). TLS gives every LAN client a
    // secure context; the cert is untrusted, so each client accepts a one-time
    // browser warning — encryption and the secure-context flag hold regardless.
    //
    // Spread, not a ternary returning `false`: Vite tolerates falsy plugin
    // entries, but the array type here is `Plugin[]` and a `false` member
    // fails `tsc -b` in `verify`. See DEV_HTTP at the top of this file for
    // when and why you would want it gone.
    ...(DEV_HTTP ? [] : [basicSsl()]),
    tailwindcss(),
    react(),
    emitVersionJson(APP_VERSION),
    emitSeoFiles(),
  ],
  build: {
    // Two HTML entries: `/` (parser audit, index.html) and `/jobs/` (the
    // job-search workbench, jobs/index.html). The workbench page uses
    // directory-index form (`jobs/index.html`, served at `/jobs/`) rather
    // than a flat `jobs.html` so the extensionless URL resolves identically
    // on Vite dev, the GCS bucket, and GitHub Pages — a flat `jobs.html` only
    // clean-URLs on Pages, 404ing the canonical `/jobs/` path elsewhere.
    // Declaring `input` explicitly means the build ships exactly these two
    // pages — the dev-only `jd-spike.html` / `eval-rewrite.html`
    // harnesses (which Vite's default auto-discovery would otherwise bundle) are
    // no longer emitted into dist/, which is the intended production surface.
    //
    // Derived from HTML_ENTRIES rather than spelled out here so the entry set
    // and the sitemap cannot drift: a third entry is advertised for indexing
    // by construction instead of by someone remembering a second list.
    rollupOptions: {
      input: Object.fromEntries(
        Object.entries(HTML_ENTRIES).map(([name, { file }]) => [
          name,
          fileURLToPath(new URL(`./${file}`, import.meta.url)),
        ]),
      ),
    },
  },
  resolve: {
    alias: {
      "@design-tokens": DESIGN_TOKENS_DEFAULT,
      "@design-system": DESIGN_SYSTEM_DEFAULT,
    },
  },
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  test: {
    environment: "node",
    // `scripts/**` carries the build-time gates (e.g. the fixture-PII check,
    // #478). They are plain Node ESM — deliberately not part of the app's TS
    // build, so a CI gate can never be broken by the app's compile — but their
    // rules still need unit tests, so the suite has to reach them here.
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.mjs",
    ],
    globals: true,
    // Raised off vitest's 5000 ms default (#762), because 5s is below what these
    // tests HONESTLY COST — not because something is hanging.
    //
    // Measured on the 24 heaviest files: 453s of test CPU, 78s wall. One
    // `extractFromPdfBytes` over a fixture is 212ms and one `runCascade` is
    // 257ms (so ~82% of a parse is pdfjs), and a render is ~500ms. A round-trip
    // `it` in `corpus-roundtrip` / `corpus-edit-roundtrip` does parse → render →
    // re-parse on a REAL fixture, several times over, which lands at 6–8s of
    // genuine work before any load. Under 5s, three of them failed at 7282ms and
    // 6661ms; at 20s all 24 files pass. Nothing was rescued from a hang — the
    // ceiling was simply under the floor.
    //
    // And the floor moves. These timings were taken on a developer laptop that
    // was also running a video call and several other node processes; the same
    // probe came back 43s and 126s on different attempts, and a single warm
    // extraction loop varies ~19% run to run. A local gate has to survive the
    // machine it actually runs on, which is never idle — so the ceiling is set
    // well above the worst observed run, not just above the median one.
    //
    // Do not "fix" this by tuning the worker count or the pool kind. Both were
    // measured and are WORSE: `--maxWorkers=4` takes 155s against 78s (identical
    // test CPU — the default fork pool is already at ~5.8x parallelism, so it is
    // not oversubscribed), and `--pool=threads` takes 347s against 99s on the
    // rest of the suite while failing 8 files.
    //
    // `poolOptions.forks.isolate=false` is much faster and is still not used.
    // The full suite finishes in ~25s under it against ~95s isolated. An earlier
    // note in this file recorded it as "never finished inside 600s"; that reading
    // was taken while nine orphaned vitest workers pinned the machine at load
    // average 110, and it was wrong — as was the 78s/98s pair that replaced it.
    //
    // The reason it stays off is not speed. vitest resets the module-mock
    // registry and the module cache once per file, and BOTH resets are gated on
    // `isolate` (`runBaseTests`: `if (isolate) { executor.mocker.reset();
    // resetModules(...) }`). So `vi.mock` is file-scoped *because of* that reset,
    // not on its own — turning the flag off does not expose leaked state, it
    // deletes the mechanism that makes file-scoped module mocks work. The
    // failures it produces are all in the 21 of 346 files that call `vi.mock`,
    // are all "the mock did not apply", and vary run to run with fork
    // scheduling. See #830 (closed, not planned) for the full trace.
    //
    // The per-fixture half of the cost is handled rather than tracked: Tier 0
    // extraction is now served from a disk cache shared across forks (#829, see
    // the `alias` block below), which is worth ~40% of the wall on the six
    // corpus suites and ~4% on a full run.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Install the in-memory localStorage shim before every test, workload-wide,
    // so no suite has to remember to import it (#398). See src/test-setup.ts.
    setupFiles: ["src/test-setup.ts"],
    coverage: {
      // v8 provider; emit lcov so `fallow audit --coverage` can compute
      // accurate CRAP scores in CI. Without coverage, CRAP collapses to a
      // cyclomatic-only proxy that flags even simple, well-tested functions.
      provider: "v8",
      // `json` emits coverage/coverage-final.json (Istanbul format), which
      // `fallow audit --coverage` consumes for accurate per-function CRAP.
      reporter: ["text-summary", "json"],
      reportsDirectory: "coverage",
      // The tested build-time gates under `scripts/` are listed individually, not
      // globbed. They must be here at all because fallow scores every changed
      // file it sees, and a file the coverage report never mentions is scored as
      // 0% covered — which multiplies its CRAP by the full cyclomatic penalty, so
      // a tested gate left out of `include` reads as untested rather than as
      // out-of-scope. But a `scripts/**/*.mjs` glob also sweeps in the one-shot
      // scripts no test ever loads (the fixture generators, the hook installer),
      // and v8 emits bogus source-map columns for those — the same negative
      // `end.column` that the `main.tsx` exclude below exists to dodge, which
      // crashes `fallow audit`'s u32 coverage parser and silently zeroes the
      // whole report. Enumerating inverts that failure mode: forget to add a new
      // tested gate here and fallow merely scores it 0% and complains, loudly.
      include: [
        "src/**/*.{ts,tsx}",
        "scripts/check-fixture-pii.mjs",
        "scripts/check-known-failures.mjs",
        "scripts/select-tests.mjs",
        "scripts/seo-artifacts.ts",
      ],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__test-utils__/**",
        "src/**/*.d.ts",
        // App entry points (root + per-surface, e.g. src/jobs/main.tsx). These
        // are untested boot shims, and v8 instrumentation has emitted bogus
        // source-map columns for them (negative `end.column`) that crash
        // `fallow audit`'s u32 coverage parser, silently zeroing the whole
        // fallow report. The glob excludes every `main.tsx` so the gate stays live.
        "src/**/main.tsx",
      ],
    },
    // Test-only module redirects.
    alias: {
      // Redirect the ONE specifier `cascade.ts` dynamic-imports for Tier 0 to a
      // caching stand-in (#829). Six suites re-parse the same 58 fixtures in
      // separate forks, and extraction — ~82% of a parse — is a pure function
      // of the bytes, so it is shareable through a disk cache. Doing it at
      // resolve time keeps the wrapper out of the production bundle entirely
      // and leaves all six suites calling `runCascade(bytes)` unchanged.
      //
      // Vite matches a string `find` as a prefix of the raw specifier, so this
      // hits `cascade.ts`'s `"./pdf-extract.ts"` and NOT the stand-in's own
      // `"../pdf-extract.ts"` — that difference is what stops the redirect
      // looping back on itself. Keep the two specifiers distinct.
      "./pdf-extract.ts": fileURLToPath(
        new URL(
          "./src/lib/heuristics/__test-utils__/extract-cache.ts",
          import.meta.url,
        ),
      ),
      // Force pdfjs-dist to its legacy build during tests so the Node 20+
      // env doesn't trip on `Promise.withResolvers()` (Node 22+) in the
      // browser entry. The production bundle still ships the browser build.
      "pdfjs-dist": "pdfjs-dist/legacy/build/pdf.mjs",
      "@design-system": DESIGN_SYSTEM_DEFAULT,
    },
  },
});
