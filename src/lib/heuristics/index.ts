// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Client-side heuristic resume parser cascade.
 *
 * Public surface is intentionally small. Callers get:
 *   - `runCascade(pdfBytes, { onEvent })` — the entry point.
 *   - Types for the result shape.
 *   - The canonical confidence threshold.
 *   - `ParseEvent` types so a host can wire its own telemetry sink to the
 *     optional `onEvent` callback.
 *
 * Internals (pdf-extract, pdf-layout, openresume, extract-fields,
 * regex-fallback) are dynamic-imported from `cascade.ts` so they land in
 * separate bundle chunks. Consumers should not import internals directly —
 * doing so bloats the entry chunk and defeats the lazy-load design.
 */

export { runCascade, runCascadeFromMarkdown } from "./cascade.ts";
export type {
  RunCascadeOptions,
  RunCascadeFromMarkdownOptions,
} from "./cascade.ts";
export {
  CANONICAL_CONFIDENCE_THRESHOLD,
  EXTRACTION_RATIO_FLOOR,
  NAME_CONFIDENCE_FLOOR,
  SOFT_PENALTY,
  FIELD_CONFIDENCE_TARGETS,
  FIELD_WEIGHTS,
  TWO_COLUMN_CONFIDENCE_CAP,
  getThresholdsFor,
} from "./thresholds.ts";
export type { CascadeBranch, CascadeThresholds } from "./thresholds.ts";
export { CASCADE_VERSION } from "./types.ts";
// Markdown emitter. Exported so callers can reuse it against locally
// extracted `PdfTextItem[]` without re-running the cascade.
export { emitMarkdown } from "./markdown-emit.ts";
export type { RenderLine } from "./markdown-emit.ts";
export type {
  CascadeResult,
  HeuristicResult,
  HeuristicParsedResume,
  FieldConfidence,
  LayoutProbes,
  LayoutTrigger,
  EscalationSuggestion,
  ExtractionFailureReason,
  PdfExtractResult,
  PdfLinkAnnotation,
  PdfTextItem,
  PdfPageInfo,
  ParseEvent,
  ParseStartedEvent,
  TierEngagedEvent,
  ParseCompletedEvent,
  TierId,
  TierEngagementReason,
  FinalSource,
  FileSizeBucket,
  ParseMetadata,
} from "./types.ts";
