// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/// <reference types="vitest" />
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

import { cloudflare } from "@cloudflare/vite-plugin";

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

// Base path. The custom domain (resumelint.org) and the GCS bucket root both
// serve at "/"; the bare github.io project-Pages fallback
// (offlinecv.github.io/OfflineCV/) needs "/OfflineCV/". Env-driven so
// each deploy target builds with its own prefix without a code edit — set
// VITE_BASE_PATH to override. Default "/" is the custom-domain production
// target and local dev.
const BASE_PATH = process.env.VITE_BASE_PATH ?? "/";

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

// Redirect the bare `/jd-fit` to the canonical `/jd-fit/` in dev and preview.
// The page is served as a directory index (`jd-fit/index.html` at `/jd-fit/`);
// static hosts that auto-redirect no-slash directory paths (GitHub Pages) make
// `/jd-fit` work in production, but Vite's dev/preview servers do not — without
// this they 404 the slash-less form. This middleware mirrors the Pages behavior
// so local and production accept both `/jd-fit` and `/jd-fit/`. Base-aware:
// only the canonical leaf is redirected; everything else falls through.
function jdFitTrailingSlash(): Plugin {
  const bare = `${BASE_PATH}jd-fit`; // BASE_PATH always ends in "/", e.g. "/jd-fit"
  const target = `${bare}/`;
  const redirect = (
    req: { url?: string },
    res: { statusCode: number; setHeader: (k: string, v: string) => void; end: () => void },
    next: () => void,
  ) => {
    const [path, query] = (req.url ?? "").split("?");
    if (path === bare) {
      res.statusCode = 301;
      res.setHeader("Location", query ? `${target}?${query}` : target);
      res.end();
      return;
    }
    next();
  };
  return {
    name: "offlinecv:jd-fit-trailing-slash",
    configureServer(server) {
      server.middlewares.use(redirect);
    },
    configurePreviewServer(server) {
      server.middlewares.use(redirect);
    },
  };
}

export default defineConfig({
  base: BASE_PATH,
  // Multi-page app, not SPA. The default 'spa' appType silently falls back to
  // serving the root index.html (the parser) for ANY unmatched path — so
  // `/offlinecv`, or `/jd-fit` without its trailing slash, would render the
  // parser instead of 404ing. 'mpa' disables that catch-all: `/` → parser,
  // `/jd-fit/` → JD fit, and anything else 404s honestly. The two products are
  // real, separate HTML entries — there is no client-side router to fall back
  // for.
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
    basicSsl(),
    tailwindcss(),
    react(),
    emitVersionJson(APP_VERSION),
    jdFitTrailingSlash(),
    cloudflare()
  ],
  build: {
    // Two HTML entries (#226): `/` (parser audit, index.html) and `/jd-fit/`
    // (JD match + JD-driven rewrite, jd-fit/index.html). The JD-fit page uses
    // directory-index form (`jd-fit/index.html`, served at `/jd-fit/`) rather
    // than a flat `jd-fit.html` so the extensionless URL resolves identically
    // on Vite dev, the GCS bucket, and GitHub Pages — a flat `jd-fit.html` only
    // clean-URLs on Pages, 404ing the canonical `/jd-fit/` path elsewhere.
    // Declaring `input` explicitly means the build ships exactly these two
    // pages — the dev-only `jd-spike.html` / `eval-rewrite.html`
    // harnesses (which Vite's default auto-discovery would otherwise bundle) are
    // no longer emitted into dist/, which is the intended production surface.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        jdFit: fileURLToPath(new URL("./jd-fit/index.html", import.meta.url)),
      },
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
      include: ["src/**/*.{ts,tsx}", "scripts/check-fixture-pii.mjs"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__test-utils__/**",
        "src/**/*.d.ts",
        // App entry points (root + per-surface, e.g. src/jd-fit/main.tsx). These
        // are untested boot shims, and v8 instrumentation has emitted bogus
        // source-map columns for them (negative `end.column`) that crash
        // `fallow audit`'s u32 coverage parser, silently zeroing the whole
        // fallow report. The glob excludes every `main.tsx` so the gate stays live.
        "src/**/main.tsx",
      ],
    },
    // Force pdfjs-dist to its legacy build during tests so the Node 20+
    // env doesn't trip on `Promise.withResolvers()` (Node 22+) in the
    // browser entry. The production bundle still ships the browser build.
    alias: {
      "pdfjs-dist": "pdfjs-dist/legacy/build/pdf.mjs",
      "@design-system": DESIGN_SYSTEM_DEFAULT,
    },
  },
});