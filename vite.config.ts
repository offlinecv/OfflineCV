// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/// <reference types="vitest" />
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

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
// (resumelint-org.github.io/resumelint/) needs "/resumelint/". Env-driven so
// each deploy target builds with its own prefix without a code edit — set
// VITE_BASE_PATH to override. Default "/" is the custom-domain production
// target and local dev.
const BASE_PATH = process.env.VITE_BASE_PATH ?? "/";

// Emit dist/version.json at build time only. Unhashed + at the site root so the
// proactive update checker can poll a stable URL. GitHub Pages forces its own
// short-lived Cache-Control, so the client cache-busts the fetch anyway.
function emitVersionJson(version: string): Plugin {
  return {
    name: "resumelint:emit-version-json",
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
  server: {
    // Bind 0.0.0.0 so the dev server is reachable from other machines on the
    // LAN (e.g. http://<your-host>.local:5173/), not just loopback.
    host: true,
    // Allow LAN mDNS hostnames through Vite's DNS-rebind host check.
    // ".local" matches any *.local host.
    allowedHosts: [".local"],
  },
  plugins: [tailwindcss(), react(), emitVersionJson(APP_VERSION)],
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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: true,
    coverage: {
      // v8 provider; emit lcov so `fallow audit --coverage` can compute
      // accurate CRAP scores in CI. Without coverage, CRAP collapses to a
      // cyclomatic-only proxy that flags even simple, well-tested functions.
      provider: "v8",
      // `json` emits coverage/coverage-final.json (Istanbul format), which
      // `fallow audit --coverage` consumes for accurate per-function CRAP.
      reporter: ["text-summary", "json"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__test-utils__/**",
        "src/**/*.d.ts",
        "src/main.tsx",
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
