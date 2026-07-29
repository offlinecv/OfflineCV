// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
 *   - Flatten inline links `[label](url)` and autolinks `<url>` to `label url`
 *     (#610). Without this the bracket-paren syntax reaches every extractor
 *     verbatim, so a `.md` renders literal markdown in the exported PDF and
 *     `liftHeaderLabel` leaves an orphaned `[label]()` behind.
 *   - Resolve reference-style links — `[label][ref]`, `[label][]` and bare
 *     `[label]` — against the document's `[ref]: url` definition table, and
 *     blank the definition lines themselves (#611). Same `label url` output as
 *     the inline shape; the table and the reasoning live in
 *     `src/lib/markdown-link-refs.ts`, shared with `mdToPlainText` so the
 *     `rawText` and `markdown` readings of one `.md` stay in agreement.
 *   - Unescape turndown's backslash-escapes (`\_`, `\*`, `\[`, `\.`). These
 *     would otherwise break email / URL regex (e.g. `Jordan\_Lee@foo`
 *     parses as `_Lee@foo`).
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

import {
  extractLinkDefinitions,
  flattenAutolinks,
  resolveReferenceLinks,
  stripReferenceImages,
} from "../markdown-link-refs.ts";
import type { PdfLine, PdfSection } from "./line-model.ts";
import {
  matchSectionHeaderDetailed,
  SECTION_KEYWORDS,
  SPLIT_LETTER_NORMALIZABLE_SECTIONS,
  SPLIT_LETTER_RE,
  type SectionName,
} from "./regex.ts";

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

// Reference-style images (`![alt][ref]`, `![alt][]`, `![alt]`) cannot be
// stripped here: unlike the two shapes above they are not self-identifying —
// whether `![great]` is an image or literal prose depends on the document's
// `[ref]: url` definition table, which does not exist yet at this point in the
// pipeline. They are handled inside `flattenLinks` via the shared
// `stripReferenceImages`, one step later, once the table has been built.

// Inline markdown links: `[label](url)`, optionally with a CommonMark title
// (`[label](url "Title")`). Unlike images, BOTH halves carry signal — the label
// is the visible résumé text and the target is a real link — so we flatten to
// `label url` rather than dropping the ref (#610). The label class excludes
// newlines so an unmatched `[` on one line can never pair with a `](url)` on a
// later one; the target class excludes whitespace, which is also what makes a
// `)`-bearing URL out of scope (CommonMark requires those be angle-bracketed or
// escaped, and neither shape appears in a résumé).
const INLINE_LINK_RE = /\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

// Autolinks (`<https://…>`, `<jane@example.com>`) flatten through the shared
// `flattenAutolinks` in `../markdown-link-refs.ts` — see the import above. The
// rule lives there so `mdToPlainText` applies the identical one to `rawText`.

// Turndown backslash-escapes characters that have markdown meaning: `_`,
// `*`, `[`, `]`, `(`, `)`, `.`, `+`, `-`, `!`, `` ` ``, `#`, `>`. Undo the
// escapes that appear in contact data / prose. We keep `\n` as-is.
const BACKSLASH_ESCAPE_RE = /\\([_*[\]()!`#>.+-])/g;

/** Strip base64 image blobs and non-data image refs from markdown. */
function stripImages(markdown: string): string {
  return markdown
    .replace(DATA_URI_IMAGE_RE, "")
    .replace(ANY_IMAGE_RE, "");
}

/**
 * Flatten every markdown link shape to its plain-text reading — inline links
 * and autolinks (#610), then reference-style links (#611).
 *
 * Also where the REFERENCE-style image shape is dropped, because this is the
 * first point that has the definition table `stripReferenceImages` needs to
 * tell an image (`![badge][ci]`, with `[ci]` defined) from prose that merely
 * puts a `!` beside a bracket (`Grew revenue 40%![details][cat]`, with nothing
 * defining `[cat]`). Deciding it a step earlier, in `stripImages`, is not
 * possible without the table and deleted the prose.
 *
 * An image that the table does NOT resolve therefore survives into
 * `resolveReferenceLinks` — as does every image on `mdToPlainText`'s path,
 * which has no strip pass at all. Both are safe: the image alternative in that
 * scan consumes the whole usage and returns it untouched, so no image can
 * start flattening to `alt url` on either path.
 *
 * `label url` (not bare `label`) is deliberate: it mirrors the `$1 $2` rewrite
 * `mdToPlainText` (`src/lib/ingest/markdown.ts`) already applies to the
 * `rawText` half of a dropped `.md`, so the two representations of the same
 * file finally agree — that convergence is the actual invariant this restores.
 * (A degenerate empty-label `[](url)` emits the bare target rather than a
 * leading space, which is the only place the two rewrites differ.)
 * It also keeps the target visible to `liftHeaderLabel`, which lifts it into
 * `project.url` / `achievement.url` exactly as it does for a plain-text
 * résumé; emitting bare `label` would silently discard structured data.
 *
 * The internal ORDER is load-bearing (#611). Definition lines are blanked
 * first, so a `[ref]: <https://…>` target can never be mistaken for an
 * autolink and a definition label can never be resolved as a shortcut
 * reference against itself. Inline links go next, because they are the one
 * shape identified by a token the reference rule cannot see (`](`) — flattening
 * them first consumes their brackets, so `[label](url)` is never re-read as the
 * shortcut reference `[label]`. Reference resolution runs last, over text that
 * by then holds only brackets no other rule claimed.
 */
function flattenLinks(markdown: string): string {
  const { definitions, body } = extractLinkDefinitions(markdown);
  return resolveReferenceLinks(
    flattenAutolinks(
      stripReferenceImages(body, definitions).replace(
        INLINE_LINK_RE,
        (_m, label: string, url: string) =>
          label.trim() ? `${label} ${url}` : url,
      ),
    ),
    definitions,
  );
}

/** Undo turndown's backslash-escapes of markdown-meaningful characters. */
function unescapeBackslashes(markdown: string): string {
  return markdown.replace(BACKSLASH_ESCAPE_RE, (_m, ch: string) => ch);
}

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
function preprocessMarkdown(markdown: string): string {
  let out = markdown;
  out = stripImages(out);
  out = flattenLinks(out);
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
    // Synthetic mammoth-markdown lines carry no real PDF geometry, so there is
    // no meaningful vertical gap to measure; the gap-cue header path (#216) is
    // inert here by design (this path uses the markdown-anchored splitter).
    gapAbove: 0,
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
function markdownToPseudoLines(markdown: string): PdfLine[] {
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
function sectionizeMarkdownLines(lines: PdfLine[]): PdfSection[] {
  const sections: PdfSection[] = [{ name: "profile", lines: [] }];

  for (const line of lines) {
    const detailed = matchSectionHeaderDetailed(line.text);
    const current = sections[sections.length - 1].name;
    // #258 Layer B (markdown/DOCX path): an L2 anchor-fallback line that
    // re-matches the CURRENTLY open section is an institution entry under its
    // own header ("ACME PROFESSIONAL EDUCATION" under EDUCATION), not a new
    // boundary — retain it as content. Mirrors the PDF `classifyLine` gate;
    // same current-section safety (a DIFFERENT-section L2 header still opens).
    const header =
      detailed && detailed.viaAnchorFallback && detailed.section === current
        ? null
        : (detailed?.section ?? matchLeadingSectionKeyword(line.text));
    if (header) {
      sections.push({ name: header, rawHeading: line.text.trim(), lines: [] });
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
