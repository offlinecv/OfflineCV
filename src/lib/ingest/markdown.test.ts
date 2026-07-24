// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the markdown ingest adapter (#552): `parseMarkdownFile`
 * passes `markdown` through verbatim, and `mdToPlainText` strips heading,
 * emphasis, list-bullet, and link syntax down to prose.
 */

import { describe, it, expect } from "vitest";
import { mdToPlainText, parseMarkdownFile } from "./markdown.ts";

describe("parseMarkdownFile", () => {
  it("carries the source text through as markdown verbatim", () => {
    const text = "# Jane Doe\n\n- Shipped X\n";
    expect(parseMarkdownFile(text).markdown).toBe(text);
  });

  it("derives rawText from the same source via mdToPlainText", () => {
    const text = "# Jane Doe\n\n- Shipped X";
    expect(parseMarkdownFile(text).rawText).toBe(mdToPlainText(text));
  });
});

describe("mdToPlainText", () => {
  it("strips a leading heading marker", () => {
    expect(mdToPlainText("## Experience")).toBe("Experience");
  });

  it("strips leading list-bullet markers (-, *, +)", () => {
    expect(mdToPlainText("- Shipped X")).toBe("Shipped X");
    expect(mdToPlainText("* Shipped Y")).toBe("Shipped Y");
    expect(mdToPlainText("+ Shipped Z")).toBe("Shipped Z");
  });

  it("strips bold and italic emphasis", () => {
    expect(mdToPlainText("**Acme Corp**")).toBe("Acme Corp");
    expect(mdToPlainText("*Senior Engineer*")).toBe("Senior Engineer");
    expect(mdToPlainText("_Senior Engineer_")).toBe("Senior Engineer");
  });

  it("expands [text](url) links to 'text url', keeping both searchable", () => {
    expect(mdToPlainText("[LinkedIn](https://linkedin.com/in/jane)")).toBe(
      "LinkedIn https://linkedin.com/in/jane",
    );
  });

  it("handles a multi-line document", () => {
    const input = "# Jane Doe\n\n## Experience\n\n**Acme Corp**\n- Shipped X\n- Led Y";
    const expected = "Jane Doe\n\nExperience\n\nAcme Corp\nShipped X\nLed Y";
    expect(mdToPlainText(input)).toBe(expected);
  });

  it("preserves intraword underscores (snake_case, slugs) — not emphasis", () => {
    expect(mdToPlainText("Built scikit_learn pipelines")).toBe(
      "Built scikit_learn pipelines",
    );
    expect(mdToPlainText("owned answer_bank_ingestion path")).toBe(
      "owned answer_bank_ingestion path",
    );
  });
});
