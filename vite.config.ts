// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/// <reference types="vitest" />
import { execSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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
  base: "/resumelint/",
  plugins: [react(), emitVersionJson(APP_VERSION)],
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: true,
    // Force pdfjs-dist to its legacy build during tests so the Node 20+
    // env doesn't trip on `Promise.withResolvers()` (Node 22+) in the
    // browser entry. The production bundle still ships the browser build.
    alias: {
      "pdfjs-dist": "pdfjs-dist/legacy/build/pdf.mjs",
    },
  },
});
