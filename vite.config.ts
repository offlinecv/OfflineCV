// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/resumelint/",
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: true,
  },
});
