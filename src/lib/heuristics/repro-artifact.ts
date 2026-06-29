// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Repro artifact builder — a structure-only, PII-redacted-BY-CONSTRUCTION
 * snapshot of a parse, for the "Report a parsing gap" loop (issue #245).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS FILE NEVER CARRIES RÉSUMÉ TEXT — read before editing.            │
 * │                                                                           │
 * │ resumelint is a PUBLIC repo. A user reporting a parser gap is, by         │
 * │ definition, sitting on top of their OWN résumé — real name, real email,   │
 * │ real phone, real bullet text. If any of that literal text rode along in   │
 * │ the downloadable repro artifact, the user would unknowingly publish their │
 * │ PII the moment they attach the file to a public GitHub issue. The         │
 * │ committed PDF binary is already the hard exposure surface (see CLAUDE.md   │
 * │ "Test fixtures — PII policy"); a text artifact would be a SECOND, softer   │
 * │ one that looks innocuous.                                                  │
 * │                                                                           │
 * │ So the artifact captures ONLY the *shape* of the parse — layout triggers, │
 * │ section boundaries (names + line counts), parse cardinality, and          │
 * │ disagreement KINDS — never a single literal field value. This mirrors the │
 * │ `*.expected.json` corpus snapshots, which are lossy by design             │
 * │ (keys/counts/structure, never values) and therefore PII-free             │
 * │ automatically.                                                            │
 * │                                                                           │
 * │ PII-redacted BY CONSTRUCTION, not by filtering:                           │
 * │   1. The exported `ReproArtifact` type admits ONLY numbers, booleans, and │
 * │      values drawn from fixed enums (LayoutTrigger, section names,         │
 * │      disagreement kinds, the splitter source). There is no free-form      │
 * │      `string` slot a literal résumé value could occupy.                   │
 * │   2. The builder reads counts/enums/booleans off the inputs and NEVER     │
 * │      reads `rawText`, `markdown`, link URLs, parsed scalar VALUES, the    │
 * │      section line text, or `ParseDisagreement.heuristicValue` / `llmValue`│
 * │      (which MAY hold literal text). Those properties are simply untouched. │
 * │                                                                           │
 * │ DO NOT "helpfully" add raw-text capture here (a sample line, the failing  │
 * │ bullet, the recovered email, a link URL, …). Adding it would force you to │
 * │ widen `ReproArtifact` with a free `string` field — which breaks the       │
 * │ load-bearing `repro-artifact.test.ts` PII assertion AND defeats this      │
 * │ comment. If a maintainer needs the literal text to build a fixture, they  │
 * │ re-export the template with a SYNTHETIC persona (CLAUDE.md); they do not  │
 * │ harvest it from a user's report.                                          │
 * │                                                                           │
 * │ Likewise: this builder feeds a LOCAL download only. There is no upload    │
 * │ path, silent or otherwise. Any future ingestion is a separate,           │
 * │ explicitly-consented decision and out of scope here (issue #245).         │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Pure and lib-layer: no React, no I/O. The component serializes the returned
 * object to JSON and hands it to the browser's download path.
 */

import type { CascadeResult, LayoutTrigger } from "./types.ts";
import { CASCADE_VERSION } from "./types.ts";
import type { SectionName } from "./regex.ts";
import type { ParseDisagreement } from "./disagreement.ts";

/** Bump when the artifact field shape changes, so a maintainer triaging an old
 *  attachment knows which builder produced it. Independent of CASCADE_VERSION. */
export const REPRO_ARTIFACT_VERSION = "v1" as const;

/**
 * The structure-only, PII-free repro snapshot.
 *
 * Every field below is a number, a boolean, a fixed enum, or an array of those.
 * There is deliberately NO free-form `string` slot — that is the type-level
 * guarantee that no literal résumé text can ride along. See the file header.
 */
export interface ReproArtifact {
  artifactVersion: typeof REPRO_ARTIFACT_VERSION;
  cascadeVersion: typeof CASCADE_VERSION;
  /** Active layout probes — a fixed enum, no PII. */
  triggers: LayoutTrigger[];
  /** Which splitter produced the section boundaries (provenance), no values. */
  sectionSource: "markdown" | "regex";
  /** Page-level counts — never any text. */
  pageCount: number;
  /** Raw vs. extracted character counts (numbers) — the density signal behind
   *  the scanned/low-extraction triggers. Never the characters themselves. */
  rawCharCount: number;
  extractedCharCount: number;
  /** Detected section boundaries by canonical name with line COUNTS only —
   *  never the line text. This is the "where did the parser cut the document"
   *  signal a maintainer needs to reproduce a mis-section. */
  sections: ReproSection[];
  /** Cardinality of the structured parse — counts/presence, never the values. */
  parsedCounts: ReproParsedCounts;
  /** Count of recovered link annotations — never the URLs themselves. */
  linkAnnotationCount: number;
  /** The reported disagreements as KIND/FIELD/CAUSE only — never the
   *  heuristicValue/llmValue text. Empty when the reporter had not run the
   *  opt-in WebLLM comparison. */
  disagreements: ReproDisagreement[];
}

/** A detected section: its canonical name (enum) and how many lines it held. */
export interface ReproSection {
  name: SectionName | "profile";
  lineCount: number;
}

/** Structured-parse cardinality. Presence flags + counts only — never the
 *  parsed values. A boolean cannot leak an email; a count cannot leak a name. */
export interface ReproParsedCounts {
  hasFullName: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  hasLocation: boolean;
  hasSummary: boolean;
  experienceCount: number;
  educationCount: number;
  skillsCount: number;
}

/** A disagreement reduced to its non-PII shape. The value fields
 *  (`heuristicValue` / `llmValue`) of the source `ParseDisagreement` are
 *  intentionally NOT copied — they may contain literal résumé text. */
export interface ReproDisagreement {
  kind: ParseDisagreement["kind"];
  /** A section/field NAME (`"experience"`, `"email"`) — an enum-like key from
   *  the detector, never a value. */
  field: string;
  likelyCause?: LayoutTrigger;
}

/**
 * Build the structure-only repro artifact from a cascade result and, optionally,
 * the disagreements the reporter had already characterized via the WebLLM pass.
 *
 * Reads ONLY counts, section names, presence flags, and enums. Never reads
 * `rawText`, `markdown`, link URLs, parsed scalar values, section line text, or
 * `ParseDisagreement.heuristicValue` / `llmValue`. See the file header for the
 * PII contract this upholds.
 */
export function buildReproArtifact(
  result: CascadeResult,
  disagreements: readonly ParseDisagreement[] = [],
): ReproArtifact {
  return {
    artifactVersion: REPRO_ARTIFACT_VERSION,
    cascadeVersion: CASCADE_VERSION,
    triggers: [...result.triggers],
    sectionSource: result.sections.source,
    pageCount: result.diagnostics.pages,
    rawCharCount: result.diagnostics.rawCharCount,
    extractedCharCount: result.diagnostics.extractedCharCount,
    sections: buildSections(result),
    parsedCounts: buildParsedCounts(result),
    linkAnnotationCount: result.linkAnnotations.length,
    disagreements: disagreements.map((d) => ({
      kind: d.kind,
      field: d.field,
      ...(d.likelyCause ? { likelyCause: d.likelyCause } : {}),
    })),
  };
}

/** Section boundaries: canonical name + line count, in document order. Reads
 *  the `byName` map's KEYS (enum names) and array LENGTHS — never the lines. */
function buildSections(result: CascadeResult): ReproSection[] {
  const out: ReproSection[] = [];
  for (const [name, lines] of result.sections.byName) {
    out.push({ name, lineCount: lines.length });
  }
  return out;
}

/** Presence flags + counts off the structured parse. `present` returns a
 *  BOOLEAN — the scalar VALUE never enters the artifact. */
function buildParsedCounts(result: CascadeResult): ReproParsedCounts {
  const p = result.parsed;
  const present = (v: string | null | undefined): boolean =>
    v != null && v.trim().length > 0;
  return {
    hasFullName: present(p.full_name),
    hasEmail: present(p.email),
    hasPhone: present(p.phone),
    hasLocation: present(p.location),
    hasSummary: present(p.summary),
    experienceCount: p.experience.length,
    educationCount: p.education.length,
    skillsCount: p.skills.length,
  };
}
