// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Types for the heuristic resume parser cascade.
 *
 * All tiers produce partial `ParsedResume` shapes (see `../score/types.ts`)
 * augmented with per-field confidence and layout-probe triggers. The cascade
 * emits a final `CascadeResult` callers compare against a threshold to decide
 * whether to accept the heuristic output as canonical.
 */

import type {
  ParsedResume,
  ResumeExperience,
  ResumeEducation,
} from "../score/types.ts";

// ── PDF primitives ──────────────────────────────────────────────────────────

/** One positioned text run extracted from a PDF page. */
export interface PdfTextItem {
  /** 1-indexed page number. */
  page: number;
  /** Text content. */
  str: string;
  /** X of the baseline origin (PDF points, left-origin). */
  x: number;
  /** Y of the baseline origin (PDF points, top-origin after flip). */
  y: number;
  /** Width of the run in PDF points. */
  width: number;
  /** Height of the run in PDF points. */
  height: number;
  /** Nominal font size in PDF points (derived from the text matrix). */
  fontSize: number;
  /** pdfjs-assigned font name (opaque — useful only for equality comparisons). */
  fontName: string;
  /** True if the item is followed by an explicit line break in the PDF. */
  hasEOL: boolean;
}

/** Per-page layout metadata. */
export interface PdfPageInfo {
  page: number;
  /** Page width in PDF points. */
  width: number;
  /** Page height in PDF points. */
  height: number;
  /** Total raw character count on the page (sum of item str lengths). */
  charCount: number;
}

/**
 * One Link annotation lifted from a PDF page. Captured alongside the text
 * stream so we can recover URLs that exist only as hyperlinks behind visible
 * words ("LinkedIn", "GitHub") — the LaTeX/Jake's-Resume convention.
 *
 * Coordinates use top-origin like the rest of the pipeline (y grows downward),
 * so `yTop` can be compared directly against `PdfLine.y`.
 */
export interface PdfLinkAnnotation {
  /** 1-indexed page number. */
  page: number;
  /** Resolved URL. Annotations without a URL are dropped at extraction time. */
  url: string;
  /** [x1, y1Bottom, x2, y2Bottom] — pdfjs's native bottom-origin rect. */
  rect: [number, number, number, number];
  /** Top-origin y of the annotation's top edge — matches `PdfLine.y`. */
  yTop: number;
}

/**
 * Why Tier 0 produced empty text, when it did. `fonts_unmappable` flags PDFs
 * that have selectable text in the source (Framer / Affinity / some InDesign
 * exports) but use custom-font encodings pdfjs can't translate — not a true
 * scan. The user-facing copy and the OCR routing are different from the
 * scanned case.
 */
export type ExtractionFailureReason = "fonts_unmappable";

/** Full Tier 0 extraction output. */
export interface PdfExtractResult {
  items: PdfTextItem[];
  pages: PdfPageInfo[];
  /** Concatenated text joined by newlines (convenience; mirrors unpdf output). */
  text: string;
  /** Total raw character count across all pages. */
  rawCharCount: number;
  /** Link annotations discovered during extraction (filtered to entries with a URL). */
  linkAnnotations: PdfLinkAnnotation[];
  /** Set when extraction produced no text but the PDF carries other text-PDF
   *  signals (link annotations, real page dimensions). Drives the layout
   *  probe's choice between `scanned` and `fonts_unmappable`. */
  extractionFailureReason?: ExtractionFailureReason;
}

// ── Layout probes (Tier 0) ──────────────────────────────────────────────────

export type LayoutTrigger = "two_column" | "scanned" | "fonts_unmappable";

export interface LayoutProbes {
  /** True if total text density per page is below threshold (likely image PDF). */
  isScanned: boolean;
  /** True if x-coord distribution is bimodal with a gap wider than 30% of page width. */
  isTwoColumn: boolean;
  /** Union of active probes. */
  triggers: LayoutTrigger[];
}

// ── Tier 1 heuristic output ─────────────────────────────────────────────────

/** Subset of ParsedResume that the heuristic path can reliably produce. */
export type HeuristicParsedResume = Partial<ParsedResume> & {
  /** Always present (empty array if none found). */
  skills: string[];
  experience: ResumeExperience[];
  education: ResumeEducation[];
};

/** Confidence per extracted field (0..1). Fields not in the map default to 0. */
export type FieldConfidence = Partial<
  Record<
    | "full_name"
    | "email"
    | "phone"
    | "location"
    | "linkedin_url"
    | "github_url"
    | "portfolio_url"
    | "website_url"
    | "summary"
    | "skills"
    | "experience"
    | "education",
    number
  >
>;

export interface HeuristicResult {
  parsed: HeuristicParsedResume;
  fieldConfidence: FieldConfidence;
  /** Which splitter produced the section boundaries. Lets the confidence
   *  scorer distinguish markdown-anchored parses (stronger signal — a
   *  font-size-promoted heading passed the emitter's promotion gate) from
   *  regex-on-line parses. Optional; missing is treated as "regex". */
  sectionSource?: "markdown" | "regex";
}

// ── Cascade output ──────────────────────────────────────────────────────────

export type EscalationSuggestion = "none" | "ner" | "ocr" | "llm";

/** Shape emitted by `runCascade`. */
export interface CascadeResult {
  parsed: HeuristicParsedResume;
  /** Overall 0..1 score. Dashboard compares against a threshold. */
  confidence: number;
  fieldConfidence: FieldConfidence;
  triggers: LayoutTrigger[];
  suggestedEscalation: EscalationSuggestion;
  /** Which tiers actually executed (for debugging / telemetry). */
  tiers: Array<
    "t0_layout" | "t1_openresume" | "t1_5_regex" | "t2_ner" | "t3_ocr"
  >;
  /** Full concatenated text from Tier 0 — lets callers skip the server-side
   *  text-extraction round-trip when they accept the heuristic as canonical. */
  rawText: string;
  /** Structure-preserving markdown rendering of the PDF. Produced by
   *  `emitMarkdown()` from positioned text items + font-size analysis.
   *  Present when Tier 0 ran successfully on a non-scanned PDF; absent on
   *  scanned PDFs or when the emitter could not produce useful structure.
   *  Section splitters prefer this over `rawText` when present. */
  markdown?: string;
  /** Link annotations Tier 0 lifted off the PDF. Surfaces URLs hyperlinked
   *  behind visible words; also the only credible recovered signal on
   *  `fonts_unmappable` PDFs where the text path came back empty. Empty
   *  array when Tier 0 found none. */
  linkAnnotations: PdfLinkAnnotation[];
  /** Raw PDF char count vs. extracted char count — used by confidence + telemetry. */
  diagnostics: {
    rawCharCount: number;
    extractedCharCount: number;
    pages: number;
    elapsedMs: number;
    /** Which splitter produced the Tier 1 section boundaries. `markdown`
     *  when the emitter-anchored splitter ran and returned usable sections;
     *  `regex` when it fell back to the line-regex splitter. Absent on the
     *  scanned-abandon path (no Tier 1 ran). */
    sectionSource?: "markdown" | "regex";
  };
  /** Per-tier timings + notes. Populated by the orchestrator. */
  timings: {
    t0_layout_ms: number;
    t1_openresume_ms: number;
    /** Present when Tier 1.5 ran. */
    t1_5_regex_ms?: number;
    /** Fields the regex fallback actually wrote. */
    t1_5_fields_filled?: string[];
  };
}

// ── Telemetry events ────────────────────────────────────────────────────────

/** Cascade schema identifier — bump when event property shapes change. */
export const CASCADE_VERSION = "v1" as const;

/** File-size buckets used in telemetry so raw bytes never leave the browser. */
export type FileSizeBucket =
  | "0-100kb"
  | "100-300kb"
  | "300-600kb"
  | "600-1000kb"
  | "1000kb+";

/** Tier identifier as reported on telemetry events. Numeric strings keep
 *  event-property shapes small and match `ParseMetadata.tiers` keys. */
export type TierId = "0" | "1" | "1_5" | "2" | "3";

/** Reason the orchestrator engaged a tier — helps the funnel split cleanly. */
export type TierEngagementReason =
  | "initial"
  | "tier1_missing_basics"
  | "low_confidence"
  | "two_column_detected"
  | "scanned_detected";

/** Canonical label identifying which path produced the final parsed output. */
export type FinalSource =
  | "tier_1_alone"
  | "tier_1_plus_regex"
  | "tier_1_plus_ner"
  | "tier_3_plus_tier_1"
  | "llm_fallback"
  | "abandoned_scanned"
  | "abandoned_error";

/** `parse_started` — fired once, at cascade entry. */
export interface ParseStartedEvent {
  type: "parse_started";
  cascade_version: typeof CASCADE_VERSION;
  user_type: "anon" | "authed";
  file_size_kb_bucket: FileSizeBucket;
  file_size_kb: number;
  page_count?: number;
}

/** `tier_engaged` — fired before each tier runs. */
export interface TierEngagedEvent {
  type: "tier_engaged";
  cascade_version: typeof CASCADE_VERSION;
  user_type: "anon" | "authed";
  tier: TierId;
  reason: TierEngagementReason;
  elapsed_ms_since_start: number;
}

/** `parse_completed` — fired once, at cascade resolution. */
export interface ParseCompletedEvent {
  type: "parse_completed";
  cascade_version: typeof CASCADE_VERSION;
  user_type: "anon" | "authed";
  final_source: FinalSource;
  total_duration_ms: number;
  confidence: number;
  triggers: LayoutTrigger[];
  /** Bitmask of which tiers ran. Bit 0 = t0, 1 = t1, 2 = t1.5, 3 = t2, 4 = t3. */
  tier_mask: number;
  /** Future-use — always false today (LLM runs after the cascade returns). */
  llm_ran: boolean;
}

export type ParseEvent =
  | ParseStartedEvent
  | TierEngagedEvent
  | ParseCompletedEvent;

// ── Per-parse metadata shape ───────────────────────────────────────────────

/** Per-parse cascade metadata. Useful for callers that want to persist or log
 *  parser internals — kept strict so consumers can rely on the shape. */
export interface ParseMetadata {
  cascade_version: typeof CASCADE_VERSION;
  tiers: {
    "0"?: { ran: boolean; duration_ms: number; triggers: LayoutTrigger[] };
    "1"?: { ran: boolean; duration_ms: number; confidence: number };
    "1_5"?: {
      ran: boolean;
      duration_ms: number;
      fields_filled: string[];
    };
    "2"?: { ran: boolean; duration_ms: number; fields_enhanced?: string[] };
    "3"?: { ran: boolean; duration_ms: number };
  };
  final_source: FinalSource;
  llm_ran: boolean;
  total_duration_ms: number;
}
