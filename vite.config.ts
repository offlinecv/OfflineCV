// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/resumelint/",
  plugins: [react()],
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
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
