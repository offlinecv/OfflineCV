// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
// never leaves the browser's own origin, so it does NOT violate resumelint's
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
    for (let i = 0; i < lines.length; i++) {
      this.ensure(lineHeight);
      const lineX = i === 0 ? x : x + hanging;
      this.page.drawText(lines[i], {
        x: lineX,
        y: this.y - size,
        size,
        font,
        color,
      });
      this.advance(lineHeight);
    }
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

  const layout = new Layout(doc, { regular, bold }, black, gray, !isEmbedded);

  // ── Header: name + contact line ──
  if (model.contact.name) {
    layout.drawText(model.contact.name, { bold: true, size: SIZE_NAME });
  }
  const contactParts = [
    model.contact.email,
    model.contact.phone,
    model.contact.location,
    ...model.contact.links,
  ].filter((p): p is string => Boolean(p));
  if (contactParts.length > 0) {
    layout.drawText(contactParts.join("  •  "), {
      size: SIZE_CONTACT,
      color: muted,
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
    layout.drawText(entry.headerLine, {
      bold: true,
      size: SIZE_HEADER,
      atomicSegments: entry.atomicSegments,
    });
  }
  if (entry.subLine) {
    layout.advance(GAP_AFTER_HEADER);
    // Sub-lines are the "Company · Location  Dates" / "Institution · Location
    // Dates" org lines (see `ats-resume-model.ts`) — the middot here is a
    // re-parse-critical boundary, NOT a display joiner: word-wrapping inside a
    // multi-word location (e.g. "San Francisco Bay Area") re-parses it into
    // fragmented location tokens (#301). Unlike the 3+ segment achievement
    // HEADER lines (#307), these must stay atomic, so opt in unconditionally.
    layout.drawText(entry.subLine, {
      size: SIZE_SUB,
      color: mutedColor,
      atomicSegments: true,
    });
  }
  for (const bullet of entry.bullets) {
    layout.drawText(`${BULLET_MARKER}${bullet}`, {
      size: SIZE_BODY,
      hangingIndent: BULLET_INDENT,
    });
  }
}
