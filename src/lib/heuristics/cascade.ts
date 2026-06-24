// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Cascade orchestrator.
 *
 * Runs Tier 0 (PDF extraction + layout probes) → Tier 1 (heuristic parser) →
 * Tier 1.5 (regex fallback, when Tier 1 missed the basics). Tiers 2 (NER)
 * and 3 (OCR) are follow-up phases — this module exposes hooks so they can
 * be wired in without rewriting the orchestration.
 *
 * All tier modules are invoked via dynamic `import()` so the bundler emits
 * each one as a separate chunk. Consumers that don't use a particular tier
 * pay nothing for it at bundle time.
 *
 * Emits optional `ParseEvent`s through the caller-provided `onEvent`
 * callback. The callback is the single integration seam for telemetry —
 * keeps the package itself provider-agnostic.
 */

import type {
  CascadeResult,
  HeuristicResult,
  LayoutProbes,
  LayoutTrigger,
  PdfLinkAnnotation,
  ParseEvent,
  FinalSource,
  FileSizeBucket,
  TierEngagementReason,
} from "./types.ts";
import { CASCADE_VERSION } from "./types.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "./sections.ts";
import { computeConfidence } from "./confidence.ts";

export interface RunCascadeOptions {
  /** Optional abort signal to bail out of a long extraction. */
  signal?: AbortSignal;
  /** Where to emit telemetry events. Silent when omitted. */
  onEvent?: (event: ParseEvent) => void;
  /** Identifies the caller's identity surface. Defaults to "authed". */
  userType?: "anon" | "authed";
}

/**
 * Run Tier 0 + Tier 1 (+ Tier 1.5 when needed) against a PDF byte buffer.
 *
 * This is the public entry point. Keep it small — all non-trivial logic lives
 * in `pdf-extract.ts`, `pdf-layout.ts`, `openresume.ts`, `regex-fallback.ts`,
 * dynamic-imported below so each becomes its own bundle chunk.
 */
export async function runCascade(
  pdfBytes: Uint8Array | ArrayBuffer,
  options: RunCascadeOptions = {},
): Promise<CascadeResult> {
  const start = Date.now();
  const onEvent = options.onEvent;
  const userType = options.userType ?? "authed";
  const fileSizeBytes =
    pdfBytes instanceof Uint8Array ? pdfBytes.byteLength : pdfBytes.byteLength;
  const fileSizeKb = Math.round(fileSizeBytes / 1024);

  const emit = (event: ParseEvent) => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // Analytics must never break parsing — swallow callback failures.
    }
  };

  // ── Tier 0: PDF extraction + layout probes ────────────────────────────────

  emit({
    type: "parse_started",
    cascade_version: CASCADE_VERSION,
    user_type: userType,
    file_size_kb: fileSizeKb,
    file_size_kb_bucket: bucketFileSize(fileSizeKb),
  });
  emit(tierEngaged(userType, "0", "initial", start));

  const t0Start = Date.now();
  const { extractFromPdfBytes } = await import("./pdf-extract.ts");
  const extract = await extractFromPdfBytes(pdfBytes);
  const { analyzeLayout } = await import("./pdf-layout.ts");
  const layout = analyzeLayout(
    extract.items,
    extract.pages,
    extract.extractionFailureReason,
  );

  // Markdown emission. Skip on scanned PDFs — no positional signal to emit
  // structure from. Emitter may also return undefined when the document is
  // too sparse; downstream falls back to rawText.
  let markdown: string | undefined;
  if (!layout.isScanned) {
    const { emitMarkdown } = await import("./markdown-emit.ts");
    markdown = emitMarkdown(
      extract.items,
      extract.pages,
      extract.columnBoundaries,
    );
  }

  const t0Duration = Date.now() - t0Start;

  // Escalation reason for the upcoming tier — surfaces in the tier_engaged
  // event so the funnel breakdown sees why each step fired.
  const tier1Reason: TierEngagementReason = layout.isScanned
    ? "scanned_detected"
    : layout.isTwoColumn
      ? "two_column_detected"
      : "initial";

  // If Tier 0 says the PDF is scanned (or fonts-unmappable, where the
  // text path is empty for the same reason), short-circuit. Running Tier 1
  // is guaranteed-zero signal and only inflates latency. The
  // `fonts_unmappable` path still surfaces link annotations to the caller
  // so the user gets a credible recovered signal.
  if (layout.isScanned) {
    const result = buildScannedResult(
      extract,
      layout,
      extract.linkAnnotations,
      start,
      t0Duration,
    );
    emit(
      parseCompleted(userType, result, "abandoned_scanned", false, [
        "t0_layout",
      ]),
    );
    return result;
  }

  // ── Tier 1: OpenResume heuristic parser ───────────────────────────────────

  emit(tierEngaged(userType, "1", tier1Reason, start));

  const t1Start = Date.now();
  const { parseHeuristic } = await import("./openresume.ts");
  const heuristic = parseHeuristic(
    extract.items,
    extract.pages,
    markdown,
    extract.linkAnnotations,
    extract.columnBoundaries,
  );
  const t1Duration = Date.now() - t1Start;

  let parsed = heuristic.parsed;
  let fieldConfidence = heuristic.fieldConfidence;
  let extractedCharCount = countExtractedChars(parsed);

  // ── Tier 1.5: regex fallback for missing contact basics ───────────────────

  const t15Fields: string[] = [];
  let t15Duration = 0;
  let ranT15 = false;
  if (shouldRunRegexFallback(parsed)) {
    emit(tierEngaged(userType, "1_5", "tier1_missing_basics", start));
    const t15Start = Date.now();
    const { runRegexFallback } = await import("./regex-fallback.ts");
    const fallback = runRegexFallback(
      parsed,
      fieldConfidence,
      extract.text,
      extract.linkAnnotations,
    );
    t15Duration = Date.now() - t15Start;
    ranT15 = true;
    parsed = fallback.parsed;
    fieldConfidence = fallback.fieldConfidence;
    t15Fields.push(...fallback.fieldsFilled);
    extractedCharCount = countExtractedChars(parsed);
  }

  // ── Confidence + escalation routing ───────────────────────────────────────

  const { confidence, suggestedEscalation } = computeConfidence({
    heuristic: { parsed, fieldConfidence, sections: heuristic.sections },
    layout,
    rawCharCount: extract.rawCharCount,
    extractedCharCount,
  });

  const tiers: CascadeResult["tiers"] = ["t0_layout", "t1_openresume"];
  if (ranT15) tiers.push("t1_5_regex");

  const result: CascadeResult = {
    parsed,
    confidence,
    fieldConfidence,
    triggers: layout.triggers,
    suggestedEscalation,
    tiers,
    rawText: extract.text,
    markdown,
    sections: heuristic.sections,
    linkAnnotations: extract.linkAnnotations,
    diagnostics: {
      rawCharCount: extract.rawCharCount,
      extractedCharCount,
      pages: extract.pages.length,
      elapsedMs: Date.now() - start,
      ...(heuristic.sectionSource
        ? { sectionSource: heuristic.sectionSource }
        : {}),
    },
    timings: {
      t0_layout_ms: t0Duration,
      t1_openresume_ms: t1Duration,
      t1_5_regex_ms: ranT15 ? t15Duration : undefined,
      t1_5_fields_filled: ranT15 ? t15Fields : undefined,
    },
  };

  emit(parseCompleted(userType, result, deriveFinalSource(result), false, tiers));
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tierEngaged(
  userType: "anon" | "authed",
  tier: "0" | "1" | "1_5" | "2" | "3",
  reason: TierEngagementReason,
  start: number,
): ParseEvent {
  return {
    type: "tier_engaged",
    cascade_version: CASCADE_VERSION,
    user_type: userType,
    tier,
    reason,
    elapsed_ms_since_start: Date.now() - start,
  };
}

function parseCompleted(
  userType: "anon" | "authed",
  result: CascadeResult,
  finalSource: FinalSource,
  llmRan: boolean,
  tiers: CascadeResult["tiers"],
): ParseEvent {
  return {
    type: "parse_completed",
    cascade_version: CASCADE_VERSION,
    user_type: userType,
    final_source: finalSource,
    total_duration_ms: result.diagnostics.elapsedMs,
    confidence: result.confidence,
    triggers: result.triggers,
    tier_mask: tierMask(tiers),
    llm_ran: llmRan,
  };
}

function tierMask(tiers: CascadeResult["tiers"]): number {
  let mask = 0;
  for (const tier of tiers) {
    if (tier === "t0_layout") mask |= 1 << 0;
    else if (tier === "t1_openresume") mask |= 1 << 1;
    else if (tier === "t1_5_regex") mask |= 1 << 2;
    else if (tier === "t2_ner") mask |= 1 << 3;
    else if (tier === "t3_ocr") mask |= 1 << 4;
  }
  return mask;
}

function bucketFileSize(kb: number): FileSizeBucket {
  if (kb < 100) return "0-100kb";
  if (kb < 300) return "100-300kb";
  if (kb < 600) return "300-600kb";
  if (kb < 1000) return "600-1000kb";
  return "1000kb+";
}

function shouldRunRegexFallback(parsed: CascadeResult["parsed"]): boolean {
  return !parsed.full_name || !parsed.email || !parsed.phone;
}

function deriveFinalSource(result: CascadeResult): FinalSource {
  if (result.tiers.includes("t1_5_regex")) return "tier_1_plus_regex";
  return "tier_1_alone";
}

// ── DOCX / markdown entry point ────────────────────────────────────────────

export interface RunCascadeFromMarkdownOptions extends RunCascadeOptions {
  /** Approximate size of the source file (for telemetry bucketing). When
   *  omitted we report `0-100kb` — DOCX uploads typically land there and
   *  the exact number adds little for analytics. */
  fileSizeKb?: number;
}

/**
 * Run Tier 1 (+ Tier 1.5 when needed) against pre-extracted markdown +
 * raw text. Shares the event shape, confidence gate, and result contract
 * with the PDF `runCascade`, so downstream consumers see one canonical
 * `CascadeResult` regardless of source.
 *
 * Tier 0 PDF layout probes don't apply — we synthesize a neutral
 * `LayoutProbes` (nothing scanned / column / table) so the confidence
 * scorer runs the same branch that a clean single-column PDF would.
 */
export async function runCascadeFromMarkdown(
  rawText: string,
  markdown: string | undefined,
  options: RunCascadeFromMarkdownOptions = {},
): Promise<CascadeResult> {
  const start = Date.now();
  const onEvent = options.onEvent;
  const userType = options.userType ?? "authed";
  const fileSizeKb = options.fileSizeKb ?? 0;

  const emit = (event: ParseEvent) => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // Analytics must never break parsing — swallow callback failures.
    }
  };

  emit({
    type: "parse_started",
    cascade_version: CASCADE_VERSION,
    user_type: userType,
    file_size_kb: fileSizeKb,
    file_size_kb_bucket: bucketFileSize(fileSizeKb),
  });

  // Tier 0 here is "we already have text + markdown, no layout probe
  // needed". We still emit a tier_engaged event so the funnel breakdown
  // is comparable to PDF.
  emit(tierEngaged(userType, "0", "initial", start));
  const t0Duration = 0;

  // Without markdown we can still run the regex fallback against raw text,
  // but Tier 1 section detection is ~nothing to work with. Skip Tier 1
  // and hand off directly to the fallback in that case.
  const haveMarkdown = !!markdown && markdown.trim().length > 0;

  emit(tierEngaged(userType, "1", "initial", start));
  const t1Start = Date.now();
  const { parseHeuristicFromMarkdown } = await import("./openresume.ts");
  const heuristic: HeuristicResult = haveMarkdown
    ? parseHeuristicFromMarkdown(markdown as string, rawText)
    : {
        parsed: emptyParsed(),
        fieldConfidence: {},
        // No Tier 1 ran (no markdown) — empty section view, inert (#132).
        sections: {
          byName: new Map(),
          accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
          source: "regex",
        },
      };
  const t1Duration = Date.now() - t1Start;

  let parsed = heuristic.parsed;
  let fieldConfidence = heuristic.fieldConfidence;
  let extractedCharCount = countExtractedChars(parsed);

  const t15Fields: string[] = [];
  let t15Duration = 0;
  let ranT15 = false;
  if (shouldRunRegexFallback(parsed)) {
    emit(tierEngaged(userType, "1_5", "tier1_missing_basics", start));
    const t15Start = Date.now();
    const { runRegexFallback } = await import("./regex-fallback.ts");
    const fallback = runRegexFallback(parsed, fieldConfidence, rawText);
    t15Duration = Date.now() - t15Start;
    ranT15 = true;
    parsed = fallback.parsed;
    fieldConfidence = fallback.fieldConfidence;
    t15Fields.push(...fallback.fieldsFilled);
    extractedCharCount = countExtractedChars(parsed);
  }

  // Neutral layout probes — DOCX cascade has no x/y positional data, so
  // nothing is "scanned / two-column" from the cascade's point of view.
  // The confidence scorer still applies its hard-fail guards (name, email,
  // experience).
  const layout: LayoutProbes = {
    isScanned: false,
    isTwoColumn: false,
    triggers: [],
  };

  const { confidence, suggestedEscalation } = computeConfidence({
    heuristic: { parsed, fieldConfidence, sections: heuristic.sections },
    layout,
    // We pass rawCharCount=0 so the "low extraction ratio" hard-fail can't
    // fire — DOCX text extraction from mammoth is effectively complete by
    // construction, and comparing extracted-vs-raw would pick up prose
    // that's validly absent (e.g. objective sections).
    rawCharCount: 0,
    extractedCharCount,
  });

  const tiers: CascadeResult["tiers"] = ["t0_layout", "t1_openresume"];
  if (ranT15) tiers.push("t1_5_regex");

  const result: CascadeResult = {
    parsed,
    confidence,
    fieldConfidence,
    triggers: [],
    suggestedEscalation,
    tiers,
    rawText,
    markdown,
    sections: heuristic.sections,
    // DOCX cascade has no PDF annotations.
    linkAnnotations: [],
    diagnostics: {
      rawCharCount: rawText.length,
      extractedCharCount,
      pages: 1,
      elapsedMs: Date.now() - start,
      ...(heuristic.sectionSource
        ? { sectionSource: heuristic.sectionSource }
        : {}),
    },
    timings: {
      t0_layout_ms: t0Duration,
      t1_openresume_ms: t1Duration,
      t1_5_regex_ms: ranT15 ? t15Duration : undefined,
      t1_5_fields_filled: ranT15 ? t15Fields : undefined,
    },
  };

  emit(
    parseCompleted(userType, result, deriveFinalSource(result), false, tiers),
  );
  return result;
}

function emptyParsed(): CascadeResult["parsed"] {
  return {
    skills: [],
    skills_explicit: [],
    skills_inferred: [],
    experience: [],
    education: [],
  };
}

function buildScannedResult(
  extract: { text: string; rawCharCount: number; pages: unknown[] },
  layout: { triggers: LayoutTrigger[] },
  linkAnnotations: PdfLinkAnnotation[],
  start: number,
  t0Duration: number,
): CascadeResult {
  return {
    parsed: {
      skills: [],
      skills_explicit: [],
      skills_inferred: [],
      experience: [],
      education: [],
    },
    confidence: 0,
    fieldConfidence: {},
    triggers: layout.triggers,
    suggestedEscalation: "ocr",
    tiers: ["t0_layout"],
    rawText: extract.text,
    // Scanned-abandon path: no Tier 1 ran, so there are no detected sections.
    // An empty view yields `byName.get("skills") === undefined`, exactly the
    // inert behaviour the absent `skillsSectionText` gave here before (#132).
    sections: {
      byName: new Map(),
      accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
      source: "regex",
    },
    linkAnnotations,
    diagnostics: {
      rawCharCount: extract.rawCharCount,
      extractedCharCount: 0,
      pages: extract.pages.length,
      elapsedMs: Date.now() - start,
    },
    timings: {
      t0_layout_ms: t0Duration,
      t1_openresume_ms: 0,
    },
  };
}

/** Sum visible character counts across the heuristic parse output. */
function countExtractedChars(parsed: CascadeResult["parsed"]): number {
  let n = 0;
  n += (parsed.full_name ?? "").length;
  n += (parsed.email ?? "").length;
  n += (parsed.phone ?? "").length;
  n += (parsed.location ?? "").length;
  n += (parsed.summary ?? "").length;
  for (const s of parsed.skills ?? []) n += s.length;
  for (const e of parsed.experience ?? []) {
    n += (e.company ?? "").length;
    n += (e.title ?? "").length;
    n += (e.team ?? "").length;
    n += (e.description ?? "").length;
  }
  for (const e of parsed.education ?? []) {
    n += (e.institution ?? "").length;
    n += (e.degree ?? "").length;
  }
  return n;
}
