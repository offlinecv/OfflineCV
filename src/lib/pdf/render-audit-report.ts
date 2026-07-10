// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * render-audit-report — the human-readable half of the shareable audit report
 * (#343).
 *
 * Renders the audit findings (verdict + score breakdown + layout triggers +
 * recommendation) to PDF bytes with pdf-lib, fully client-side. Sibling of
 * `render-ats-pdf.ts` (which renders the RÉSUMÉ); this renders the REPORT
 * ABOUT the résumé. It reuses the same lazy `load-pdf-lib.ts` loader so pdf-lib
 * stays out of the entry chunk, and the same `toWinAnsi()` sanitizer so
 * arbitrary parsed text (a candidate name with an exotic glyph) never crashes
 * `drawText`.
 *
 * PRIVACY GATE: the identity header (name / email / phone / location / links)
 * is drawn ONLY when `input.includeIdentity` is true AND an `identity` block is
 * present. Default-off upstream, so the default artifact is anonymous.
 *
 * This uses pdf-lib's built-in Helvetica (no Poppins fetch): the report is a
 * plain document, not the brand-faithful résumé, so the 14 standard fonts are
 * enough and it keeps the module dependency-light. Every string is run through
 * `toWinAnsi()` because StandardFonts encode WinAnsi only (#295). The `rgb()`
 * values are PDF graphics-state colors, NOT Tailwind tokens — the style guard
 * scans component code, not this draw module.
 */

import { loadPdfLibOnce, type PdfLibParts } from "./load-pdf-lib.ts";
import { toWinAnsi } from "./render-ats-pdf.ts";
import { wrapWordsToLines } from "./text-wrap.ts";
import { getScoreLabel, getScoreTier } from "../score/score.ts";
import { LAYOUT_TRIGGER_BLURBS } from "../heuristics/trigger-copy.ts";
import type { AuditReportInput } from "../report/serialize.ts";
import { REPORT_VERSION } from "../report/serialize.ts";
import { formatJsonResumeLocation } from "./to-json-resume.ts";
import { APP_VERSION } from "../version.ts";

/** Where the artifact points readers back to (branded footer). */
const APP_URL = "github.com/resumelint-org/resumelint";

// ── Page geometry (points) ────────────────────────────────────────────────────

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_BOTTOM = MARGIN;

// ── Type scale (points) ───────────────────────────────────────────────────────

const SIZE_TITLE = 20;
const SIZE_SECTION = 12;
const SIZE_BODY = 10;
const SIZE_SMALL = 9;
const SIZE_SCORE = 30;

const LINE_GAP = 1.3;

type RGB = ReturnType<PdfLibParts["rgb"]>;
type Doc = Awaited<ReturnType<PdfLibParts["PDFDocument"]["create"]>>;
type Page = ReturnType<Doc["addPage"]>;
type PdfFont = Awaited<ReturnType<Doc["embedFont"]>>;

/**
 * Mutable cursor + page state threaded through the draw routines — a trimmed
 * cousin of render-ats-pdf's `Layout`, sized to the report's needs (word wrap,
 * pagination, a horizontal rule).
 */
class ReportLayout {
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

  private ensure(height: number) {
    if (this.y - height < CONTENT_BOTTOM) this.newPage();
  }

  advance(points: number) {
    this.y -= points;
  }

  private wrap(text: string, font: PdfFont, size: number, maxWidth: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [""];
    // Break long words here (unlike the résumé renderer): the identity header
    // joins raw URLs, each a single whitespace-free "word" that can exceed the
    // content width and would otherwise be drawn straight off the page (#421
    // Blocking #5). The report has no re-parse invariant to protect.
    return wrapWordsToLines(words, font, size, maxWidth, true);
  }

  drawText(
    text: string,
    opts: {
      bold?: boolean;
      size?: number;
      color?: RGB;
      x?: number;
      hangingIndent?: number;
    } = {},
  ) {
    const size = opts.size ?? SIZE_BODY;
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    const color = opts.color ?? this.black;
    const x = opts.x ?? MARGIN;
    const hanging = opts.hangingIndent ?? 0;
    const value = toWinAnsi(text);
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

function sectionHeading(layout: ReportLayout, heading: string) {
  layout.advance(14);
  layout.drawText(heading, { bold: true, size: SIZE_SECTION });
  layout.drawRule();
  layout.advance(6);
}

/** "12 / 40" for a gradable dimension, or "—" when there wasn't signal to grade. */
function dimensionValue(dim: { score: number; max: number; gradable: boolean }): string {
  return dim.gradable ? `${dim.score} / ${dim.max}` : "—";
}

/**
 * Identity header — PRIVACY GATE. Drawn ONLY when `includeIdentity` is true AND
 * an `identity` block is present; a no-op otherwise, so the default artifact is
 * anonymous. Extracted from the main render so its nested branches don't inflate
 * the caller's complexity.
 */
function drawIdentityHeader(layout: ReportLayout, input: AuditReportInput, muted: RGB) {
  if (!input.includeIdentity || !input.identity) return;
  const id = input.identity;
  if (id.name) layout.drawText(id.name, { bold: true, size: SIZE_BODY });
  const parts = [
    id.email,
    id.phone,
    formatJsonResumeLocation(id.location),
    id.url,
    ...(id.profiles ?? []).map((p) => p.url),
  ].filter((p): p is string => Boolean(p));
  if (parts.length > 0) {
    layout.drawText(parts.join("  •  "), { size: SIZE_SMALL, color: muted });
  }
  layout.advance(8);
}

/** Layout-flags section: one bullet per fired trigger, or a reassuring line when
 *  none fired. */
function drawLayoutFlags(
  layout: ReportLayout,
  triggers: AuditReportInput["triggers"],
  muted: RGB,
) {
  sectionHeading(layout, "Layout flags");
  if (triggers.length === 0) {
    layout.drawText("No layout flags — standard single-column, text-selectable PDF.", {
      size: SIZE_BODY,
      color: muted,
    });
    return;
  }
  for (const t of triggers) {
    layout.drawText(`• ${LAYOUT_TRIGGER_BLURBS[t]}`, { size: SIZE_BODY, hangingIndent: 10 });
    layout.advance(2);
  }
}

/**
 * Render an audit report to PDF bytes (Uint8Array). Pure w.r.t. inputs — the
 * only side channel is the lazy pdf-lib import; no fetch, no upload.
 */
export async function renderAuditReportPdf(
  input: AuditReportInput,
): Promise<Uint8Array> {
  const parts = await loadPdfLibOnce();
  const { PDFDocument, StandardFonts, rgb } = parts;

  const doc = await PDFDocument.create();
  doc.setTitle("Resume Audit Report");

  // Independent embeds — run in parallel (mirrors render-ats-pdf.ts).
  const [regular, bold] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
  ]);

  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.55, 0.55, 0.55);
  const muted = rgb(0.35, 0.35, 0.35);

  const layout = new ReportLayout(doc, { regular, bold }, black, gray);
  const { score } = input;

  // ── Title ──
  layout.drawText("Resume Audit Report", { bold: true, size: SIZE_TITLE });
  layout.advance(4);
  const dateLabel = input.generatedAt.slice(0, 10); // YYYY-MM-DD
  layout.drawText(`Generated ${dateLabel}`, { size: SIZE_SMALL, color: muted });
  layout.advance(10);

  // ── Identity header (privacy gate — opt-in only) ──
  drawIdentityHeader(layout, input, muted);

  // ── Verdict + overall score ──
  sectionHeading(layout, "Verdict");
  const label = getScoreLabel(getScoreTier(score.overall));
  layout.drawText(`${score.overall}`, { bold: true, size: SIZE_SCORE });
  layout.drawText(`out of 100 — ${label}`, { size: SIZE_BODY, color: muted });
  if (score.preLayoutOverall !== score.overall) {
    layout.advance(2);
    layout.drawText(
      `Content scored ${score.preLayoutOverall}/100; a layout penalty dropped the total to ${score.overall}.`,
      { size: SIZE_SMALL, color: muted },
    );
  }

  // ── Dimension breakdown ──
  sectionHeading(layout, "Breakdown");
  layout.drawText(`Specificity: ${dimensionValue(score.specificity)}`, { size: SIZE_BODY });
  layout.drawText(`Structure: ${dimensionValue(score.structure)}`, { size: SIZE_BODY });
  layout.drawText(`Completeness: ${dimensionValue(score.completeness)}`, { size: SIZE_BODY });
  if (score.completeness.gradable && score.completeness.missing.length > 0) {
    layout.drawText(`Missing: ${score.completeness.missing.join(", ")}`, {
      size: SIZE_SMALL,
      color: muted,
    });
  }

  // ── Layout flags ──
  drawLayoutFlags(layout, input.triggers, muted);

  // ── Recommendation ──
  sectionHeading(layout, "Recommendation");
  layout.drawText(input.recommendation, { size: SIZE_BODY });

  // ── Branded footer ──
  layout.advance(16);
  layout.drawRule();
  layout.advance(6);
  layout.drawText(
    `${APP_URL} · report v${REPORT_VERSION} · algo v${score.algoVersion ?? "?"} · app ${APP_VERSION} · ${dateLabel}`,
    { size: SIZE_SMALL, color: muted },
  );

  return doc.save();
}
