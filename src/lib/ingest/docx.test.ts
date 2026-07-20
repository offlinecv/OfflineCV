// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
// Dynamic import path matches what docx.ts uses at runtime. jszip is NOT mocked
// — the header/footer extraction reads a real in-memory zip.
import { parseDocx, parseHeaderFooterHyperlinks } from "./docx.ts";
import JSZip from "jszip";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const hyperlinkHeaderXml = (id: string, text: string) =>
  `<w:hdr ${W_NS}><w:p><w:hyperlink r:id="${id}"><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p></w:hdr>`;
const relsXml = (entries: Array<{ id: string; target: string }>) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(
      (e) =>
        `<Relationship Id="${e.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${e.target}" TargetMode="External"/>`,
    )
    .join("")}</Relationships>`;

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

  it("recovers LinkedIn/GitHub hyperlinks from the DOCX header into the markdown", async () => {
    // Build a minimal DOCX zip carrying a header part + its rels. mammoth (which
    // ignores headers) is mocked; jszip reads this real zip.
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document ${W_NS}><w:body/></w:document>`);
    zip.file(
      "word/header1.xml",
      `<w:hdr ${W_NS}><w:p>` +
        `<w:hyperlink r:id="rId1"><w:r><w:t>LinkedIn</w:t></w:r></w:hyperlink>` +
        `<w:hyperlink r:id="rId2"><w:r><w:t>GitHub</w:t></w:r></w:hyperlink>` +
        `</w:p></w:hdr>`,
    );
    zip.file(
      "word/_rels/header1.xml.rels",
      relsXml([
        { id: "rId1", target: "https://linkedin.com/in/johndoe" },
        { id: "rId2", target: "https://github.com/johndoe" },
      ]),
    );
    const bytes = (await zip.generateAsync({ type: "arraybuffer" })) as ArrayBuffer;

    const result = await parseDocx(bytes);
    expect(result.markdown).toContain("[LinkedIn](https://linkedin.com/in/johndoe)");
    expect(result.markdown).toContain("[GitHub](https://github.com/johndoe)");
    expect(result.rawText).toContain("https://linkedin.com/in/johndoe");
    // The mocked body content still flows through.
    expect(result.markdown).toContain("**Jane Doe**");
  });
});

describe("parseHeaderFooterHyperlinks", () => {
  it("resolves r:id hyperlinks against the rels file", () => {
    const links = parseHeaderFooterHyperlinks(
      hyperlinkHeaderXml("rId7", "LinkedIn"),
      relsXml([{ id: "rId7", target: "https://linkedin.com/in/johndoe" }]),
    );
    expect(links).toEqual([
      { text: "LinkedIn", url: "https://linkedin.com/in/johndoe" },
    ]);
  });

  it("decodes XML entities in the target URL", () => {
    const links = parseHeaderFooterHyperlinks(
      hyperlinkHeaderXml("rId1", "Profile"),
      relsXml([{ id: "rId1", target: "https://example.com/p?a=1&amp;b=2" }]),
    );
    expect(links[0].url).toBe("https://example.com/p?a=1&b=2");
  });

  it("decodes numeric (decimal + hex) character references in the target URL", () => {
    const links = parseHeaderFooterHyperlinks(
      hyperlinkHeaderXml("rId1", "Profile"),
      // &#38; = '&' (decimal), &#x3D; = '=' (hex)
      relsXml([{ id: "rId1", target: "https://example.com/p?a=1&#38;b&#x3D;2" }]),
    );
    expect(links[0].url).toBe("https://example.com/p?a=1&b=2");
  });

  it("ignores internal anchors with no external relationship", () => {
    const xml = `<w:hdr ${W_NS}><w:p><w:hyperlink w:anchor="_Top"><w:r><w:t>Top</w:t></w:r></w:hyperlink></w:p></w:hdr>`;
    expect(parseHeaderFooterHyperlinks(xml, relsXml([]))).toEqual([]);
  });

  it("catches a full URL typed as plain header text", () => {
    const xml = `<w:hdr ${W_NS}><w:p><w:r><w:t>github.com is here https://github.com/johndoe</w:t></w:r></w:p></w:hdr>`;
    const links = parseHeaderFooterHyperlinks(xml, "");
    expect(links).toEqual([{ text: "", url: "https://github.com/johndoe" }]);
  });
});
