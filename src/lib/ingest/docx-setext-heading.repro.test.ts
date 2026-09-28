// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Repro for #961 — a DOCX built with Word's `Heading 1` / `Heading 2` styles
 * parsed WORSE than one that fakes headings with bold paragraphs.
 *
 * Mammoth maps `Heading1`/`Heading2` to `<h1>`/`<h2>`, and turndown's default
 * `headingStyle` is `"setext"`, so `parseDocx` used to emit `Text\n====` /
 * `Text\n----` — a shape neither `markdown-lines.ts` nor `mdToPlainText` reads.
 * The underline survived as a junk prose line and the heading lost its level.
 *
 * Mocks mammoth's HTML output directly rather than committing a binary .docx
 * fixture (matching `docx.test.ts`'s approach) and runs the real turndown
 * conversion inside `docx.ts`, pinning that `parseDocx` now emits ATX headings
 * with no `=`/`-`-only line.
 */

import { describe, it, expect, vi } from "vitest";

const MOCK_HTML = "<h1>Experience</h1><p>x</p><h2>Sub</h2><p>y</p>";
const MOCK_RAWTEXT = "Experience\nx\nSub\ny\n";

vi.mock("mammoth", () => ({
  default: {
    convertToHtml: vi.fn().mockResolvedValue({ value: MOCK_HTML, messages: [] }),
    extractRawText: vi.fn().mockResolvedValue({ value: MOCK_RAWTEXT, messages: [] }),
  },
}));

import { parseDocx } from "./docx.ts";

describe("#961 — DOCX Heading1/Heading2 never render as setext", () => {
  it("emits ATX headings instead of a `Text\\n====` / `Text\\n----` underline", async () => {
    const { markdown } = await parseDocx(new ArrayBuffer(8));
    expect(markdown).toContain("# Experience");
    expect(markdown).toContain("## Sub");
  });

  it("leaves no `=`/`-`-only line in the converted markdown", async () => {
    const { markdown } = await parseDocx(new ArrayBuffer(8));
    const junkLine = markdown
      .split("\n")
      .find((line) => /^=+$/.test(line.trim()) || /^-{2,}$/.test(line.trim()));
    expect(junkLine).toBeUndefined();
  });
});
