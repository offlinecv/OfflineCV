// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ats-export-projection — the export-semantic view of an {@link AtsResumeModel},
 * split apart from the render model so the JSON-Resume adapter
 * (`to-json-resume.ts`, #334) never reaches into the renderer's layout fields.
 *
 * The render model (`ats-resume-model.ts`) welds two concerns onto each entry:
 * the export-semantic source (`fields`, the section `kind`, the `bullets` body)
 * AND the layout hints the PDF renderer draws from (`headerLine`,
 * `headerLineDate`, `subLine`, `subLineDate`, `atomicSegments`, `headerBold`).
 * {@link projectAtsExport} keeps ONLY the former, dropping every layout hint —
 * so the export path is structurally decoupled from how the PDF looks (#442,
 * Stage A of the canonical-résumé-model migration). Stage B repoints this
 * projection at `CanonicalResume`.
 *
 * This is a PURE, allocation-light map: it copies the `fields` object and
 * `bullets` array by REFERENCE (both are read-only downstream — the mappers in
 * `to-json-resume.ts` never mutate them), preserving them per entry in document
 * order, flattened across sections with each entry tagged by its section kind.
 */

import type {
  AtsResumeModel,
  AtsContact,
  AtsEntryFields,
  AtsSectionKind,
} from "./ats-resume-model.ts";

/**
 * One export-semantic entry: its JSON-Resume mapping hint ({@link AtsSectionKind},
 * `undefined` on sections the export doesn't model), the structured source
 * {@link AtsEntryFields}, and the `bullets` body. Carries NONE of the render
 * model's layout hints (`headerLine`, `subLine`, dates, `atomicSegments`,
 * `headerBold`) — those never reach the JSON-Resume mapping.
 */
export interface AtsExportEntry {
  readonly kind: AtsSectionKind | undefined;
  /** Structured export source; absent on synthesized entries that carry none
   *  (mirrors {@link AtsEntry.fields}). */
  readonly fields?: AtsEntryFields;
  readonly bullets: readonly string[];
}

/**
 * The complete export-semantic surface projected from an {@link AtsResumeModel}:
 * the contact identity (source for `basics`) plus a flat, document-order list of
 * {@link AtsExportEntry}. This is the ONLY input the JSON-Resume entry mapping
 * reads — it never touches the render model's `AtsEntry`/`AtsSection` layout
 * types.
 */
export interface AtsExportProjection {
  readonly contact: AtsContact;
  readonly entries: readonly AtsExportEntry[];
}

/**
 * Project an {@link AtsResumeModel} onto its export-semantic {@link
 * AtsExportProjection}: flatten `sections[].entries[]` into a single
 * document-order list, tag each entry with its section `kind`, and carry only
 * `fields` + `bullets` — dropping every layout hint. PURE; no I/O, no mutation.
 */
export function projectAtsExport(model: AtsResumeModel): AtsExportProjection {
  const entries: AtsExportEntry[] = [];
  for (const section of model.sections) {
    for (const entry of section.entries) {
      entries.push({
        kind: section.kind,
        fields: entry.fields,
        bullets: entry.bullets,
      });
    }
  }
  return { contact: model.contact, entries };
}
