// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Thin markdown → { rawText, markdown } adapter — the import side of the
 * `cv.md` round-trip (#552), sibling to `ingest/docx.ts`.
 *
 * Unlike DOCX, a dropped `.md` file already IS markdown, so there is no
 * extraction step: `markdown` is the file's text verbatim, and `rawText` is a
 * light plaintext strip of it (headings/emphasis/bullets/link syntax) so the
 * scorer's raw-text scans — which expect prose, not markdown syntax — see the
 * same content DOCX's `extractRawText` would have produced. Pure, string-only,
 * no I/O: the caller reads the File via `file.text()` before calling this.
 */

export interface MarkdownParseResult {
  rawText: string;
  markdown: string;
}

/**
 * Strip common inline markdown syntax down to plaintext: leading heading `#`
 * markers, `*`/`_` emphasis, leading list-bullet markers (`-`/`*`/`+`), and
 * `[text](url)` links (→ `text url`, keeping both the label and the target
 * searchable). Not a full markdown parser — just enough that the scorer's
 * raw-text heuristics (which never expect markdown syntax) see prose.
 *
 * Underscore emphasis is stripped only at word boundaries, so intraword
 * underscores (`snake_case_name`, an SDK symbol, a slug) survive verbatim —
 * matching CommonMark, which disallows single-underscore emphasis mid-word.
 * Asterisk emphasis has no intraword ambiguity and is stripped directly.
 */
export function mdToPlainText(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "") // heading markers
        .replace(/^\s*[-*+]\s+/, "") // list bullet markers
        .replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1 $2") // [text](url) → text url
        .replace(/\*\*(.+?)\*\*/g, "$1") // bold (asterisk)
        .replace(/\*(.+?)\*/g, "$1") // italic (asterisk)
        .replace(/(^|\W)__(\S(?:.*?\S)?)__(?=\W|$)/g, "$1$2") // bold (underscore, word-boundary)
        .replace(/(^|\W)_(\S(?:.*?\S)?)_(?=\W|$)/g, "$1$2"), // italic (underscore, word-boundary)
    )
    .join("\n");
}

/**
 * Parse a dropped `.md`/`.markdown` file's text into `{ rawText, markdown }`,
 * the same shape `parseDocx` returns — `markdown` feeds `runCascadeFromMarkdown`
 * unchanged (it already parses markdown), `rawText` feeds the scorer's plain-
 * text scans.
 */
export function parseMarkdownFile(text: string): MarkdownParseResult {
  return { rawText: mdToPlainText(text), markdown: text };
}
