// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Markdown → pseudo-`PdfLine[]` adapter.
 *
 * Bridges mammoth+turndown DOCX markdown into the shape the existing Tier 1
 * extractors already consume. The extractors look at `line.text`,
 * `line.maxFontSize` (for the name heuristic), and `line.allCaps` — all
 * three are derivable from a markdown line. By adapting at the *line*
 * level we reuse the full `extract-fields.ts` battery (name, contact,
 * summary, skills, experience, education) for DOCX with no duplication,
 * while keeping the adapter small enough to audit.
 *
 * Pre-cleaning pass (real-world DOCX artifacts):
 *   - Strip base64 data URIs in `![...](data:...)` — mammoth+turndown emits
 *     embedded images this way and they can bloat markdown 3× with zero
 *     signal for parsing.
 *   - Unescape turndown's backslash-escapes (`\_`, `\*`, `\[`, `\.`). These
 *     would otherwise break email / URL regex (e.g. `Lee\_Jordan@foo`
 *     parses as `_Jordan@foo`).
 *   - Join split-letter headers like `S UMMARY` / `E XPERIENCE` that come
 *     from Word's icon-letter decorations.
 *   - Strip inline italic markers `_text_` / `*text*` in addition to bold.
 *
 * Line shapes detected:
 *   - `# heading` / `## heading` / `### heading` → section header candidates
 *   - `**BOLD**` standalone on a line → section header candidate (mammoth's
 *     most common DOCX shape — sections are styled as bold paragraphs, not
 *     actual heading styles)
 *   - ALLCAPS standalone on a line → section header candidate (plain-text
 *     resumes and some Word templates)
 *   - `- item` bullet → preserved in text as `- item` so the shared
 *     `isBulletLine` extractor matches
 *   - Everything else → plain prose line
 *
 * Tables (GFM pipe syntax) are flattened into rows of text joined by
 * " | "; rare in resumes and not worth a dedicated extractor today.
 */

import type { PdfLine, PdfSection } from "./sections.ts";
import { matchSectionHeader, SECTION_KEYWORDS, type SectionName } from "./regex.ts";

// ── Heading-surrogate font sizes ────────────────────────────────────────────
//
// The PDF Tier 1 extractors use `maxFontSize` to score the name (bigger =
// more likely the name) and as a tie-breaker. We synthesize equivalents
// from markdown heading level so the scoring still works. Numbers are
// relative — only the ordering matters.

const BODY_FONT_SIZE = 10;
const BOLD_PARAGRAPH_FONT_SIZE = 12;
const H3_FONT_SIZE = 12;
const H2_FONT_SIZE = 14;
const H1_FONT_SIZE = 16;

// ── Line classification ─────────────────────────────────────────────────────

const ATX_HEADING_RE = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/;
const BOLD_STANDALONE_RE = /^\s*\*\*\s*(.+?)\s*\*\*\s*$/;
const ALL_CAPS_RE = /^\s*([A-Z][A-Z0-9 &/\-]{3,60})\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}\s*(?:\|\s*:?-{2,}\s*)+\|?\s*$/;
const BULLET_PREFIX_RE = /^\s*([-*+])\s+/;
const INLINE_BOLD_RE = /\*\*(.+?)\*\*/g;
const INLINE_ITALIC_UNDERSCORE_RE = /(^|[^\w\\])_([^\s_][^_]*?[^\s_]|[^\s_])_(?=[^\w]|$)/g;
const INLINE_ITALIC_STAR_RE = /(^|[^\w\\*])\*([^\s*][^*]*?[^\s*]|[^\s*])\*(?=[^\w*]|$)/g;

// Base64 data-URI images in markdown: ![alt](data:image/...;base64,....)
// Multi-line friendly because turndown occasionally wraps.
const DATA_URI_IMAGE_RE = /!\[[^\]]*\]\(data:[^)]*\)/g;

// Non-data markdown images: `![alt](https://...)` and `![](path.png)`. Alt
// text alone isn't useful for resume parsing — drop the whole image ref so
// it doesn't pollute the line text.
const ANY_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;

// Turndown backslash-escapes characters that have markdown meaning: `_`,
// `*`, `[`, `]`, `(`, `)`, `.`, `+`, `-`, `!`, `` ` ``, `#`, `>`. Undo the
// escapes that appear in contact data / prose. We keep `\n` as-is.
const BACKSLASH_ESCAPE_RE = /\\([_*[\]()!`#>.+-])/g;

// A short intro letter separated from the rest of the word by a space:
// `**S UMMARY**`, `# E XPERIENCE`, `e XPERIENCE`. Word's icon-letter
// decorations render as a separate character next to the rest of the word.
// Restricted to (a) the letter being a single alpha char followed by a
// space and (b) the following word being 3+ alpha chars.
const SPLIT_LETTER_RE = /\b([A-Za-z])\s+([A-Za-z]{3,})\b/g;

/** Strip base64 image blobs and non-data image refs from markdown. */
function stripImages(markdown: string): string {
  return markdown
    .replace(DATA_URI_IMAGE_RE, "")
    .replace(ANY_IMAGE_RE, "");
}

/** Undo turndown's backslash-escapes of markdown-meaningful characters. */
function unescapeBackslashes(markdown: string): string {
  return markdown.replace(BACKSLASH_ESCAPE_RE, (_m, ch: string) => ch);
}

/**
 * Section keywords we're willing to reconstruct from Word's icon-letter
 * split (e.g. `**S UMMARY**` → `**SUMMARY**`). Deliberately excludes
 * `skills`-family keywords: DOCX resumes with a two-column layout
 * commonly place a SKILLS label in the sidebar, which mammoth flattens
 * INTO the main content stream *between* experience entries. Normalizing
 * `**S KILLS**` there would open a new section mid-experience and strand
 * every subsequent role. Literal "SKILLS" headers in the main column
 * don't use the split-letter decoration in practice, so we lose almost
 * nothing by excluding this keyword from the normalizer.
 */
const SPLIT_LETTER_NORMALIZABLE_SECTIONS: ReadonlySet<SectionName> = new Set([
  "summary",
  "experience",
  "education",
  "certifications",
  "projects",
]);

/**
 * Detect standalone header lines where the first letter has been split off
 * by Word's icon-letter decoration (e.g. `**S UMMARY**` → `**SUMMARY**`).
 * Only applies to lines that, after the join, match one of the canonical
 * section keywords AND whose section appears in
 * `SPLIT_LETTER_NORMALIZABLE_SECTIONS` — avoids false positives on normal
 * prose and skips keywords (skills-family) that commonly bleed through
 * from a DOCX two-column sidebar.
 */
function normalizeSplitLetterHeaders(markdown: string): string {
  // Map each canonical keyword to its parent section so we can filter
  // by the allowlist above.
  const keywordToSection = new Map<string, SectionName>();
  for (const [name, keywords] of Object.entries(SECTION_KEYWORDS) as Array<
    [SectionName, readonly string[]]
  >) {
    for (const k of keywords) keywordToSection.set(k.toLowerCase(), name);
  }
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    // Only consider lines that look header-ish (ATX, bold-standalone, or
    // all-caps candidate) — prose lines with incidental split words stay
    // untouched.
    const atx = ATX_HEADING_RE.exec(raw);
    const bold = BOLD_STANDALONE_RE.exec(raw);
    const caps = ALL_CAPS_RE.exec(raw);
    const payloadMatch = atx ?? bold ?? caps;
    if (!payloadMatch) continue;

    const payload = (atx ? atx[2] : bold ? bold[1] : caps![1]).trim();
    const joined = payload.replace(SPLIT_LETTER_RE, (_m, a: string, b: string) => `${a}${b}`);
    if (joined === payload) continue;
    const section = keywordToSection.get(joined.toLowerCase());
    if (!section) continue;
    if (!SPLIT_LETTER_NORMALIZABLE_SECTIONS.has(section)) continue;

    // Rebuild the line with the normalized payload.
    if (atx) {
      lines[i] = raw.replace(payload, joined);
    } else if (bold) {
      lines[i] = raw.replace(payload, joined);
    } else if (caps) {
      lines[i] = raw.replace(payload, joined);
    }
  }
  return lines.join("\n");
}

/**
 * Pre-clean the raw markdown before line-by-line classification. Idempotent
 * and cheap — runs once per DOCX upload.
 */
export function preprocessMarkdown(markdown: string): string {
  let out = markdown;
  out = stripImages(out);
  out = unescapeBackslashes(out);
  out = normalizeSplitLetterHeaders(out);
  return out;
}

/**
 * Normalize one raw markdown line into a `PdfLine` with synthesized
 * `maxFontSize` / `allCaps` / cleaned `text`. Returns `null` for lines we
 * should drop entirely (blank separators, table pipe-separators, etc).
 */
function classifyMarkdownLine(
  raw: string,
  pageNumber: number,
  yCounter: number,
): PdfLine | null {
  if (!raw || !raw.trim()) return null;
  if (TABLE_SEPARATOR_RE.test(raw)) return null;

  // ATX heading: strip `#` markers, promote to large surrogate font size.
  const atx = ATX_HEADING_RE.exec(raw);
  if (atx) {
    const level = atx[1].length;
    const text = stripInlineEmphasis(atx[2]).trim();
    const fontSize =
      level === 1
        ? H1_FONT_SIZE
        : level === 2
          ? H2_FONT_SIZE
          : H3_FONT_SIZE;
    return buildLine(pageNumber, yCounter, text, fontSize);
  }

  // Standalone bold paragraph: mammoth's section-label shape.
  const boldStandalone = BOLD_STANDALONE_RE.exec(raw);
  if (boldStandalone) {
    const text = boldStandalone[1].trim();
    // Short bold lines are section labels; long bold lines are emphasized
    // body. Cap to typical header length.
    const fontSize =
      text.length <= 60 ? BOLD_PARAGRAPH_FONT_SIZE : BODY_FONT_SIZE;
    return buildLine(pageNumber, yCounter, text, fontSize);
  }

  // GFM table row — flatten to " | "-joined cells on a single line.
  if (TABLE_ROW_RE.test(raw)) {
    const cells = raw
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => stripInlineEmphasis(c).trim())
      .filter((c) => c.length > 0);
    if (cells.length === 0) return null;
    return buildLine(pageNumber, yCounter, cells.join(" | "), BODY_FONT_SIZE);
  }

  // Bullet line — keep the leading `- ` so the shared `isBulletLine`
  // detector matches. Strip inline bold from the item body.
  if (BULLET_PREFIX_RE.test(raw)) {
    const cleaned = raw.replace(
      BULLET_PREFIX_RE,
      (_, glyph: string) => `${glyph} `,
    );
    return buildLine(
      pageNumber,
      yCounter,
      stripInlineEmphasis(cleaned).trim(),
      BODY_FONT_SIZE,
    );
  }

  // All-caps standalone line — plain-text section label. We leave the
  // `fontSize` at body and rely on `allCaps=true` (computed below) to give
  // `matchSectionHeader` a clean shot. Header detection happens against
  // the trimmed text.
  const allCapsMatch = ALL_CAPS_RE.exec(raw);
  if (allCapsMatch) {
    return buildLine(
      pageNumber,
      yCounter,
      allCapsMatch[1].trim(),
      // Promote slightly so the name extractor doesn't pick these up as
      // candidate names — they're likely section labels.
      BOLD_PARAGRAPH_FONT_SIZE,
    );
  }

  // Plain prose.
  return buildLine(
    pageNumber,
    yCounter,
    stripInlineEmphasis(raw).trim(),
    BODY_FONT_SIZE,
  );
}

/**
 * Strip inline `**bold**`, `_italic_`, and `*italic*` markers. Italic
 * stripping is bounded so we don't touch underscores inside tokens
 * (`some_var_name`) or escaped underscores (handled by `preprocessMarkdown`).
 */
function stripInlineEmphasis(text: string): string {
  let out = text.replace(INLINE_BOLD_RE, (_m, inner: string) => inner);
  out = out.replace(
    INLINE_ITALIC_UNDERSCORE_RE,
    (_m, prefix: string, inner: string) => `${prefix}${inner}`,
  );
  out = out.replace(
    INLINE_ITALIC_STAR_RE,
    (_m, prefix: string, inner: string) => `${prefix}${inner}`,
  );
  return out;
}

function buildLine(
  page: number,
  y: number,
  text: string,
  fontSize: number,
): PdfLine {
  return {
    page,
    y,
    x: 0,
    items: [],
    text,
    maxFontSize: fontSize,
    allCaps:
      text.replace(/[^A-Za-z]/g, "").length > 0 &&
      text === text.toUpperCase(),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Convert mammoth markdown into `PdfLine[]` the existing Tier 1 extractors
 * can consume. Preserves line ordering; assigns monotonically-increasing
 * `y` per line (so ordering comparisons in extractors still work) and
 * keeps everything on a single synthetic page.
 *
 * Runs `preprocessMarkdown` first to strip base64 image blobs, undo
 * turndown escapes, and normalize split-letter section headers.
 */
export function markdownToPseudoLines(markdown: string): PdfLine[] {
  const cleaned = preprocessMarkdown(markdown);
  const rawLines = cleaned.split(/\r?\n/);
  const out: PdfLine[] = [];
  let y = 0;
  for (const raw of rawLines) {
    const line = classifyMarkdownLine(raw, 1, y);
    if (line) {
      out.push(line);
      y += 1;
    }
  }
  return out;
}

/**
 * Group the pseudo-lines into sections using the same canonical-header
 * logic as the PDF path. Content above the first recognized header lands
 * in the synthetic `profile` section.
 *
 * Slightly more lenient than PDF's `splitIntoSections`: we also recognize
 * lines whose first-word-only matches a canonical section (covers cases
 * like `EXPERIENCE 04/2021 - Present` where the date run got joined into
 * the header line in mammoth output).
 */
export function sectionizeMarkdownLines(lines: PdfLine[]): PdfSection[] {
  const sections: PdfSection[] = [{ name: "profile", lines: [] }];

  for (const line of lines) {
    const header =
      matchSectionHeader(line.text) ??
      matchLeadingSectionKeyword(line.text);
    if (header) {
      sections.push({ name: header, lines: [] });
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }

  return sections;
}

/**
 * Detect lines that start with a canonical section keyword and then carry
 * extra content on the same line. Required for DOCX shapes where the
 * section label and a date (or decoration) got joined into a single
 * paragraph during mammoth conversion — e.g.
 *   `EXPERIENCE 04/2021 - Present`
 * The trailing content is dropped; callers expect sections to be headers,
 * not header-plus-payload.
 */
function matchLeadingSectionKeyword(text: string): SectionName | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[:·•]+$/, "")
    .trim();
  if (!normalized) return null;
  // Must be short-ish so we don't claim a prose paragraph that happens to
  // start with "experience in …".
  if (normalized.length > 60) return null;
  for (const [name, keywords] of Object.entries(SECTION_KEYWORDS) as Array<
    [SectionName, readonly string[]]
  >) {
    for (const kw of keywords) {
      if (normalized === kw) return name; // already handled by matchSectionHeader, but harmless
      if (normalized.startsWith(`${kw} `) || normalized.startsWith(`${kw}\t`)) {
        return name;
      }
    }
  }
  return null;
}

/**
 * Convenience: parse markdown → lines → sections in one call. Used by the
 * DOCX / markdown-native Tier 1 path; the PDF path composes
 * `groupIntoLines` + either `splitIntoSectionsWithMarkdown` or
 * `splitIntoSections` directly so it can fall back cleanly.
 */
export function sectionizeMarkdown(markdown: string): {
  lines: PdfLine[];
  sections: PdfSection[];
} {
  const lines = markdownToPseudoLines(markdown);
  const sections = sectionizeMarkdownLines(lines);
  return { lines, sections };
}
