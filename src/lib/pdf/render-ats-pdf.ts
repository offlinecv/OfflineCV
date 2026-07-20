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

const BULLET_MARKER = "• ";
const BULLET_INDENT = 12; // hanging-indent width for wrapped bullet lines

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
   * Draw a wrapped block of text. `x` is the left edge; `hangingIndent`
   * indents continuation lines (for bullet hanging indent). `atomicSegments`
   * opts into segment-atomic middot wrapping (see `wrap()` above) — leave it
   * unset/`false` for ordinary header/entry lines; the skills entry is the
   * only caller that sets it `true` (#307).  Returns nothing; mutates the
   * cursor and paginates as needed.
   */
  drawText(
    text: string,
    opts: {
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
    } = {},
  ) {
    const size = opts.size ?? SIZE_BODY;
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    const color = opts.color ?? this.black;
    const x = opts.x ?? MARGIN;
    const hanging = opts.hangingIndent ?? 0;
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
    const maxWidth = CONTENT_WIDTH - (x - MARGIN);

    const lines = this.wrap(
      value,
      font,
      size,
      maxWidth,
      opts.atomicSegments ?? false,
    );
    const lineHeight = size * LINE_GAP;
    const singleLine = lines.length === 1;
    for (let i = 0; i < lines.length; i++) {
      this.ensure(lineHeight);
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
        // Flush-right date tail on the first line's baseline (#425), right-
        // aligned to the content margin and drawn regular-weight/muted.
        if (opts.rightText) {
          const rSize = opts.rightSize ?? size;
          const rFont = this.fonts.regular;
          const rValue = this.sanitize ? toWinAnsi(opts.rightText) : opts.rightText;
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
          const w = font.widthOfTextAtSize(lines[0], size);
          this.registerLink(lineX, topY - size, lineX + w, topY, opts.linkUrl);
        }
        // Per-substring link annotations (#425 contact-line slugs). Measure
        // against the DRAWN first line (whitespace already collapsed by wrap);
        // skip if the text wrapped so offsets stay accurate. Drawn glyphs are
        // untouched either way, so the text round-trip is unaffected.
        //
        // Search from a running offset that advances past each matched span, so
        // a display that is a SUBSTRING of an earlier part (e.g. website slug
        // `example.com` inside email `jane@example.com`, and the email is drawn
        // first) can't match inside that earlier part and land the rect on the
        // wrong text. The spans are supplied in draw order, so a monotonic offset
        // maps each to its own occurrence.
        if (opts.linkSpans && singleLine) {
          let searchFrom = 0;
          for (const span of opts.linkSpans) {
            const idx = lines[0].indexOf(span.display, searchFrom);
            if (idx < 0) continue;
            const x0 = lineX + font.widthOfTextAtSize(lines[0].slice(0, idx), size);
            const x1 = x0 + font.widthOfTextAtSize(span.display, size);
            this.registerLink(x0, topY - size, x1, topY, span.href);
            searchFrom = idx + span.display.length;
          }
        }
      }
      this.advance(lineHeight);
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
  drawBullet(text: string, size: number, hangingIndent: number) {
    const marked = autoBoldMetrics(text);
    if (!marked.includes(EMPHASIS_OPEN)) {
      this.drawText(`${BULLET_MARKER}${text}`, { size, hangingIndent });
      return;
    }
    this.drawRuns(parseBoldRuns(marked), size, hangingIndent);
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

  /**
   * Draw a sequence of `{ text, bold }` runs with word-level wrapping. A "word"
   * is a run of non-whitespace that may span a bold→regular boundary (so mid-
   * word emphasis draws correctly); words are separated by a single space. A
   * leading `marker` (the bullet "• " by default, "" for a header) leads the
   * first line; continuation lines use `hangingIndent`. Bold is preserved across
   * wraps because it is tracked per chunk, not per line.
   */
  private drawRuns(
    runs: Array<{ text: string; bold: boolean }>,
    size: number,
    hangingIndent: number,
    opts: { marker?: string; color?: RGB } = {},
  ) {
    const marker = opts.marker ?? BULLET_MARKER;
    const color = opts.color ?? this.black;
    const words = groupRunsIntoWords(
      runs,
      size,
      this.fonts,
      this.sanitize,
    );

    const wordWidth = (w: WordChunk[]) =>
      w.reduce((sum, c) => sum + c.width, 0);
    const space = this.fonts.regular.widthOfTextAtSize(" ", size);
    const markerWidth = marker
      ? this.fonts.regular.widthOfTextAtSize(marker, size)
      : 0;
    const rightEdge = PAGE_WIDTH - MARGIN;
    const lineHeight = size * LINE_GAP;

    this.ensure(lineHeight);
    if (marker) {
      this.page.drawText(marker, {
        x: MARGIN,
        y: this.y - size,
        size,
        font: this.fonts.regular,
        color,
      });
    }
    let x = MARGIN + markerWidth;
    let atLineStart = true;

    for (const word of words) {
      const ww = wordWidth(word);
      // Wrap before a word (never the first on a line) that would overflow.
      if (!atLineStart && x + space + ww > rightEdge) {
        this.advance(lineHeight);
        this.ensure(lineHeight);
        x = MARGIN + hangingIndent;
        atLineStart = true;
      }
      if (!atLineStart) x += space;
      for (const chunk of word) {
        this.page.drawText(chunk.str, {
          x,
          y: this.y - size,
          size,
          font: chunk.bold ? this.fonts.bold : this.fonts.regular,
          color,
        });
        x += chunk.width;
      }
      atLineStart = false;
    }
    this.advance(lineHeight);
  }

  drawRule() {
    this.ensure(2);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 0.75,
      color: this.gray,
    });
    this.advance(2);
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
    drawSectionHeading(layout, model.summaryHeading ?? "Summary");
    layout.drawText(model.summary, { size: SIZE_BODY });
    layout.advance(GAP_BETWEEN_ENTRIES);
  }

  // ── Sections ──
  for (const section of model.sections) {
    drawSectionHeading(layout, section.heading);
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

function drawSectionHeading(layout: Layout, heading: string) {
  layout.advance(GAP_BEFORE_SECTION);
  layout.drawText(heading, { bold: true, size: SIZE_SECTION, uppercase: true });
  layout.drawRule();
  layout.advance(GAP_AFTER_RULE);
}

function drawEntry(layout: Layout, entry: AtsEntry, mutedColor: RGB) {
  if (entry.headerLine) {
    if (entry.headerLine.includes(EMPHASIS_OPEN)) {
      // Mixed-weight header (#425 — an achievement "type" label bolded, the rest
      // regular). Routed to the run-aware draw; these headers carry no flush-right
      // date, so the marker-less run path covers them.
      layout.drawHeaderRuns(entry.headerLine, SIZE_HEADER);
    } else {
      layout.drawText(entry.headerLine, {
        // Every header is bold EXCEPT where the model opts out — the skills list,
        // which reads as regular-weight body text (#425).
        bold: entry.headerBold ?? true,
        size: SIZE_HEADER,
        atomicSegments: entry.atomicSegments,
        // Flush-right date on the header line (#425) — set for a title-less role /
        // degree-less program, where the org/date anchor lives on the header.
        rightText: entry.headerLineDate,
        rightColor: mutedColor,
        rightSize: SIZE_SUB,
      });
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
    layout.drawText(entry.subLine, {
      size: SIZE_SUB,
      color: mutedColor,
      atomicSegments: true,
      // Flush-right date on the sub-line (#425) — set for a titled role /
      // degreed entry, where the org anchor lives on the sub-line.
      rightText: entry.subLineDate,
      rightColor: mutedColor,
      rightSize: SIZE_SUB,
    });
  }
  for (const bullet of entry.bullets) {
    // Auto-bold quantified metrics inside the bullet, then draw per-word runs
    // (#425). Markers are stripped before drawing, so the round-trip text is
    // unchanged; a metric-free bullet takes the legacy single-string path.
    layout.drawBullet(bullet, SIZE_BODY, BULLET_INDENT);
  }
}
