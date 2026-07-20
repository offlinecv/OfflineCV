// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * descriptionOverrides edit-leg round-trip (#489).
 *
 * The prose-body project branch (#464/#483) surfaced a parsed project's
 * paragraph `description` as a read-only `<p>` — visible but with no input path,
 * unlike a `•`-bulleted project which is fully editable. #489 adds the
 * `descriptionOverrides` channel so that prose paragraph edits in place. This
 * test is the acceptance proof the issue calls for: a description edit committed
 * through `descriptionOverrides` SURVIVES a Download-PDF round-trip.
 *
 * It reproduces the production recipe exactly (mirroring corpus-edit-roundtrip):
 *
 *   parse1  = runCascade(fixture)
 *   applied = applyOverrides(…, descriptionOverrides={ "projects:<i>": NEW })
 *   display = { ...parse1, canonical: { …, fields: applied.fields } }
 *   parse3  = runCascade(renderAtsResumePdf(buildAtsResumeModel(display, …)))
 *   assert  = NEW description text is IN parse3; the value it replaced is NOT.
 *
 * The edit lands on `applied.fields.projects[i].description`, so the exported
 * model reads it straight off `display` — no separate override pick is needed
 * (contrast bullet/contact edits, which `useDownloadPdf` also passes separately).
 *
 * PII-safe: the assertion is on the authored `NEW_DESCRIPTION` literal (carrying
 * the `Vantreon` sentinel, which must not occur in the corpus) and on the
 * ABSENCE of a runtime-read original value — never a persisted fixture string.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import { scoreForCascade } from "../heuristics/roundtrip-hop.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { applyOverrides } from "./apply-overrides.ts";
import { buildAtsResumeModel } from "../pdf/ats-resume-model.ts";
import { renderAtsResumePdf } from "../pdf/render-ats-pdf.ts";
import { parsedEntryKey } from "../../hooks/useEditableParse.ts";

const FIXTURE = fileURLToPath(
  new URL(
    "../../../tests/fixtures/pdfs/unknown/single-column-projects-prose-body.pdf",
    import.meta.url,
  ),
);

// An authored replacement that MUST NOT occur in the fixture — the `Vantreon`
// sentinel makes the presence check meaningful (a plain sentence could appear
// verbatim and pass even if the edit were discarded).
const NEW_DESCRIPTION =
  "Vantreon rebuilt the résumé intake flow, cutting turnaround 38% across two quarters.";

/** The first parsed project carrying a prose `description` — the exact
 *  `!added && project.description` branch #489 targets. */
function firstProseProject(
  p: CascadeResult,
): { index: number; original: string } {
  const projects = p.canonical.fields.projects ?? [];
  const index = projects.findIndex((proj) => Boolean(proj.description));
  expect(index, "fixture should carry a prose-body project").toBeGreaterThanOrEqual(0);
  return { index, original: projects[index].description! };
}

describe("descriptionOverrides edit-leg round-trip (#489)", { timeout: 20000 }, () => {
  it("a prose-body project description edit survives Download PDF", async () => {
    const p1 = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const { index, original } = firstProseProject(p1);

    // Guard: the sentinel must not already be present, or the presence check
    // below is vacuous.
    expect(JSON.stringify(p1.canonical.fields).includes(NEW_DESCRIPTION)).toBe(false);

    const observations = scoreForCascade(p1).bullets ?? [];
    const applied = applyOverrides(
      p1.canonical.fields,
      p1.rawText,
      p1.canonical.sections,
      {}, // contact
      {}, // experience
      {}, // bullets
      observations,
      {}, // education
      { removed: [], added: [] }, // skills
      [], // addedEntries
      {}, // addedBullets
      new Set<number>(), // removedBullets
      [], // profileOverrides
      p1.canonical.fieldConfidence,
      {}, // achievements
      { [parsedEntryKey("projects", index)]: NEW_DESCRIPTION },
    );

    // 1. The edit is authoritative on the parsed model (feeds display + export).
    expect(applied.fields.projects?.[index]?.description).toBe(NEW_DESCRIPTION);
    // 2. The original parse is never mutated (apply-overrides purity).
    expect(p1.canonical.fields.projects?.[index]?.description).toBe(original);

    // 3. The edit survives the render → re-parse hop (Download PDF round-trip).
    const display: CascadeResult = {
      ...p1,
      canonical: {
        ...p1.canonical,
        fields: applied.fields,
        fieldConfidence: applied.fieldConfidence,
      },
    };
    const model = buildAtsResumeModel(display, scoreForCascade(display), {
      contactOverrides: {},
      bulletOverrides: {},
    });
    const p3 = await runCascade(await renderAtsResumePdf(model));

    const p3Text = JSON.stringify(p3.canonical.fields);
    expect(p3Text.includes(NEW_DESCRIPTION)).toBe(true);
    // The replaced prose is gone — a regression that dropped the edit would make
    // parse3 carry the original text instead.
    expect(p3Text.includes(original)).toBe(false);
  });
});
