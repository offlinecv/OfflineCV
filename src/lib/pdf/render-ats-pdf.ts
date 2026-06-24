// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * render-ats-pdf — the single-column, text-only ATS PDF draw engine (#171).
 *
 * Renders an `AtsResumeModel` to PDF bytes using ONLY pdf-lib's built-in
 * Helvetica / Helvetica-Bold (`StandardFonts`). No embedded custom fonts, no
 * images, no rasterization, no network — every glyph is selectable, searchable
 * text drawn with a standard PDF font, which is the most ATS-safe form and
 * guarantees zero egress.
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

// ── Page geometry (points) ────────────────────────────────────────────────────

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_BOTTOM = MARGIN;

// ── Type scale (points) ───────────────────────────────────────────────────────

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

type RGB = ReturnType<PdfLibParts["rgb"]>;
type Doc = Awaited<ReturnType<PdfLibParts["PDFDocument"]["create"]>>;
type Page = ReturnType<Doc["addPage"]>;
type PdfFont = Awaited<ReturnType<Doc["embedFont"]>>;

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

  /** Word-wrap `text` to `maxWidth` using the given font/size. */
  private wrap(
    text: string,
    font: PdfFont,
    size: number,
    maxWidth: number,
  ): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const lines: string[] = [];
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${current} ${words[i]}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
    return lines;
  }

  /**
   * Draw a wrapped block of text. `x` is the left edge; `hangingIndent`
   * indents continuation lines (for bullet hanging indent). Returns nothing;
   * mutates the cursor and paginates as needed.
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
    } = {},
  ) {
    const size = opts.size ?? SIZE_BODY;
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    const color = opts.color ?? this.black;
    const x = opts.x ?? MARGIN;
    const hanging = opts.hangingIndent ?? 0;
    const value = opts.uppercase ? text.toUpperCase() : text;
    const maxWidth = CONTENT_WIDTH - (x - MARGIN);

    const lines = this.wrap(value, font, size, maxWidth);
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
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLibOnce();

  const doc = await PDFDocument.create();
  doc.setTitle(model.contact.name || "Resume");

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.55, 0.55, 0.55);
  const muted = rgb(0.35, 0.35, 0.35);

  const layout = new Layout(doc, { regular, bold }, black, gray);

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
    drawSectionHeading(layout, "Summary");
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
    layout.drawText(entry.headerLine, { bold: true, size: SIZE_HEADER });
  }
  if (entry.subLine) {
    layout.advance(GAP_AFTER_HEADER);
    layout.drawText(entry.subLine, { size: SIZE_SUB, color: mutedColor });
  }
  for (const bullet of entry.bullets) {
    layout.drawText(`${BULLET_MARKER}${bullet}`, {
      size: SIZE_BODY,
      hangingIndent: BULLET_INDENT,
    });
  }
}
