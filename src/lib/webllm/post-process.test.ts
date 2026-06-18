// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";

import { cleanRewriteLine } from "./post-process.ts";

describe("cleanRewriteLine", () => {
  it("returns empty for whitespace-only input", () => {
    expect(cleanRewriteLine("")).toBe("");
    expect(cleanRewriteLine("   ")).toBe("");
    expect(cleanRewriteLine("\t\n")).toBe("");
  });

  it("strips the `Rewritten:` echo (case-insensitive)", () => {
    expect(cleanRewriteLine("Rewritten: Shipped Foo.")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("rewritten: Shipped Foo.")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("REWRITTEN:    Shipped Foo.")).toBe("Shipped Foo.");
  });

  it("strips numbered list markers — `1.`, `1)`, `12.`", () => {
    expect(cleanRewriteLine("1. Shipped Foo.")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("1) Shipped Foo.")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("12. Shipped Foo.")).toBe("Shipped Foo.");
  });

  it("strips bullet markers — `•`, `-`, `*` — with or without trailing space", () => {
    expect(cleanRewriteLine("• Shipped Foo.")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("- Shipped Foo.")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("* Shipped Foo.")).toBe("Shipped Foo.");
    // No-space variants — the model occasionally tightens "- Shipped" to
    // "-Shipped"; should still normalize.
    expect(cleanRewriteLine("-Shipped Foo.")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("•Shipped Foo.")).toBe("Shipped Foo.");
  });

  it("strips straight quotes around the whole line", () => {
    expect(cleanRewriteLine('"Shipped Foo."')).toBe("Shipped Foo.");
    expect(cleanRewriteLine("'Shipped Foo.'")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("`Shipped Foo.`")).toBe("Shipped Foo.");
  });

  it("strips smart double and single quotes around the whole line", () => {
    expect(cleanRewriteLine("“Shipped Foo.”")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("‘Shipped Foo.’")).toBe("Shipped Foo.");
  });

  it("strips full-line markdown emphasis — bold, italic, underscore-italic", () => {
    expect(cleanRewriteLine("**Shipped Foo.**")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("*Shipped Foo.*")).toBe("Shipped Foo.");
    expect(cleanRewriteLine("_Shipped Foo._")).toBe("Shipped Foo.");
  });

  it("does NOT strip emphasis mid-line — only paired wrapping the whole line", () => {
    expect(cleanRewriteLine("Shipped **Foo** to 10M users.")).toBe(
      "Shipped **Foo** to 10M users.",
    );
  });

  it("composes prefix + bullet + quote stripping in one pass", () => {
    expect(cleanRewriteLine('Rewritten: 1. "Shipped Foo."')).toBe(
      "Shipped Foo.",
    );
    expect(cleanRewriteLine('- "Shipped Foo."')).toBe("Shipped Foo.");
  });

  it("drops prompt-echo lines (`Rules:`, `Original bullets:`, `Rewritten bullets:`)", () => {
    expect(cleanRewriteLine("Rules:")).toBe("");
    expect(cleanRewriteLine("Original bullets:")).toBe("");
    expect(cleanRewriteLine("Rewritten bullets:")).toBe("");
    expect(cleanRewriteLine("RULES:")).toBe("");
  });

  it("does NOT drop a bullet that starts with `Rules` but continues", () => {
    expect(cleanRewriteLine("Rules-engine refactor cut tail latency 40%.")).toBe(
      "Rules-engine refactor cut tail latency 40%.",
    );
  });
});
