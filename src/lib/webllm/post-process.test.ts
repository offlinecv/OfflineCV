// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

  // ── A list marker must not shield the leading bold (#781) ──────────────────
  //
  // `LEADING_BOLD_WORD_PATTERN` is anchored at `^`, and the marker strip used
  // to run after it, so anything the model put in front of the bold hid it.
  // This shipped: 19 of 24 Gemma `terse` bullets in the 2026-08-07 eval reports
  // carry literal `**` at `perBullet[].text` — post-`cleanRewriteLine` output,
  // i.e. what a downloaded ATS PDF renders as asterisks. That renderer draws
  // real bold from its own type scale and never interprets markdown, so a
  // surviving `**` is always garbage.
  //
  // Every case below returns the marker-shielded input unchanged against the
  // pre-fix implementation.
  describe("list marker in front of a leading bold (#781)", () => {
    it.each([
      ["- **Led** the migration of billing.", "dash"],
      ["* **Led** the migration of billing.", "asterisk"],
      ["• **Led** the migration of billing.", "bullet glyph"],
      ["1. **Led** the migration of billing.", "numbered"],
      ["1) **Led** the migration of billing.", "paren-numbered"],
      ["-**Led** the migration of billing.", "tight dash, no space"],
    ])("strips both, leaving no markdown: %s (%s)", (input) => {
      expect(cleanRewriteLine(input)).toBe("Led the migration of billing.");
    });

    it("leaves no literal asterisks for any marker shape", () => {
      // The property the ATS PDF actually depends on, asserted directly rather
      // than inferred from the equality cases above.
      for (const marker of ["-", "*", "•", "1.", "1)"]) {
        expect(cleanRewriteLine(`${marker} **Shipped** the thing.`)).not.toContain(
          "*",
        );
      }
    });

    it("still reads `*Foo.*` as italics, not as a bullet glyph", () => {
      // The ordering constraint that made this a loop rather than a swap: the
      // emphasis strip has to keep beating the marker strip for this shape, or
      // the leading `*` is eaten as a marker and the trailing one survives.
      expect(cleanRewriteLine("*Foo.*")).toBe("Foo.");
      expect(cleanRewriteLine("* Foo.*")).toBe("Foo.");
    });

    // ── The complementary hazard: a strip OVER-firing on what it uncovered ──
    //
    // Every case above shares one body, so they only prove a marker no longer
    // *shields* the bold. They are blind to a strip mis-firing on the text the
    // previous pass exposed — which is exactly how the loop first shipped
    // `- 3.5x revenue growth` → `5x revenue growth`: pass 1 removed `- `, and
    // pass 2 read the uncovered `3.` as a numbered marker because that branch
    // allowed zero-or-more trailing space. Silent numeric corruption, on the
    // path that renders the ATS PDF (#781 review).
    it.each([
      ["- 3.5x revenue growth in Q3.", "3.5x revenue growth in Q3."],
      ["- 2.5M users onboarded.", "2.5M users onboarded."],
      ["* 1.5x faster builds.", "1.5x faster builds."],
      ["- 10.5 million records migrated.", "10.5 million records migrated."],
      ["• 4.2% conversion lift.", "4.2% conversion lift."],
      // Not marker-prefixed at all — the same branch mangled this on its own.
      ["3.5x revenue growth.", "3.5x revenue growth."],
    ])("does not eat a decimal a marker strip uncovers: %s", (input, want) => {
      expect(cleanRewriteLine(input)).toBe(want);
    });

    it("preserves every digit of a leading decimal, for any marker", () => {
      // The number-preservation counterpart to the `not.toContain("*")`
      // property above. Asserted as a property so a new marker branch has to
      // satisfy it too, not just the six literals enumerated here.
      for (const marker of ["-", "*", "•", "1.", "1)"]) {
        expect(cleanRewriteLine(`${marker} 3.5x revenue growth.`)).toContain(
          "3.5",
        );
      }
    });

    it("still strips a genuine numbered marker", () => {
      // The `\s+` requirement must not cost the case the marker strip exists
      // for. Nothing in the corpus writes a tight `1.Foo`.
      expect(cleanRewriteLine("1. Shipped the thing.")).toBe(
        "Shipped the thing.",
      );
      expect(cleanRewriteLine("1) Shipped the thing.")).toBe(
        "Shipped the thing.",
      );
    });

    it("converges on stacked markers instead of truncating", () => {
      // The loop runs to a fixed point rather than a fixed pass count. An
      // earlier revision capped it at 4 and gave up here, leaving the literal
      // `**` this function exists to remove.
      expect(cleanRewriteLine("1. - • - **Led** stuff.")).toBe("Led stuff.");
    });

    it("leaves mid-line bold alone even when a marker is stripped", () => {
      // Deliberate, and the one shape this fix does not clear — see the
      // fixed-point comment in post-process.ts. 18 of the 19 affected eval
      // bullets carried a leading bold only, so this is the rare tail.
      expect(
        cleanRewriteLine("- **Developed** and **implemented** a design system."),
      ).toBe("Developed and **implemented** a design system.");
    });
  });
});
