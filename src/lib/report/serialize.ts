// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * report/serialize — the machine-readable half of the shareable audit report
 * (#343).
 *
 * Turns the audit findings (`AnonymousAtsScore` + layout triggers +
 * recommendation) into a versioned, deterministic JSON document, fully
 * client-side. This is the JSON counterpart to `render-audit-report.ts` (the
 * PDF); both consume the same `AuditReportInput` so the two formats never
 * disagree.
 *
 * PRIVACY GATE (the load-bearing rule): the default report is anonymous. The
 * candidate's identity header (name / email / phone / links / location) is
 * emitted ONLY when the caller opts in (`includeIdentity: true`) AND supplies
 * an `identity` block. With identity off — the default — `identity` is omitted
 * entirely, so the artifact carries NO name, email, phone, or profile URL and
 * is safe to share publicly. `buildAuditReportJson` re-checks the flag itself
 * (belt-and-suspenders): even if a caller passes an `identity` block with the
 * flag off, it is dropped.
 *
 * Pure — no pdf-lib, no I/O. `identity`, when present, is the SAME
 * `JsonResumeBasics` shape #334's `toJsonResume()` produces (`basics`), so the
 * report's header block is lossless and consistent with the résumé export.
 */

import type { AnonymousAtsScore } from "../score/score.ts";
import type { LayoutTrigger } from "../heuristics/types.ts";
import type { JsonResumeBasics } from "../pdf/to-json-resume.ts";
import { APP_VERSION } from "../version.ts";

/**
 * Report schema version. Bump when the JSON SHAPE changes (a field added,
 * removed, or renamed) so downstream tooling that diffs runs can detect it.
 * Distinct from `algoVersion` (the scoring algorithm) and `app.version` (the
 * build id) — this versions the envelope, not the numbers inside it.
 */
export const REPORT_VERSION = "1.0";

/** The findings both report formats render. Assembled by the download hook. */
export interface AuditReportInput {
  score: AnonymousAtsScore;
  /** Fired layout triggers (from `CascadeResult.triggers` / `score.layout`). */
  triggers: readonly LayoutTrigger[];
  /** The one-sentence recommendation (`getScoreRecommendation`). */
  recommendation: string;
  /** ISO-8601 generation timestamp, injected by the caller so the builder
   *  stays pure/deterministic under test. */
  generatedAt: string;
  /** Whether to include the candidate's identity header. Default-off upstream. */
  includeIdentity: boolean;
  /** Identity header block (JSON Resume `basics`). Included ONLY when
   *  `includeIdentity` is true; omit otherwise. */
  identity?: JsonResumeBasics;
}

/** The serialized audit-report document shape.
 *
 *  `score` is the anonymous score MINUS its `bullets` array: `AnonymousAtsScore`
 *  keeps a `BulletObservation[]` whose `text` is the verbatim résumé bullet
 *  (employer / project / sometimes the candidate's own name) — that is PII and
 *  must never ride in the shareable report. The overall + per-dimension scores,
 *  triggers, and recommendation carry the transparency the report needs without
 *  it. See `buildAuditReportJson`. */
export interface AuditReportJson {
  reportVersion: string;
  generatedAt: string;
  app: { version: string };
  algoVersion?: string;
  score: Omit<AnonymousAtsScore, "bullets">;
  triggers: LayoutTrigger[];
  recommendation: string;
  /** Present ONLY when the user opted into including identity. */
  identity?: JsonResumeBasics;
}

/**
 * Build the audit-report document. Pure. Enforces the privacy gate on two
 * channels:
 *   1. The `identity` block is attached only when `includeIdentity` is true AND
 *      an identity block was supplied — never otherwise.
 *   2. `score.bullets` (verbatim résumé bullet text — PII) is ALWAYS stripped,
 *      irrespective of the identity flag. This is an unconditional content
 *      strip: the shareable report never carries accomplishment-line text.
 */
export function buildAuditReportJson(input: AuditReportInput): AuditReportJson {
  // Drop the PII-bearing `bullets` (each `text` is a verbatim résumé line) from
  // the embedded score. Unconditional — not gated on `includeIdentity`.
  const { bullets: _bullets, ...score } = input.score;
  const doc: AuditReportJson = {
    reportVersion: REPORT_VERSION,
    generatedAt: input.generatedAt,
    app: { version: APP_VERSION },
    algoVersion: input.score.algoVersion,
    score,
    triggers: [...input.triggers],
    recommendation: input.recommendation,
  };
  if (input.includeIdentity && input.identity) {
    doc.identity = input.identity;
  }
  return doc;
}

/** Serialize the audit report to a pretty-printed JSON string. */
export function serializeAuditReportJson(input: AuditReportInput): string {
  return JSON.stringify(buildAuditReportJson(input), null, 2);
}
