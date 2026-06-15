// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for the DOCX ingest adapter (parseDocx).
 *
 * We do NOT commit a binary .docx fixture — the PII policy for the public
 * repo requires verified-synthetic fixtures and verifying a DOCX binary's
 * text content is impractical at review time. Instead we mock mammoth's
 * return value directly, which also keeps the test fast and offline.
 *
 * This validates:
 *   1. parseDocx calls mammoth.convertToHtml + extractRawText.
 *   2. It converts the HTML through turndown to produce markdown.
 *   3. The returned { rawText, markdown } shape is correct.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mammoth mock -----------------------------------------------------------
// convertToHtml returns an HTML fragment; extractRawText returns plain text.
const MOCK_HTML = "<p><strong>Jane Doe</strong></p><p>jane@example.com</p>";
const MOCK_RAWTEXT = "Jane Doe\njane@example.com\n";

vi.mock("mammoth", () => ({
  default: {
    convertToHtml: vi.fn().mockResolvedValue({ value: MOCK_HTML, messages: [] }),
    extractRawText: vi.fn().mockResolvedValue({ value: MOCK_RAWTEXT, messages: [] }),
  },
}));

// --- Import after mock registration -----------------------------------------
// Dynamic import path matches what docx.ts uses at runtime.
import { parseDocx } from "./docx.ts";

describe("parseDocx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rawText from mammoth.extractRawText", async () => {
    const buffer = new ArrayBuffer(8);
    const result = await parseDocx(buffer);
    expect(result.rawText).toBe(MOCK_RAWTEXT);
  });

  it("returns markdown converted from mammoth HTML via turndown", async () => {
    const buffer = new ArrayBuffer(8);
    const result = await parseDocx(buffer);
    // turndown converts <strong>…</strong> → **…**
    expect(result.markdown).toContain("**Jane Doe**");
    // and plain text survives
    expect(result.markdown).toContain("jane@example.com");
  });

  it("result shape has rawText and markdown as strings", async () => {
    const buffer = new ArrayBuffer(8);
    const result = await parseDocx(buffer);
    expect(typeof result.rawText).toBe("string");
    expect(typeof result.markdown).toBe("string");
  });
});
