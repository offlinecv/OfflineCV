// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Value-locking regression for #820 — a résumé that draws each section rule
 * as a run of underscores on the SAME baseline as the header word, its own
 * text item (`{"str":"Education",…}` then `{"str":"____…",…}` at the same
 * `y`). Line assembly correctly merges the two into one line
 * (`Education__________…`), but pre-fix `matchSectionHeaderDetailed` stripped
 * only a leading decorative glyph (#414) and a trailing `[:·•]+` run, never a
 * trailing decorative RULE — so the exact-alias tier compared the whole
 * decorated string against `education` and never matched. No section ever
 * opened, and the entire résumé landed in `profile`: `experienceCount: 0`,
 * `educationCount: 0`, despite Tier 0 extraction and line assembly both being
 * correct.
 *
 * Four levels, per the issue's acceptance criteria (plus a review follow-up):
 *   1. the matcher strips a >=3-char trailing rule and still matches;
 *   2. the matcher does NOT strip a 1-2 char trailing dash, so a hyphenated
 *      header ("Skills -") is unaffected;
 *   3. a qualified header with a separate trailing rule ("IT Experience ___")
 *      still reaches the anchor-fallback tier — a post-merge review comment
 *      caught that the fallback path was receiving the UNSTRIPPED raw text,
 *      so the rule's non-letter lead token tripped its per-word casing guard;
 *   4. end-to-end over the new fixture, the résumé routes a real multi-section
 *      split instead of collapsing to `profile` alone.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { matchSectionHeaderDetailed } from "./regex.ts";
import { runCascade } from "./cascade.ts";
import type { CascadeResult } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/google-docs/google-docs-skia-proxy-underscore-rule-headers.pdf",
);

describe("a trailing decorative rule glued onto a header still matches (#820)", () => {
  it("strips a long trailing underscore run and matches the education alias", () => {
    expect(matchSectionHeaderDetailed("Education" + "_".repeat(74))).toEqual({
      section: "education",
      viaAnchorFallback: false,
    });
  });

  it("strips a long trailing em-dash rule and matches the experience alias", () => {
    expect(matchSectionHeaderDetailed("Experience" + "—".repeat(60))).toEqual({
      section: "experience",
      viaAnchorFallback: false,
    });
  });

  it("does not strip a 1-2 char trailing dash — a hyphenated header is unchanged", () => {
    // Guards the >=3 floor: "Skills -" must keep failing exact-alias (the
    // trailing " -" is not a rule), same as before this fix.
    expect(matchSectionHeaderDetailed("Skills -")).toBeNull();
  });

  it("strips a trailing rule from a qualified header so the anchor-fallback tier still matches", () => {
    // "IT Experience ___" fails the exact-alias tier ("it experience" isn't a
    // known alias) and must fall through to matchAnchorFallback. Pre-fix, that
    // tier received the UNSTRIPPED raw text, whose trailing "___" token failed
    // Guard 7's per-word uppercase check and rejected the whole line.
    expect(matchSectionHeaderDetailed("IT Experience " + "_".repeat(20))).toEqual({
      section: "experience",
      viaAnchorFallback: true,
    });
  });
});

describe("end-to-end: the underscore-rule fixture routes a real multi-section split (#820)", () => {
  let cascade: CascadeResult;

  beforeAll(async () => {
    const bytes = readFileSync(FIXTURE);
    cascade = await runCascade(new Uint8Array(bytes));
  });

  it("parses roles and a degree — the reported defect was zero of each", () => {
    expect(cascade.canonical.fields.experience?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(cascade.canonical.fields.education?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("does not collapse the whole document into a single profile section", () => {
    const routed = [...cascade.canonical.sections.byName.keys()];
    expect(routed).not.toEqual(["profile"]);
    expect(routed).toContain("experience");
    expect(routed).toContain("education");
  });
});
