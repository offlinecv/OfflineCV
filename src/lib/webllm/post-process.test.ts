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

  // ── #150: chat-opener preamble ────────────────────────────────────────
  // Surfaced by Llama 3.2 (3B) under the terse + examples-led variants of
  // the rewrite eval (issue #65). These openers are not bullets; dropping
  // them keeps the section-rewrite output count honest.
  describe("chat-opener preamble (#150)", () => {
    it("drops `Here are the rewritten bullets:`", () => {
      expect(cleanRewriteLine("Here are the rewritten bullets:")).toBe("");
    });

    it("drops `Here is the rewritten bullet:` (singular variant)", () => {
      expect(cleanRewriteLine("Here is the rewritten bullet:")).toBe("");
    });

    it("drops case-insensitive variants", () => {
      expect(cleanRewriteLine("HERE ARE THE REWRITTEN BULLETS:")).toBe("");
      expect(cleanRewriteLine("here are the rewritten bullets:")).toBe("");
    });

    it("drops the `the`-less form", () => {
      // `(?:the )?` in the pattern allows both `Here are the rewritten`
      // and `Here are rewritten`; the latter shows up occasionally in
      // small-model output.
      expect(cleanRewriteLine("Here are rewritten bullets:")).toBe("");
    });

    it("does NOT drop a legitimate bullet that begins with `Here`", () => {
      // A real bullet would not match the chat-opener pattern (no
      // `rewritten` token after `here are/is (the)`).
      expect(
        cleanRewriteLine("Here, configured the alerting pipeline for 12 services."),
      ).toBe("Here, configured the alerting pipeline for 12 services.");
    });

    it("does NOT drop `Here are updated KPIs from Q3 …`", () => {
      // Defensive — pattern is narrowed to `rewritten` only so this
      // real (if uncommon) bullet shape survives. If a model is observed
      // emitting an alternative opener shape in a future eval report,
      // widen the pattern then.
      expect(
        cleanRewriteLine("Here are updated KPIs from Q3 with 12% lift."),
      ).toBe("Here are updated KPIs from Q3 with 12% lift.");
    });
  });

  // ── #152: leading `**Verb**` bold strip ───────────────────────────────
  // Surfaced by Gemma 2 (2B) under the terse variant of the rewrite eval
  // (issue #65). The model bolds just the leading verb of each bullet; the
  // existing whole-line emphasis strip doesn't match this inline shape.
  describe("leading bold verb (#152)", () => {
    it("strips `**Verb**` when followed by body text", () => {
      expect(
        cleanRewriteLine("**Increased** weekly active users by 1500%."),
      ).toBe("Increased weekly active users by 1500%.");
      expect(
        cleanRewriteLine("**Spearheaded** a growth team of six individuals."),
      ).toBe("Spearheaded a growth team of six individuals.");
    });

    it("preserves the leading word's punctuation context", () => {
      // `Triaged` is a single token; the strip should leave it cleanly
      // followed by the rest of the bullet.
      expect(
        cleanRewriteLine(
          "**Triaged** 200+ inbound support tickets per week across email and chat.",
        ),
      ).toBe(
        "Triaged 200+ inbound support tickets per week across email and chat.",
      );
    });

    it("does NOT strip multi-word leading bold (intentional emphasis)", () => {
      // The single-token capture is by design — `**Streamlined the**` is
      // probably a deliberate phrase-level emphasis, not a verb-bolding
      // tic. Leave it for a human to read.
      expect(cleanRewriteLine("**Streamlined the** checkout process")).toBe(
        "**Streamlined the** checkout process",
      );
    });

    it("falls through to whole-line emphasis strip for a bolded single word", () => {
      // `**X**` alone is still handled by the existing whole-line
      // emphasis rule (the new pattern requires trailing space + body).
      expect(cleanRewriteLine("**Shipped Foo.**")).toBe("Shipped Foo.");
    });

    it("does NOT strip mid-bullet bold emphasis", () => {
      expect(
        cleanRewriteLine("Led migration of the **order-processing** pipeline."),
      ).toBe("Led migration of the **order-processing** pipeline.");
    });
  });
});
