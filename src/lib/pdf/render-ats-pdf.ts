// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * render-ats-pdf — the single-column, text-only ATS PDF draw engine (#171).
 *
 * Renders an `AtsResumeModel` to PDF bytes using pdf-lib. The brand font
 * (Poppins) is embedded when its vendored TTF bytes load and pdf-lib accepts
 * them (#314); on ANY failure the engine falls back to pdf-lib's built-in
 * Helvetica / Helvetica-Bold (`StandardFonts`), so a downloaded PDF is never
 * blocked by a font problem. Either way: no images, no rasterization, no
 * network egress — every glyph is selectable, searchable text, and the
 * Poppins bytes are bundled locally + fetched from the app's own origin (see
 * `loadFonts()` below), never a CDN.
 *
 * Layout: US Letter (612×792 pt), single column, ~54pt margins. The engine
 * tracks a `y` cursor from the top margin downward; when the next line would
 * cross the bottom margin it adds a page and resets the cursor. Long lines are
 * word-wrapped by measuring with `font.widthOfTextAtSize`; bullets get a "• "
 * marker with a hanging indent.
 *
 * Pagination is per line (`ensure`) PLUS keep-with-next reservations
 * (`ensureBlock`, #629): a section heading reserves its rule and the first
 * entry's keep-block, an entry header reserves all its wrapped header/sub-line
 * lines plus its first bullet's keep-opening, and a standalone bullet that wraps
 * reserves that same opening. So a heading or header can never be the last drawn
 * line on a page.
 *
 * A wrapped bullet gets BOTH halves of the break-position guarantee: at least
 * `BULLET_KEEP_LINES` of its lines sit on each side of any page break it
 * straddles — never one line alone at a page bottom (#629, the orphan half) and
 * never one line alone at a page top (#631, the widow half). The opening
 * reservation (`bulletKeepLines`) covers the first side and, for a bullet too
 * short to admit any legal split, the whole bullet; `ensureWrappedLine` places
 * the break for the second side, pushing the trailing lines forward together
 * rather than reserving the entire bullet — long bullets must stay divisible or
 * pages de-densify.
 *
 * The same "never exactly one alone" rule applies one level up, to the BULLETS of
 * an entry (#632): a page never opens on an entry's last bullet with nothing else
 * of that entry above it. The second-to-last bullet carries the last one's
 * keep-opening (`followKeepHeight`), so a break at that boundary moves both
 * bullets forward together. Only that one boundary is constrained — earlier
 * bullets paginate freely and no reservation ever spans the entry — because
 * reserving a whole entry is the density failure #630 measured at ~100pt.
 *
 * Two deliberate limits keep those reservations from costing page density: a
 * BODY-TEXT "header" (`headerBold: false` — the skills list) contributes at most
 * `BODY_HEADER_KEEP_LINES`, and a reservation taller than a whole page is
 * unsatisfiable and ignored outright. Every reservation is MEASURED by the same
 * wrapping code that draws it (`measureTextHeight` / `measureBulletLines` /
 * `measureHeaderRunsHeight` all share the draw path's line breaking), never
 * estimated. This is manual pdf-lib layout, not an HTML/Chromium print path —
 * CSS `break-after: avoid` / `orphans` / `widows` do not apply here.
 *
 * The `rgb()` colors here are PDF graphics-state values (black text, a muted
 * gray rule) — NOT Tailwind tokens. The style guard scans component/feature
 * code, not this draw module.
 */

import { loadPdfLibOnce, type PdfLibParts } from "./load-pdf-lib.ts";
import type { AtsResumeModel, AtsEntry } from "./ats-resume-model.ts";
import {
  autoBoldMetrics,
  EMPHASIS_OPEN,
  EMPHASIS_CLOSE,
} from "./auto-bold-metrics.ts";
import { toJsonResume } from "./to-json-resume.ts";
import { wrapWordsToLines } from "./text-wrap.ts";
import poppinsRegularUrl from "../../assets/fonts/Poppins-Regular.ttf?url";
import poppinsBoldUrl from "../../assets/fonts/Poppins-Bold.ttf?url";

// ── Page geometry (points) ────────────────────────────────────────────────────

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_BOTTOM = MARGIN;
// Drawable height of a FRESH page — `newPage()` resets the cursor to
// `PAGE_HEIGHT - MARGIN` and `ensure` stops at `CONTENT_BOTTOM`. This is exactly
// the tallest reservation {@link Layout.ensureBlock} can satisfy, so anything
// taller is unsatisfiable and must not be reserved (#629).
const USABLE_PAGE_HEIGHT = PAGE_HEIGHT - MARGIN - CONTENT_BOTTOM;

// ── Type scale (points) ───────────────────────────────────────────────────────
//
// Font-signal stance (#284, Part 2 — documented limitation, not a fix here).
// This engine DOES emit bold (Helvetica-Bold) and a real type scale — a role
// header is bold at SIZE_HEADER, its date muted at SIZE_SUB, bullets at SIZE_BODY.
// Those signals are, however, invisible to the round-trip: our own text-only
// parser classifies role title / company / bullet purely from text shape and
// x/y geometry — `groupIntoLines` collapses per-glyph `fontSize`/`fontName` away
// before `parseEntryBlocks` runs, so re-introducing bold buys re-segmentation
// nothing. That is why round-trip fidelity (#284) is carried entirely by the
// TEXT LAYOUT the model emits (the stacked "Title" / "Company · Location  Dates"
// shape in `ats-resume-model.ts`), not by these weights/sizes. Teaching the
// parser to consume font weight/size as a role-header signal is a larger,
// separate change (it would touch `groupIntoLines` retention + `entry-blocks`
// anchoring) and is intentionally out of scope here; if we later want
// font-aware parsing, file it as its own follow-up.
const SIZE_NAME = 18;
// Professional headline under the name (#425) — regular weight, sized between
// the name and the contact line so it reads as a subordinate title, not a
// second name.
const SIZE_HEADLINE = 11;
const SIZE_CONTACT = 9;
const SIZE_SECTION = 11;
const SIZE_HEADER = 10.5;
const SIZE_SUB = 9.5;
const SIZE_BODY = 10;

// Line-height multiplier applied to the font size for vertical advance.
const LINE_GAP = 1.25;
// Extra vertical breathing room (points) between blocks.
const GAP_AFTER_CONTACT = 10;
const GAP_BEFORE_SECTION = 12;
const GAP_AFTER_RULE = 6;
const GAP_BETWEEN_ENTRIES = 7;
const GAP_AFTER_HEADER = 2;
// Vertical space the section-heading rule consumes (`drawRule`). Named because
// the keep-with-next reservation for a section heading must include it (#629) —
// the heading, its rule, and the first line of its content move as one unit.
const RULE_HEIGHT = 2;

const BULLET_MARKER = "• ";
const BULLET_INDENT = 12; // hanging-indent width for wrapped bullet lines

// Minimum drawn lines of a wrapped bullet that must land on EACH side of a page
// break it straddles — the orphan half (#629, no lone line at a page bottom) and
// the widow half (#631, no lone line at a page top) of one symmetric rule. It
// follows that the legal split positions of an N-line bullet are exactly
// `[BULLET_KEEP_LINES, N - BULLET_KEEP_LINES]`, an interval that is EMPTY when
// `N < 2 * BULLET_KEEP_LINES` — which is why a three-line bullet is indivisible
// and has to move whole (see `bulletKeepLines`).
const BULLET_KEEP_LINES = 2;

/**
 * How many of a bullet's `total` drawn lines its OPENING reservation must keep
 * together (#629/#631).
 *
 * A bullet with no legal split position (`total < 2 * BULLET_KEEP_LINES`) is
 * indivisible: every break inside it would strand fewer than `BULLET_KEEP_LINES`
 * lines on one side, so the reservation is the whole bullet and the break falls
 * before it. That is the three-line case #631 is about — reserving two lines
 * draws two and leaves the third alone at the next page's top.
 *
 * A longer bullet reserves ONLY its orphan-safe opening and stays divisible;
 * {@link Layout.ensureWrappedLine} then places the break so the tail keeps
 * `BULLET_KEEP_LINES` lines too. Reserving such a bullet whole would de-densify
 * pages by its full height — the failure mode #630 measured on the skills list.
 */
function bulletKeepLines(total: number): number {
  return total < 2 * BULLET_KEEP_LINES ? total : BULLET_KEEP_LINES;
}

// Minimum blank gutter (pt) kept between the wrapped header text and the
// flush-right date tail (#436). Without a reserve the header text wraps to the
// full content width and its last word runs UNDER the date on re-extraction
// ("…Inc." + "Mar. 2021" → "Inc.Mar. 2021"), corrupting the company on
// round-trip. Reserving the date's measured width + this gutter forces the
// header to wrap BEFORE the date column.
const DATE_COLUMN_GAP = 8;

// The middot list/org-line join separator emitted by ats-resume-model.ts
// (skills, "Company · Location", "Institution · Location", ...). Wrap logic
// treats each middot-delimited segment as atomic — see `wrap()` (#301).
const MIDDOT_SEGMENT_SEP = " · ";

// ── WinAnsi sanitization (#295) ───────────────────────────────────────────────
//
// pdf-lib's StandardFonts (Helvetica et al.) only encode WinAnsi (Windows-1252).
// `PDFPage.drawText` throws `WinAnsi cannot encode "…"` on any code point
// outside that codec — e.g. U+2192 (→) or U+2010 (the *Unicode* hyphen,
// distinct from ASCII "-"). Parsed résumé text is arbitrary and routinely
// contains such glyphs, so every string must be sanitized before it reaches
// `drawText`.
//
// Windows-1252's upper range (0x80-0x9F) already assigns real Unicode code
// points to en/em dash, curly quotes, bullet, and ellipsis (e.g. U+2014 em
// dash IS valid WinAnsi) — those must pass through unchanged, not get
// transliterated, or round-trip fidelity (#284) regresses. Only glyphs with
// NO WinAnsi representation (arrows, the Unicode hyphen variants, ligatures,
// exotic whitespace, zero-width marks) get transliterated to a safe ASCII
// equivalent; anything left over is replaced with "?". Never throws.

/** Code points WinAnsi (cp1252 0x80-0x9F) assigns to real Unicode glyphs. */
const WINANSI_UPPER_RANGE = new Set([
  0x20ac, // € euro
  0x201a, // ‚ low single quote
  0x0192, // ƒ florin
  0x201e, // „ low double quote
  0x2026, // … ellipsis
  0x2020, // † dagger
  0x2021, // ‡ double dagger
  0x02c6, // ˆ circumflex
  0x2030, // ‰ per mille
  0x0160, // Š
  0x2039, // ‹ single left angle quote
  0x0152, // Œ
  0x017d, // Ž
  0x2018, // ‘ left single quote
  0x2019, // ’ right single quote
  0x201c, // “ left double quote
  0x201d, // ” right double quote
  0x2022, // • bullet
  0x2013, // – en dash
  0x2014, // — em dash
  0x02dc, // ˜ small tilde
  0x2122, // ™ trademark
  0x0161, // š
  0x203a, // › single right angle quote
  0x0153, // œ
  0x017e, // ž
  0x0178, // Ÿ
]);

const WINANSI_TRANSLITERATIONS: Record<string, string> = {
  "→": "->", // rightwards arrow (not in WinAnsi)
  "←": "<-", // leftwards arrow
  "↔": "<->", // left-right arrow
  "‐": "-", // Unicode hyphen (distinct from ASCII "-", not in WinAnsi)
  "‑": "-", // non-breaking hyphen
  "‒": "-", // figure dash
  "―": "-", // horizontal bar
  "‣": "-", // triangular bullet
  "◦": "-", // white bullet
  " ": " ", // figure space
  " ": " ", // en quad
  " ": " ", // em quad
  " ": " ", // en space
  " ": " ", // em space
  " ": " ", // three-per-em space
  " ": " ", // four-per-em space
  " ": " ", // six-per-em space
  " ": " ", // punctuation space
  " ": " ", // thin space
  " ": " ", // hair space
  " ": " ", // narrow NBSP
  " ": " ", // medium math space
  "　": " ", // ideographic space
  "​": "", // zero-width space
  "‌": "", // zero-width non-joiner
  "‍": "", // zero-width joiner
  "﻿": "", // BOM / zero-width no-break space
  "ﬀ": "ff", // ff ligature
  "ﬁ": "fi", // fi ligature
  "ﬂ": "fl", // fl ligature
  "ﬃ": "ffi", // ffi ligature
  "ﬄ": "ffl", // ffl ligature
};

/**
 * Sanitize `text` to the WinAnsi (Windows-1252) subset that pdf-lib's
 * StandardFonts can encode. Glyphs WinAnsi already supports (en/em dash,
 * curly quotes, bullet, ellipsis, NBSP, ...) pass through unchanged; glyphs
 * with no WinAnsi representation are transliterated to a safe ASCII
 * equivalent (see `WINANSI_TRANSLITERATIONS`); anything left is replaced
 * with "?". Never throws.
 */
export function toWinAnsi(text: string): string {
  if (!text) return text;
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;

    // Printable ASCII + Latin-1 supplement: WinAnsi covers this range as-is
    // (includes NBSP at U+00A0).
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
      continue;
    }
    if (code >= 0xa0 && code <= 0xff) {
      out += ch;
      continue;
    }
    // Tab/newline/carriage-return: keep as-is (whitespace, harmless to draw).
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += ch;
      continue;
    }
    // Real WinAnsi upper-range glyphs (en/em dash, curly quotes, bullet, ...)
    // -- pass through unchanged so round-trip fidelity is preserved.
    if (WINANSI_UPPER_RANGE.has(code)) {
      out += ch;
      continue;
    }
    const replacement = WINANSI_TRANSLITERATIONS[ch];
    if (replacement !== undefined) {
      out += replacement;
      continue;
    }
    // Other C0/C1 control characters: drop silently.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    // Anything else (other Unicode blocks, emoji, CJK, etc.) has no WinAnsi
    // representation -- degrade the glyph instead of crashing.
    out += "?";
  }
  return out;
}

type RGB = ReturnType<PdfLibParts["rgb"]>;
type Doc = Awaited<ReturnType<PdfLibParts["PDFDocument"]["create"]>>;
type Page = ReturnType<Doc["addPage"]>;
type PdfFont = Awaited<ReturnType<Doc["embedFont"]>>;

// ── Poppins font embed (#314) ─────────────────────────────────────────────────
//
// The Poppins TTF bytes are bundled as Vite assets (imported via `?url` above
// — the same mechanism `src/main.tsx` uses for the pdfjs worker) and fetched
// from the app's own bundled-asset origin at download time. That `fetch()`
// never leaves the browser's own origin, so it does NOT violate offlinecv's
// zero-egress guarantee — this is loading a local asset, not calling a font
// CDN (e.g. `fonts.gstatic.com`), which is explicitly forbidden here.
// Cached module-scoped so repeat downloads reuse the same fetched bytes.
let poppinsBytesPromise: Promise<{
  regular: ArrayBuffer;
  bold: ArrayBuffer;
}> | null = null;

function loadPoppinsBytes(): Promise<{
  regular: ArrayBuffer;
  bold: ArrayBuffer;
}> {
  if (!poppinsBytesPromise) {
    poppinsBytesPromise = Promise.all([
      fetch(poppinsRegularUrl).then((res) => res.arrayBuffer()),
      fetch(poppinsBoldUrl).then((res) => res.arrayBuffer()),
    ]).then(([regular, bold]) => ({ regular, bold }));
  }
  return poppinsBytesPromise;
}

/**
 * Load the `{ regular, bold }` font pair the renderer draws with. Tries
 * embedding the vendored Poppins TTFs (registering `@pdf-lib/fontkit` first,
 * since pdf-lib's built-in `embedFont` can only parse the 14 standard fonts
 * without it); on ANY failure — fetch error, corrupt bytes, an embed
 * rejection — falls back to pdf-lib's built-in Helvetica / Helvetica-Bold, so
 * a font problem never blocks the download. `isEmbedded` tells the caller
 * whether Poppins is actually in use: only then can `toWinAnsi()`
 * sanitization be skipped (StandardFonts can only encode WinAnsi; embedded
 * Poppins encodes the glyphs directly — see `toWinAnsi()` above).
 */
async function loadFonts(
  doc: Doc,
  parts: PdfLibParts,
): Promise<{ regular: PdfFont; bold: PdfFont; isEmbedded: boolean }> {
  try {
    // `@pdf-lib/fontkit` ships no usable default-export `.d.ts` shape, so it
    // is typed `unknown` in `PdfLibParts` and cast here at the one call site
    // that hands it to pdf-lib's `registerFontkit` — the narrowest possible
    // untyped surface, rather than threading `any` through load-pdf-lib.ts.
    doc.registerFontkit(parts.fontkit as Parameters<Doc["registerFontkit"]>[0]);
    const bytes = await loadPoppinsBytes();
    // `subset: true` prunes the embedded font to only the glyphs the résumé
    // actually uses — a downloaded PDF touches ~60–80 glyphs, so this trims the
    // full Poppins Regular + Bold (a few hundred KB) down to what's on the page.
    // Orthogonal to the skip-`toWinAnsi()` path: subsetting prunes unused
    // glyphs, it doesn't change the embedded-encoding logic.
    const regular = await doc.embedFont(bytes.regular, { subset: true });
    const bold = await doc.embedFont(bytes.bold, { subset: true });
    return { regular, bold, isEmbedded: true };
  } catch (err) {
    console.warn(
      "Poppins font embed failed, falling back to Helvetica:",
      err,
    );
  }
  const regular = await doc.embedFont(parts.StandardFonts.Helvetica);
  const bold = await doc.embedFont(parts.StandardFonts.HelveticaBold);
  return { regular, bold, isEmbedded: false };
}

/**
 * Wrap a list of middot-delimited segments, keeping each segment intact.
 * The wrap point only falls between segments (rejoined with
 * `MIDDOT_SEGMENT_SEP`); a segment wider than `maxWidth` on its own falls
 * back to `wrapWordsToLines` for that segment only. Exported for testing.
 */
export function wrapSegmentsToLines(
  segments: string[],
  font: PdfFont,
  size: number,
  maxWidth: number,
): string[] {
  if (segments.length === 0) return [];
  const lines: string[] = [];
  // Seed `current` from the empty string and run EVERY segment — including
  // segments[0] — through the same width check + word-wrap fallback, so an
  // overlong first segment (e.g. a long "Company · Location" org line whose
  // company name alone exceeds maxWidth) is wrapped rather than emitted verbatim.
  let current = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const candidate =
      current === "" ? seg : `${current}${MIDDOT_SEGMENT_SEP}${seg}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    if (font.widthOfTextAtSize(seg, size) > maxWidth) {
      // `wrapWordsToLines` never loops on a single word wider than maxWidth
      // (it emits it as its own line), so this terminates.
      const subLines = wrapWordsToLines(
        seg.split(/\s+/).filter(Boolean),
        font,
        size,
        maxWidth,
      );
      lines.push(...subLines.slice(0, -1));
      current = subLines[subLines.length - 1] ?? "";
    } else {
      current = seg;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Parse a bullet string carrying sentinel emphasis markers (from
 * `autoBoldMetrics` — the U+E000 / U+E001 Private-Use-Area pair, NOT literal
 * `**`) into an ordered list of `{ text, bold }` runs. The sentinels are
 * STRIPPED — no run's text contains them — so drawing the runs reproduces the
 * original glyphs exactly, including any literal `**` in the source, which is
 * inert here and drawn verbatim (round-trip-neutral, #284/#425). Text outside
 * any marker is `bold: false`; text inside a sentinel span is `bold: true`.
 * Exported for testing.
 */
export function parseBoldRuns(text: string): Array<{ text: string; bold: boolean }> {
  const runs: Array<{ text: string; bold: boolean }> = [];
  const re = new RegExp(`${EMPHASIS_OPEN}([^${EMPHASIS_CLOSE}]+?)${EMPHASIS_CLOSE}`, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false });
  return runs;
}

/** One drawable, pre-measured piece of a word carrying its own bold flag. */
type WordChunk = { str: string; bold: boolean; width: number };

/**
 * Flatten bold runs into words (each a list of same-font chunks). Splitting on
 * whitespace and re-inserting a single inter-word space reproduces the bullet's
 * single-spaced text; a bold boundary with no surrounding space (e.g.
 * "increase**40%**") keeps both chunks in one word, so no space is introduced
 * between them. Widths are measured here so the draw loop is pure layout.
 */
function groupRunsIntoWords(
  runs: Array<{ text: string; bold: boolean }>,
  size: number,
  fonts: { regular: PdfFont; bold: PdfFont },
  sanitize: boolean,
): WordChunk[][] {
  const words: WordChunk[][] = [];
  let current: WordChunk[] = [];
  const flush = () => {
    if (current.length) {
      words.push(current);
      current = [];
    }
  };
  for (const run of runs) {
    const value = sanitize ? toWinAnsi(run.text) : run.text;
    const font = run.bold ? fonts.bold : fonts.regular;
    for (const piece of value.split(/(\s+)/)) {
      if (piece === "") continue;
      if (/^\s+$/.test(piece)) {
        flush();
      } else {
        current.push({
          str: piece,
          bold: run.bold,
          width: font.widthOfTextAtSize(piece, size),
        });
      }
    }
  }
  flush();
  return words;
}

/**
 * Options for {@link Layout.drawText}. Named (rather than inlined in the
 * signature) so {@link Layout.measureTextHeight} can take the IDENTICAL options
 * — a keep-with-next reservation (#629) is only sound if it is measured by the
 * same wrapping decision that will draw it.
 */
type DrawTextOpts = {
  bold?: boolean;
  size?: number;
  color?: RGB;
  x?: number;
  hangingIndent?: number;
  uppercase?: boolean;
  atomicSegments?: boolean;
  /** A short tail (a role/degree date range) drawn FLUSH-RIGHT, regular
   *  weight, on the first wrapped line's baseline (#425). */
  rightText?: string;
  rightColor?: RGB;
  rightSize?: number;
  /** Register a clickable URI annotation over the whole first line (#425). */
  linkUrl?: string;
  /** Register a clickable URI annotation over each `display` substring found
   *  in the first line (#425 — the contact line's link slugs). Applied only
   *  when the text fits on ONE line, so measured offsets are accurate. */
  linkSpans?: Array<{ display: string; href: string }>;
  /** Paginate the wrapped lines under widow control (#631) — see
   *  {@link Layout.ensureWrappedLine}. Set only by {@link Layout.drawBullet}; a
   *  header/contact/summary block keeps the plain per-line behaviour. Not an
   *  input to wrapping, so {@link Layout.measureTextHeight} ignores it. */
  widowControl?: boolean;
  /** Height (pt) that must land on the same page as this block's FINAL drawn
   *  line — the NEXT bullet's keep-opening (#632). Set only by
   *  {@link Layout.drawBullet}, and only for an entry's second-to-last bullet.
   *  Like `widowControl`, not an input to wrapping. */
  followKeepHeight?: number;
};

/**
 * Mutable cursor + page state threaded through the draw routines. We keep one
 * "current page" and append new pages as the cursor overflows.
 */
class Layout {
  page: Page;
  y: number;

  constructor(
    private doc: Doc,
    private fonts: { regular: PdfFont; bold: PdfFont },
    private black: RGB,
    private gray: RGB,
    // Literal-string constructor from pdf-lib, used to build Link-annotation
    // `/URI` values (#425 — see `registerLink`).
    private pdfString: PdfLibParts["PDFString"],
    // When true (the default — the Helvetica fallback), every string is run
    // through `toWinAnsi()` before drawing, since StandardFonts can only
    // encode WinAnsi (#295). When false (a custom font — Poppins — embedded
    // successfully), sanitization is skipped: the embedded font encodes the
    // glyphs directly, so skipping it avoids needlessly degrading
    // Latin-Extended glyphs Poppins can render but WinAnsi can't (e.g. "ł").
    private sanitize = true,
  ) {
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private newPage() {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  /**
   * Register a clickable URI link annotation over the rect `[x0,y0,x1,y1]` (all
   * in pdf-lib's bottom-origin page space, matching `this.y`) on the current
   * page (#425). The annotation lives in the page's `/Annots` array — OUTSIDE
   * the content stream — so it adds a clickable overlay without changing a
   * single drawn glyph: `pdftotext` / pdfjs text extraction is untouched and the
   * parse→export→re-parse text round-trip stays byte-for-byte identical.
   * `context.obj` coerces a JS string to a `/Name`, so the URI is wrapped in an
   * explicit `PDFString`; `Border [0 0 0]` suppresses the legacy visible box.
   */
  private registerLink(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    url: string,
  ) {
    const context = this.doc.context;
    const annot = context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x0, y0, x1, y1],
      Border: [0, 0, 0],
      A: context.obj({ Type: "Action", S: "URI", URI: this.pdfString.of(url) }),
    });
    this.page.node.addAnnot(context.register(annot));
  }

  /** Ensure room for `height` pt; add a page if the cursor would overflow. */
  private ensure(height: number) {
    if (this.y - height < CONTENT_BOTTOM) this.newPage();
  }

  /**
   * Reserve `height` pt for an INDIVISIBLE block — a keep-with-next group such
   * as "entry header + its first bullet line" or "section heading + rule + one
   * line of content" (#629). Arithmetically identical to the per-line
   * {@link ensure}; the difference is the caller's contract, not the maths.
   * `ensure` is handed one line and may legitimately break right after it,
   * whereas this is handed a whole group and guarantees the group STARTS on a
   * page that can hold all of it — so the per-line `ensure` calls that draw the
   * group cannot fire a second break inside it.
   *
   * A reservation TALLER than a whole empty page is UNSATISFIABLE, and is
   * therefore ignored outright rather than broken to (#629). Deferring it cannot
   * make it fit, and doing so actively causes the defect this method exists to
   * prevent: on a "heading + oversized first entry" pair, the heading's
   * reservation breaks to a fresh page, the entry's own equally-unsatisfiable
   * reservation immediately breaks again, and the heading is left alone on a page
   * of its own — a wasted page plus the exact stranding AC3 forbids. Ignoring it
   * hands the block back to the per-line {@link ensure} calls that draw it, which
   * fill the current page and break naturally. The comparison is against
   * {@link USABLE_PAGE_HEIGHT}, so a block exactly that tall still counts as
   * satisfiable.
   */
  ensureBlock(height: number) {
    if (height > USABLE_PAGE_HEIGHT) return;
    this.ensure(height);
  }

  /**
   * Paginate ONE line (`index` of `total`) of a wrapped block, honouring widow
   * control (#631).
   *
   * Without it, or on a block too short to split legally, this is the plain
   * per-line {@link ensure}. With it, the line `BULLET_KEEP_LINES` from the end
   * reserves the whole TAIL rather than itself: if the tail fits, the block
   * cannot end with fewer than `BULLET_KEEP_LINES` lines on the next page; if it
   * does not, the break happens HERE instead of one line later, carrying the tail
   * forward as a unit. Only that one line needs the wider reservation — every
   * earlier line breaking naturally leaves the tail intact, and every later line
   * is inside a tail already placed.
   *
   * The other side of the break is guaranteed by the caller's OPENING
   * reservation ({@link bulletKeepLines}): it committed `BULLET_KEEP_LINES` lines
   * to the page the block starts on, and a block reaching this branch has
   * `total >= 2 * BULLET_KEEP_LINES`, so the lines before the tail are at least
   * that many. A block whose own height exceeds a page simply breaks more than
   * once; a fresh page always holds a tail this short, so the reservation here
   * can never be unsatisfiable.
   *
   * `followKeep` (#632) is height that must land on the SAME page as this block's
   * FINAL line — the next bullet's keep-opening. The tail reservation is the one
   * that covers that final line for a DIVISIBLE block, so it is also the one that
   * must carry the follow: either both fit here, or the break moves up and the
   * tail travels forward together with what follows it. An indivisible block
   * never reaches this branch — its opening reservation covers its final line, so
   * {@link drawBullet} folds the follow in there instead. Bounded by construction:
   * `BULLET_KEEP_LINES` plus at most `2 * BULLET_KEEP_LINES - 1` follow lines,
   * far under a page, so this stays satisfiable.
   */
  private ensureWrappedLine(
    index: number,
    total: number,
    lineHeight: number,
    opts: { widowControl?: boolean; followKeepHeight?: number },
  ) {
    const startsTail =
      (opts.widowControl ?? false) &&
      total >= 2 * BULLET_KEEP_LINES &&
      index === total - BULLET_KEEP_LINES;
    this.ensure(
      startsTail
        ? BULLET_KEEP_LINES * lineHeight + (opts.followKeepHeight ?? 0)
        : lineHeight,
    );
  }

  advance(points: number) {
    this.y -= points;
  }

  /**
   * Word-wrap `text` to `maxWidth` using the given font/size.
   *
   * When `atomicSegments` is `true` AND `text` contains the middot segment
   * separator (`" · "` — used to join skills, see `ats-resume-model.ts`),
   * each middot-delimited segment is wrapped as an ATOMIC unit: the wrap
   * point can only fall BETWEEN segments, never inside one. Plain `\s+`-word
   * wrapping used to let the break land mid-segment (e.g. inside the
   * multi-word skill "Cloud Data Warehousing"), which re-parsed as two
   * skills instead of one (#301). A single segment that alone exceeds
   * `maxWidth` still falls back to per-word wrapping so a pathologically
   * long segment doesn't overflow the page width.
   *
   * Callers must opt IN to atomic wrapping — it is no longer decided by
   * `text.includes(MIDDOT_SEGMENT_SEP)` alone. A 3+ segment "keyword ·
   * statement · year" achievement HEADER uses the middot purely as a display
   * joiner, so it opts OUT: atomic wrapping there would strand a whole segment
   * — the lone keyword or year — on its own line (#307). But the skills entry
   * (re-parsed segment-by-segment, #301) and the "Company · Location  Dates" /
   * "Institution · Location  Dates" sub-lines opt IN — there the middot is a
   * re-parse-critical boundary and word-wrapping inside a multi-word location
   * would fragment it on re-parse.
   */
  private wrap(
    text: string,
    font: PdfFont,
    size: number,
    maxWidth: number,
    atomicSegments = false,
  ): string[] {
    if (atomicSegments && text.includes(MIDDOT_SEGMENT_SEP)) {
      return wrapSegmentsToLines(
        text.split(MIDDOT_SEGMENT_SEP).filter((s) => s.length > 0),
        font,
        size,
        maxWidth,
      );
    }
    return wrapWordsToLines(
      text.split(/\s+/).filter(Boolean),
      font,
      size,
      maxWidth,
    );
  }

  /**
   * Wrap `value` at `maxWidth`, but reserve `rightReserve` pt for a flush-right
   * tail (the header's date column, #436) — and ONLY when the first line would
   * actually reach it. Wrapping at the full width first and re-wrapping just the
   * colliding case keeps every header that already fits one line (or wraps clear
   * of the date) byte-identical; a blanket reserve instead forces borderline
   * headers to wrap and re-parse worse, regressing fixtures whose reconstructed
   * header sat just shy of the date column. When the first line DOES overrun the
   * date, its trailing word extracts glued to the date ("…Inc." + "Mar. 2021" →
   * "Inc.Mar. 2021"), corrupting the company; re-wrapping at the reserved width
   * (atomic, so "Company, Location" moves whole rather than splitting mid-name)
   * restores the round-trip. A zero reserve is a plain {@link wrap}.
   */
  private wrapReservingRight(
    value: string,
    font: PdfFont,
    size: number,
    maxWidth: number,
    atomic: boolean,
    rightReserve: number,
  ): string[] {
    const lines = this.wrap(value, font, size, maxWidth, atomic);
    if (
      rightReserve > 0 &&
      font.widthOfTextAtSize(lines[0], size) > maxWidth - rightReserve
    ) {
      return this.wrap(value, font, size, maxWidth - rightReserve, atomic);
    }
    return lines;
  }

  /**
   * Resolve everything a {@link drawText} call needs BEFORE it touches the page:
   * the font, the sanitized value, the flush-right tail, and the wrapped lines.
   * Shared with {@link measureTextHeight} so a keep-with-next reservation (#629)
   * is measured by exactly the wrapping that will draw it — one layout pass'
   * worth of logic, called once per measure and once per draw, never forked into
   * a second implementation that could disagree.
   */
  private resolveDrawLines(
    text: string,
    opts: DrawTextOpts,
  ): {
    lines: string[];
    font: PdfFont;
    size: number;
    x: number;
    lineHeight: number;
    rValue: string;
    rSize: number;
  } {
    const size = opts.size ?? SIZE_BODY;
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    const x = opts.x ?? MARGIN;
    // Sanitize LAST — after the case transform — so a case-expansion can never
    // produce an un-encodable glyph downstream. `toUpperCase()` maps some
    // WinAnsi-native lowercase letters to glyphs with NO WinAnsi representation
    // (e.g. µ U+00B5 → Μ U+039C Greek Capital Mu, ſ → S, ﬁ ligature → FI), so
    // uppercasing BEFORE toWinAnsi would let `drawText` throw `WinAnsi cannot
    // encode "Μ"` and reintroduce the #295 crash. Uppercase the raw text, then
    // sanitize the result — toWinAnsi is the final step before measure/draw.
    // Skipped entirely on the embedded-Poppins path (`this.sanitize === false`
    // — see the constructor doc) since Poppins encodes the glyphs directly.
    const cased = opts.uppercase ? text.toUpperCase() : text;
    const value = this.sanitize ? toWinAnsi(cased) : cased;
    const atomic = opts.atomicSegments ?? false;
    const maxWidth = CONTENT_WIDTH - (x - MARGIN);
    const rSize = opts.rightSize ?? size;
    const rValue = opts.rightText
      ? this.sanitize
        ? toWinAnsi(opts.rightText)
        : opts.rightText
      : "";
    const rightReserve = rValue
      ? this.fonts.regular.widthOfTextAtSize(rValue, rSize) + DATE_COLUMN_GAP
      : 0;

    // Reserve the flush-right date column when the header collides with it
    // (#436) — see wrapReservingRight for why this is collision-gated, not a
    // blanket reserve.
    const lines = this.wrapReservingRight(
      value,
      font,
      size,
      maxWidth,
      atomic,
      rightReserve,
    );
    return { lines, font, size, x, lineHeight: size * LINE_GAP, rValue, rSize };
  }

  /**
   * Height (pt) a {@link drawText} call with the SAME `text`/`opts` will
   * occupy — its wrapped line count times its line height. Pure: measures
   * without touching the page or the cursor. The keep-with-next reservations
   * (#629) are built from this, so a reservation can never be a guess.
   */
  measureTextHeight(text: string, opts: DrawTextOpts = {}): number {
    const { lines, lineHeight } = this.resolveDrawLines(text, opts);
    return lines.length * lineHeight;
  }

  /**
   * Draw a wrapped block of text. `x` is the left edge; `hangingIndent`
   * indents continuation lines (for bullet hanging indent). `atomicSegments`
   * opts into segment-atomic middot wrapping (see `wrap()` above) — leave it
   * unset/`false` for ordinary header/entry lines; the skills entry is the
   * only caller that sets it `true` (#307).  Returns nothing; mutates the
   * cursor and paginates as needed.
   */
  drawText(text: string, opts: DrawTextOpts = {}) {
    const { lines, font, size, x, lineHeight, rValue, rSize } =
      this.resolveDrawLines(text, opts);
    const color = opts.color ?? this.black;
    const hanging = opts.hangingIndent ?? 0;
    const singleLine = lines.length === 1;
    for (let i = 0; i < lines.length; i++) {
      this.ensureWrappedLine(i, lines.length, lineHeight, opts);
      const lineX = i === 0 ? x : x + hanging;
      const topY = this.y;
      this.page.drawText(lines[i], {
        x: lineX,
        y: topY - size,
        size,
        font,
        color,
      });
      if (i === 0) {
        this.decorateFirstLine(opts, {
          line: lines[0],
          lineX,
          topY,
          font,
          size,
          color,
          rValue,
          rSize,
          singleLine,
        });
      }
      this.advance(lineHeight);
    }
  }

  /**
   * Draw the first line's optional decorations: the flush-right date tail, a
   * whole-line link annotation, and per-substring link annotations (#425).
   *
   * Split out of {@link drawText} purely to keep that method's line loop
   * readable — all three apply only to `i === 0`, none touches the cursor, and
   * none participates in wrapping or pagination. Extracting them therefore
   * cannot drift measurement from drawing (the #629 invariant): the geometry
   * they consume is passed in, already resolved by `resolveDrawLines`.
   */
  private decorateFirstLine(
    opts: DrawTextOpts,
    geom: {
      line: string;
      lineX: number;
      topY: number;
      font: PdfFont;
      size: number;
      color: RGB;
      rValue: string;
      rSize: number;
      singleLine: boolean;
    },
  ) {
    const { line, lineX, topY, font, size, color, rValue, rSize } = geom;
    // Flush-right date tail on the first line's baseline (#425), right-aligned
    // to the content margin and drawn regular-weight/muted.
    if (opts.rightText) {
      const rFont = this.fonts.regular;
      const rX = PAGE_WIDTH - MARGIN - rFont.widthOfTextAtSize(rValue, rSize);
      this.page.drawText(rValue, {
        x: rX,
        y: topY - size,
        size: rSize,
        font: rFont,
        color: opts.rightColor ?? color,
      });
    }
    // Clickable annotation over the whole first line (#425).
    if (opts.linkUrl) {
      const w = font.widthOfTextAtSize(line, size);
      this.registerLink(lineX, topY - size, lineX + w, topY, opts.linkUrl);
    }
    // Per-substring link annotations (#425 contact-line slugs). Measure against
    // the DRAWN first line (whitespace already collapsed by wrap); skip if the
    // text wrapped so offsets stay accurate. Drawn glyphs are untouched either
    // way, so the text round-trip is unaffected.
    //
    // Search from a running offset that advances past each matched span, so a
    // display that is a SUBSTRING of an earlier part (e.g. website slug
    // `example.com` inside email `jane@example.com`, and the email is drawn
    // first) can't match inside that earlier part and land the rect on the wrong
    // text. The spans are supplied in draw order, so a monotonic offset maps each
    // to its own occurrence.
    if (!opts.linkSpans || !geom.singleLine) return;
    let searchFrom = 0;
    for (const span of opts.linkSpans) {
      const idx = line.indexOf(span.display, searchFrom);
      if (idx < 0) continue;
      const x0 = lineX + font.widthOfTextAtSize(line.slice(0, idx), size);
      const x1 = x0 + font.widthOfTextAtSize(span.display, size);
      this.registerLink(x0, topY - size, x1, topY, span.href);
      searchFrom = idx + span.display.length;
    }
  }

  /**
   * Draw one bullet. When `autoBoldMetrics` finds no quantifiable metric, this
   * takes the legacy single-string path (byte-identical to the pre-#425
   * renderer, so metric-free bullets are unchanged). When metrics are present,
   * it draws per-word runs switching between the regular and bold fonts,
   * preserving bold across wrapped lines. Either way the DRAWN text carries no
   * sentinel markers, so the round-trip text is byte-identical to the source —
   * including any literal `**` a user typed, which is drawn verbatim (#284/#425).
   */
  drawBullet(
    text: string,
    size: number,
    hangingIndent: number,
    opts: { alreadyReserved?: boolean; followKeepHeight?: number } = {},
  ) {
    // Break-position control (#629 orphan half, #631 widow half): a wrapped
    // bullet reserves `bulletKeepLines` lines before it starts, so it can never
    // leave its first line alone at a page bottom — and, when it is too short to
    // split legally at all, that reservation IS its full height, so it can never
    // leave its last line alone at a page top either. A longer bullet stays
    // divisible; `widowControl` below places its break so the tail keeps
    // `BULLET_KEEP_LINES` lines too. A one-line bullet keeps the plain per-line
    // behaviour.
    //
    // `alreadyReserved` is the entry header's first bullet — `entryKeepHeight`
    // already folded THIS reservation into the keep-block, so re-reserving here
    // would move the bullet and STRAND the header that reservation just
    // guaranteed against. Per #629's composition decision the two rules compose
    // rather than sum: both call `bulletKeepLines`, so neither reserves a long
    // bullet's FULL height. Widow control is unaffected either way — it lives in
    // the draw loop, not the reservation, so the first bullet gets it too.
    //
    // `followKeepHeight` (#632) is the NEXT bullet's keep-opening, and the rule
    // placing it is one line: whichever reservation covers THIS bullet's final
    // drawn line must also cover the follow. For an INDIVISIBLE bullet
    // (`bulletKeepLines(total) === total`) that is this opening reservation, so it
    // is added here; for a divisible one it is the tail reservation, so
    // {@link ensureWrappedLine} adds it instead and this opening stays exactly
    // what #629/#631 made it. The two cases are exclusive — never summed — so the
    // follow is reserved once and the reservation stays bounded to two bullets'
    // keep-openings, never the whole entry.
    const lineHeight = size * LINE_GAP;
    const followKeep = opts.followKeepHeight ?? 0;
    if (!opts.alreadyReserved) {
      const total = this.measureBulletLines(text, size, hangingIndent);
      const keep = bulletKeepLines(total);
      const height = keep * lineHeight + (keep === total ? followKeep : 0);
      // A bare one-line reservation is what the first line's own `ensure` already
      // does, so reserve only when the block asks for more than that.
      if (height > lineHeight) this.ensureBlock(height);
    }
    const marked = autoBoldMetrics(text);
    if (!marked.includes(EMPHASIS_OPEN)) {
      this.drawText(`${BULLET_MARKER}${text}`, {
        size,
        hangingIndent,
        widowControl: true,
        followKeepHeight: followKeep,
      });
      return;
    }
    this.drawRuns(parseBoldRuns(marked), size, hangingIndent, {
      widowControl: true,
      followKeepHeight: followKeep,
    });
  }

  /**
   * How many lines {@link drawBullet} will draw for the same arguments, counted
   * through whichever wrapping path will draw it (#629). A LINE COUNT rather
   * than a height because both reservation rules are stated in lines
   * ({@link bulletKeepLines}), and deriving the count back out of a height would
   * put a division between the measurement and the decision it feeds.
   */
  measureBulletLines(
    text: string,
    size: number,
    hangingIndent: number,
  ): number {
    const marked = autoBoldMetrics(text);
    if (!marked.includes(EMPHASIS_OPEN)) {
      return this.resolveDrawLines(`${BULLET_MARKER}${text}`, {
        size,
        hangingIndent,
      }).lines.length;
    }
    return this.wrapRuns(parseBoldRuns(marked), size, hangingIndent, BULLET_MARKER)
      .length;
  }

  /**
   * Draw a header line as bold/regular runs (#425 — achievement "type" labels).
   * A leading substring wrapped in the sentinel emphasis markers draws bold, the
   * rest regular; the sentinels are stripped, so the round-trip text is
   * unchanged. Same word-wrapping engine as `drawBullet`, but with no bullet
   * marker and drawn at the header color/size.
   */
  drawHeaderRuns(text: string, size: number) {
    this.drawRuns(parseBoldRuns(text), size, 0, { marker: "", color: this.black });
  }

  /** Height (pt) {@link drawHeaderRuns} will occupy for the same text (#629). */
  measureHeaderRunsHeight(text: string, size: number): number {
    return (
      this.wrapRuns(parseBoldRuns(text), size, 0, "").length * (size * LINE_GAP)
    );
  }

  /**
   * Break `runs` into drawn lines WITHOUT touching the page — the pure half of
   * {@link drawRuns}, so a reservation and the draw that follows it agree by
   * construction (#629). A "word" is a run of non-whitespace that may span a
   * bold→regular boundary (so mid-word emphasis draws correctly); words are
   * separated by a single space. The `marker` (the bullet "• ", or "" for a
   * header) occupies the start of the first line; continuation lines start at
   * `hangingIndent`. An empty run list yields one empty line, matching what the
   * draw loop emits.
   */
  private wrapRuns(
    runs: Array<{ text: string; bold: boolean }>,
    size: number,
    hangingIndent: number,
    marker: string,
  ): WordChunk[][][] {
    const words = groupRunsIntoWords(runs, size, this.fonts, this.sanitize);
    const wordWidth = (w: WordChunk[]) =>
      w.reduce((sum, c) => sum + c.width, 0);
    const space = this.fonts.regular.widthOfTextAtSize(" ", size);
    const markerWidth = marker
      ? this.fonts.regular.widthOfTextAtSize(marker, size)
      : 0;
    const rightEdge = PAGE_WIDTH - MARGIN;

    const lines: WordChunk[][][] = [];
    let current: WordChunk[][] = [];
    let x = MARGIN + markerWidth;
    let atLineStart = true;
    for (const word of words) {
      const ww = wordWidth(word);
      // Wrap before a word (never the first on a line) that would overflow.
      if (!atLineStart && x + space + ww > rightEdge) {
        lines.push(current);
        current = [];
        x = MARGIN + hangingIndent;
        atLineStart = true;
      }
      if (!atLineStart) x += space;
      x += ww;
      current.push(word);
      atLineStart = false;
    }
    lines.push(current);
    return lines;
  }

  /**
   * Draw a sequence of `{ text, bold }` runs with word-level wrapping, breaking
   * to a new page between lines as needed. Line breaking itself lives in
   * {@link wrapRuns}; this walks the resulting lines and draws them. Bold is
   * preserved across wraps because it is tracked per chunk, not per line.
   */
  private drawRuns(
    runs: Array<{ text: string; bold: boolean }>,
    size: number,
    hangingIndent: number,
    opts: {
      marker?: string;
      color?: RGB;
      widowControl?: boolean;
      followKeepHeight?: number;
    } = {},
  ) {
    const marker = opts.marker ?? BULLET_MARKER;
    const color = opts.color ?? this.black;
    const lines = this.wrapRuns(runs, size, hangingIndent, marker);
    const space = this.fonts.regular.widthOfTextAtSize(" ", size);
    const markerWidth = marker
      ? this.fonts.regular.widthOfTextAtSize(marker, size)
      : 0;
    const lineHeight = size * LINE_GAP;

    for (let i = 0; i < lines.length; i++) {
      this.ensureWrappedLine(i, lines.length, lineHeight, opts);
      if (i === 0 && marker) {
        this.page.drawText(marker, {
          x: MARGIN,
          y: this.y - size,
          size,
          font: this.fonts.regular,
          color,
        });
      }
      this.drawRunWords(
        lines[i],
        i === 0 ? MARGIN + markerWidth : MARGIN + hangingIndent,
        { size, color, space },
      );
      this.advance(lineHeight);
    }
  }

  /**
   * Draw one already-wrapped line of runs, left to right from `startX`, switching
   * font per chunk so bold survives a wrap.
   *
   * Split out of {@link drawRuns} to flatten its loop nest; this walks words and
   * their chunks at a fixed baseline and never paginates or moves the cursor, so
   * line breaking stays wholly in {@link wrapRuns} and cannot drift from what was
   * measured (#629).
   */
  private drawRunWords(
    words: Array<Array<{ str: string; bold: boolean; width: number }>>,
    startX: number,
    opts: { size: number; color: RGB; space: number },
  ) {
    const { size, color, space } = opts;
    let x = startX;
    for (let w = 0; w < words.length; w++) {
      if (w > 0) x += space;
      for (const chunk of words[w]) {
        this.page.drawText(chunk.str, {
          x,
          y: this.y - size,
          size,
          font: chunk.bold ? this.fonts.bold : this.fonts.regular,
          color,
        });
        x += chunk.width;
      }
    }
  }

  drawRule() {
    this.ensure(RULE_HEIGHT);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 0.75,
      color: this.gray,
    });
    this.advance(RULE_HEIGHT);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Render an ATS résumé model to PDF bytes (Uint8Array). */
export async function renderAtsResumePdf(
  model: AtsResumeModel,
): Promise<Uint8Array> {
  const parts = await loadPdfLibOnce();
  const { PDFDocument, rgb } = parts;

  const doc = await PDFDocument.create();
  doc.setTitle(model.contact.name || "Resume");

  const { regular, bold, isEmbedded } = await loadFonts(doc, parts);

  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.55, 0.55, 0.55);
  const muted = rgb(0.35, 0.35, 0.35);

  const layout = new Layout(
    doc,
    { regular, bold },
    black,
    gray,
    parts.PDFString,
    !isEmbedded,
  );

  // ── Header: name + (headline) + contact line ──
  if (model.contact.name) {
    layout.drawText(model.contact.name, { bold: true, size: SIZE_NAME });
  }
  // Professional headline (#425) — regular weight, muted, under the name.
  // Populated when the parser lifted a standalone title tagline from the header
  // block (`extractHeadline` → `parsed.headline` → `buildContact`); absent
  // otherwise, so most résumés draw just name + contact line as before.
  if (model.contact.headline) {
    layout.drawText(model.contact.headline, {
      size: SIZE_HEADLINE,
      color: muted,
    });
  }
  const contactParts = [
    model.contact.email,
    model.contact.phone,
    model.contact.location,
    ...model.contact.links,
  ].filter((p): p is string => Boolean(p));
  if (contactParts.length > 0) {
    // Clickable overlays (#425): email → mailto:, each scheme-stripped link slug
    // → its real target. The visible text stays the shortened display; the
    // annotation carries the real target. Annotations are outside the content
    // stream, so the text round-trip is unaffected.
    //
    // The href is the ORIGINAL parsed URL (`contact.linkHrefs`, aligned with
    // `links`) rather than one rebuilt from the `www.`-stripped display: rebuilding
    // `https://${slug}` from the display would force `https` and drop any `www.`
    // the source URL carried, so a portfolio/website served only at `www.host` or
    // over `http` would get a 404-ing link. The display stays `www.`-less; only
    // the click target uses the original.
    const linkSpans: Array<{ display: string; href: string }> = [];
    if (model.contact.email)
      linkSpans.push({
        display: model.contact.email,
        href: `mailto:${model.contact.email}`,
      });
    model.contact.links.forEach((link, i) =>
      linkSpans.push({
        display: link,
        href: model.contact.linkHrefs?.[i] ?? `https://${link}`,
      }),
    );
    layout.drawText(contactParts.join("  •  "), {
      size: SIZE_CONTACT,
      color: muted,
      linkSpans,
    });
  }
  layout.advance(GAP_AFTER_CONTACT);

  // ── Summary ──
  if (model.summary) {
    // The summary body is plain wrapped text, so the heading must keep one BODY
    // line with it (#629).
    drawSectionHeading(layout, model.summaryHeading ?? "Summary", SIZE_BODY * LINE_GAP);
    layout.drawText(model.summary, { size: SIZE_BODY });
    layout.advance(GAP_BETWEEN_ENTRIES);
  }

  // ── Sections ──
  for (const section of model.sections) {
    // Keep-with-next (#629): the heading reserves its rule, its trailing gap AND
    // the whole keep-block of its first entry. Reserving only "heading + one
    // line" would let the entry's own reservation fire immediately afterwards and
    // move the entry to the next page, stranding the heading it just committed.
    drawSectionHeading(
      layout,
      section.heading,
      section.entries.length > 0
        ? entryKeepHeight(layout, section.entries[0], muted)
        : 0,
    );
    for (let i = 0; i < section.entries.length; i++) {
      drawEntry(layout, section.entries[i], muted);
      if (i < section.entries.length - 1) layout.advance(GAP_BETWEEN_ENTRIES);
    }
    layout.advance(GAP_BETWEEN_ENTRIES);
  }

  // ── Embedded machine-readable copy (#334, Europass pattern) ──
  // Attach a JSON Resume (jsonresume.org) document as `resume.json` INSIDE the
  // PDF. This lives in the PDF's EmbeddedFiles name tree — NOT the page content
  // stream — so it never touches the text layer: `pdftotext`/pdfjs extraction is
  // unaffected and the parse→export→re-parse round-trip stays byte-for-byte the
  // same (verified by corpus-roundtrip.test.ts). Fully client-side; the bytes
  // are built in-process from `model` (no fetch, no upload). `toJsonResume` is a
  // pure adapter — no pdf-lib import — so it stays testable in isolation.
  //
  // creation/modification dates are deliberately omitted: pdf-lib writes no date
  // when they're absent (FileEmbedder), keeping the output deterministic and
  // leaking no wall-clock timestamp.
  //
  // Re-wrap the encoded bytes in a fresh `Uint8Array`: pdf-lib validates the
  // attachment with `value instanceof Uint8Array`, and under jsdom the global
  // `TextEncoder` returns a Uint8Array from a DIFFERENT realm that fails that
  // check ("type NaN"). Copying into this module's Uint8Array normalizes the
  // realm — a harmless one-time copy in the browser, and the fix in tests.
  const resumeJsonBytes = new Uint8Array(
    new TextEncoder().encode(JSON.stringify(toJsonResume(model), null, 2)),
  );
  await doc.attach(resumeJsonBytes, "resume.json", {
    mimeType: "application/json",
    description: "JSON Resume (jsonresume.org) — machine-readable copy",
  });

  return doc.save();
}

/** The `drawText` options for a section/summary heading — shared by the draw and
 *  its keep-with-next measurement (#629) so the two cannot drift. */
const HEADING_OPTS = {
  bold: true,
  size: SIZE_SECTION,
  uppercase: true,
} as const;

/**
 * Draw a section (or Summary) heading plus its rule. `followHeight` is the
 * keep-with-next payload — the height of the first thing that must land on the
 * SAME page as the heading (#629), i.e. the first entry's keep-block, or one body
 * line for the Summary. Passing `0` (an empty section) degrades to the plain
 * "heading must itself fit" behaviour.
 */
function drawSectionHeading(
  layout: Layout,
  heading: string,
  followHeight: number,
) {
  layout.advance(GAP_BEFORE_SECTION);
  layout.ensureBlock(
    layout.measureTextHeight(heading, HEADING_OPTS) +
      RULE_HEIGHT +
      GAP_AFTER_RULE +
      followHeight,
  );
  layout.drawText(heading, HEADING_OPTS);
  layout.drawRule();
  layout.advance(GAP_AFTER_RULE);
}

/** The `drawText` options for an entry's header line — shared by the draw and its
 *  keep-with-next measurement (#629). */
function headerLineOpts(entry: AtsEntry, mutedColor: RGB): DrawTextOpts {
  return {
    // Every header is bold EXCEPT where the model opts out — the skills list,
    // which reads as regular-weight body text (#425).
    bold: entry.headerBold ?? true,
    size: SIZE_HEADER,
    atomicSegments: entry.atomicSegments,
    hangingIndent: entry.headerHangingIndent,
    // Flush-right date on the header line (#425) — set for a title-less role /
    // degree-less program, where the org/date anchor lives on the header.
    rightText: entry.headerLineDate,
    rightColor: mutedColor,
    rightSize: SIZE_SUB,
  };
}

/** The `drawText` options for an entry's sub-line — shared by the draw and its
 *  keep-with-next measurement (#629). See `drawEntry` for why the middot
 *  segments are atomic here. */
function subLineOpts(entry: AtsEntry, mutedColor: RGB): DrawTextOpts {
  return {
    size: SIZE_SUB,
    color: mutedColor,
    atomicSegments: true,
    // Flush-right date on the sub-line (#425) — set for a titled role /
    // degreed entry, where the org anchor lives on the sub-line.
    rightText: entry.subLineDate,
    rightColor: mutedColor,
    rightSize: SIZE_SUB,
  };
}

/**
 * How many header lines a BODY-TEXT header line contributes to a keep-with-next
 * reservation, at most (#629). Two, because that is the smallest unit with any
 * widow value — it is the same orphan rule `drawBullet` applies to a wrapped
 * bullet: the block's first line is never left alone at a page bottom. One would
 * add nothing over the plain per-line `ensure`; three or more starts trading real
 * page density for a guarantee body text does not need, since it is divisible.
 */
const BODY_HEADER_KEEP_LINES = 2;

/**
 * The entry header block's contribution (pt) to the keep-with-next reservation —
 * its (possibly wrapped) header line plus, when present, the gap and its
 * (possibly wrapped) sub-line. `0` for a bullets-only entry. Measured through the
 * SAME option builders the draw uses, so a multi-line header reserves ALL of its
 * wrapped lines, not one (#629).
 *
 * ALL of them, that is, for a real header. `headerBold: false` is the model saying
 * this entry's "header" is regular-weight BODY text, not a header — set only by
 * the two skills paths in `ats-resume-model.ts` (the flat `skills.join(" · ")`
 * entry and one per category), whose single header line carries the entire skills
 * list and can wrap to dozens of lines. Reserving every one of those would make an
 * arbitrarily tall body block indivisible, and `drawSectionHeading` inherits that
 * through `followHeight` — de-densifying real pages by up to ~100pt and, past a
 * page, hitting {@link Layout.ensureBlock}'s unsatisfiable case. Body text is
 * divisible, so it is capped at {@link BODY_HEADER_KEEP_LINES}.
 *
 * The achievement headers that also set `headerBold: false` are NOT caught by
 * this: they set it because their per-run sentinels carry the weight instead
 * (`buildAchievementHeader` returns `emphasized` iff the line contains
 * `EMPHASIS_OPEN`), so they take the run-measuring branch above and keep the full
 * multi-line reservation a genuine header deserves.
 *
 * The `bullets.length === 0` half of the gate is what makes the cap SAFE rather
 * than merely correct-today. `headerBold` is a styling flag, so on its own it
 * would let a capped entry keep bullets: reserving 2 header lines + 1 bullet line
 * for a 3-line header leaves the per-line `ensure` free to draw header line 3 and
 * break before the bullet — page ends on header text, bullet orphaned, AC1
 * violated. Capping only a BULLETLESS entry gates on the property that actually
 * licenses the cap (nothing must be kept with it), so AC1 holds unconditionally
 * instead of "unless `headerBold === false`". Both skills paths hard-code
 * `bullets: []`, so this changes no output today.
 */
function entryHeadHeight(
  layout: Layout,
  entry: AtsEntry,
  mutedColor: RGB,
): number {
  let height = 0;
  if (entry.headerLine) {
    if (entry.headerLine.includes(EMPHASIS_OPEN)) {
      height += layout.measureHeaderRunsHeight(entry.headerLine, SIZE_HEADER);
    } else {
      const full = layout.measureTextHeight(
        entry.headerLine,
        headerLineOpts(entry, mutedColor),
      );
      height +=
        entry.headerBold === false && entry.bullets.length === 0
          ? Math.min(full, BODY_HEADER_KEEP_LINES * SIZE_HEADER * LINE_GAP)
          : full;
    }
  }
  if (entry.subLine) {
    height +=
      GAP_AFTER_HEADER +
      layout.measureTextHeight(entry.subLine, subLineOpts(entry, mutedColor));
  }
  return height;
}

/**
 * Height (pt) of the entry's keep-with-next group — the indivisible unit that
 * must start on a page able to hold all of it (#629):
 *
 *   - header block (all wrapped header + sub-line lines) + the first bullet's own
 *     keep-opening, so a header can never be the last thing on a page;
 *   - a header block with NO bullets reserves just the header block — no phantom
 *     bullet line;
 *   - a bullets-only entry (no header, no sub-line) reduces to exactly that first
 *     bullet reservation, since its head measures `0`;
 *   - an entirely empty entry reserves nothing.
 *
 * The first bullet's reservation is exactly {@link bulletKeepLines} of its lines
 * — the same opening {@link Layout.drawBullet} reserves for a bullet it starts on
 * its own, so the two agree by construction rather than by coincidence. That is
 * what lets `drawEntry` pass `alreadyReserved` for the first bullet: the lines
 * really are reserved here, so suppressing the bullet's own reservation cannot
 * re-orphan its first line (#629) nor widow its last (#631 — a first bullet
 * wrapping to three lines is indivisible, so all three are reserved here). It
 * does not violate #629's "compose rather than sum" decision either: a first
 * bullet long enough to split still reserves only its opening, never its full
 * height.
 *
 * Used both by the entry itself and by the section heading above it, so the two
 * agree on what "the first thing that must stay with the heading" costs.
 */
function entryKeepHeight(
  layout: Layout,
  entry: AtsEntry,
  mutedColor: RGB,
): number {
  const bulletLine = SIZE_BODY * LINE_GAP;
  const head = entryHeadHeight(layout, entry, mutedColor);
  if (entry.bullets.length === 0) return head;
  const firstBulletLines = layout.measureBulletLines(
    entry.bullets[0],
    SIZE_BODY,
    BULLET_INDENT,
  );
  const keep = bulletKeepLines(firstBulletLines);
  const base = head + keep * bulletLine;
  // #632, and ONLY for a two-bullet entry whose first bullet is INDIVISIBLE. In
  // that one shape the reservation covering the first bullet's final line is its
  // opening — which `drawEntry` suppresses via `alreadyReserved` — so the
  // trailing bullet's keep-opening has nowhere else to ride and must be folded in
  // here. Every other shape reserves the follow later and cheaper: a divisible
  // first bullet carries it on its tail reservation (not suppressed, it lives in
  // the draw loop), and a 3+ bullet entry carries it on a bullet this block never
  // covers at all. So the entry-level cost of the rule is at most one trailing
  // bullet's keep-opening (≤ `2 * BULLET_KEEP_LINES - 1` lines), never the entry.
  if (entry.bullets.length !== 2 || keep !== firstBulletLines) return base;
  const withFollow = base + trailingBulletKeepHeight(layout, entry);
  // #629 outranks #632. Growing this block past a page would make it
  // UNSATISFIABLE, and `ensureBlock` then ignores it outright — surrendering the
  // header-stranding guarantee to buy a lone-bullet one. Drop the follow instead:
  // the lone trailing bullet degrades, the header keep-with-next does not.
  return withFollow > USABLE_PAGE_HEIGHT ? base : withFollow;
}

/**
 * The keep-opening (pt) of an entry's LAST bullet — what must fit after the
 * second-to-last bullet's final line so the last bullet is never left alone at a
 * page top (#632).
 *
 * It is exactly the reservation that bullet will make for itself when
 * {@link Layout.drawBullet} starts it ({@link bulletKeepLines} of its measured
 * lines), so reserving it in advance is exact rather than approximate: the
 * trailing bullet's own reservation is then guaranteed to be already satisfied
 * and cannot fire a second page break that would undo the placement. Measured
 * through {@link Layout.measureBulletLines}, the same wrapping that draws it.
 */
function trailingBulletKeepHeight(layout: Layout, entry: AtsEntry): number {
  const lines = layout.measureBulletLines(
    entry.bullets[entry.bullets.length - 1],
    SIZE_BODY,
    BULLET_INDENT,
  );
  return bulletKeepLines(lines) * SIZE_BODY * LINE_GAP;
}

function drawEntry(layout: Layout, entry: AtsEntry, mutedColor: RGB) {
  // Keep-with-next (#629): commit to this page only if the header AND its first
  // bullet's keep-opening (`bulletKeepLines` of its lines — all of them when it
  // is too short to split) fit together, so the header is never the final drawn
  // line on a page. The
  // reservation covers everything the draws below consume up to that point, so
  // their own per-line `ensure` calls cannot fire a second page break inside the
  // group.
  const keepHeight = entryKeepHeight(layout, entry, mutedColor);
  if (keepHeight > 0) layout.ensureBlock(keepHeight);
  if (entry.headerLine) {
    if (entry.headerLine.includes(EMPHASIS_OPEN)) {
      // Mixed-weight header (#425 — an achievement "type" label bolded, the rest
      // regular). Routed to the run-aware draw; these headers carry no flush-right
      // date, so the marker-less run path covers them.
      layout.drawHeaderRuns(entry.headerLine, SIZE_HEADER);
    } else {
      layout.drawText(entry.headerLine, headerLineOpts(entry, mutedColor));
    }
  }
  if (entry.subLine) {
    layout.advance(GAP_AFTER_HEADER);
    // Sub-lines are the "Company · Location · Team  Dates" / "Institution ·
    // Location  Dates" org lines (see `ats-resume-model.ts`) — the middot here
    // is a re-parse-critical boundary, NOT a display joiner: word-wrapping
    // inside a multi-word location (e.g. "San Francisco Bay Area") re-parses it
    // into fragmented location tokens (#301). Unlike the 3+ segment achievement
    // HEADER lines (#307), these must stay atomic, so opt in unconditionally.
    layout.drawText(entry.subLine, subLineOpts(entry, mutedColor));
  }
  // #632: the LAST bullet of a multi-bullet entry must never be the only thing
  // its page opens with. The whole rule is one hand-off — the SECOND-TO-LAST
  // bullet carries the last one's keep-opening as `followKeepHeight`, so the only
  // page break the pair admits is one that moves BOTH forward. It is deliberately
  // not an entry-level reservation: only this one boundary is constrained, the
  // earlier bullets paginate freely, and the extra height is one bullet's opening
  // — the blanket "keep the whole entry together" alternative is what cost a real
  // fixture ~100pt of page-1 density in #630.
  const trailingKeep =
    entry.bullets.length >= 2 ? trailingBulletKeepHeight(layout, entry) : 0;
  for (let i = 0; i < entry.bullets.length; i++) {
    // Auto-bold quantified metrics inside the bullet, then draw per-word runs
    // (#425). Markers are stripped before drawing, so the round-trip text is
    // unchanged; a metric-free bullet takes the legacy single-string path.
    //
    // The FIRST bullet is already covered by the keep-block reserved above, so it
    // must not re-reserve for its own orphan rule — that would move it and strand
    // the header (#629's composition decision). When it is ALSO the second-to-last
    // bullet, `entryKeepHeight` has already folded `trailingKeep` into that block
    // for the one shape where it must (see there), and passing it on here is
    // harmless: `drawBullet` uses it only on the reservation covering the bullet's
    // final line, which for a divisible bullet is its tail — not suppressed.
    layout.drawBullet(entry.bullets[i], SIZE_BODY, BULLET_INDENT, {
      alreadyReserved: i === 0 && keepHeight > 0,
      followKeepHeight: i === entry.bullets.length - 2 ? trailingKeep : 0,
    });
  }
}
