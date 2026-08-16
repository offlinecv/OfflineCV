// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Value-locking regression for #574 — a two-column résumé whose sidebar sits on
 * the LEFT, so the whole résumé BODY lands on the high-x side of the gutter.
 *
 * `detectColumnBoundaries` reports only WHERE the gutter is. Reading the
 * secondary column off it as `line.x >= columnSplitX` names the sidebar only on
 * a sidebar-RIGHT layout; on this fixture the polarity inverts, and every body
 * line reached `matchSectionAnchorToken` — the deliberately guard-free
 * trailing-anchor lookup that #117 licensed on the strength of that column
 * signal alone. Role 2's employer `NGP Professional Education` then opened an
 * `education` section mid-experience and swallowed the rest of the document:
 * the parse came back with 2 roles instead of 3, role 2's company blanked, and
 * role 3 gone entirely. `splitIntoSections` now resolves each line to a
 * {@link ColumnBand} by band WIDTH, so the guard-free lookup runs on the narrow
 * rail whichever side it is on, and never on the body.
 *
 * Why the fixture's employer is a three-token name and not the two-token
 * `Northgate Education` the issue body cites: that plainer form never reaches
 * this code path. It satisfies every one of `matchAnchorFallback`'s guards and
 * is consumed by the GUARDED text-only matcher upstream — a different defect on
 * a different layer. `NGP Professional Education` is rejected there (Guard 8,
 * the #258 fix) and so probes the unguarded path and nothing else.
 *
 * The `*.expected.json` golden records `experienceCount`, so it catches the
 * dropped role — but not the blanked company or a mis-filed education entry,
 * which are exactly what a re-widened gate would corrupt first. Asserting the
 * values here closes that gap.
 *
 * Persona is synthetic (Rowan Ellis / rowan.ellis@example.com / (503) 555-0142),
 * per the fixtures PII policy. Generator:
 * `scripts/fixtures/gen-sidebar-left-anchor-company.mjs`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "./cascade.ts";
import type { CascadeResult } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/unknown/two-column-sidebar-left-anchor-company.pdf",
);

describe("#574 — a sidebar-LEFT body must not run the unguarded anchor lookup", () => {
  let cascade: CascadeResult;

  beforeAll(async () => {
    cascade = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
  });

  it("routes sections through the line-regex splitter on a two-column page", () => {
    // The band gate lives in `splitIntoSections`; the markdown-anchored splitter
    // bypasses it. If the emitter ever starts promoting this fixture's headers,
    // every assertion below would pass for the wrong reason.
    expect(cascade.triggers).toContain("two_column");
    expect(cascade.diagnostics.sectionSource).toBe("regex");
  });

  it("keeps all three roles, with role 2's anchor-ending employer intact", () => {
    const exp = cascade.canonical.fields.experience ?? [];
    expect(exp).toHaveLength(3);
    expect(exp.map((e) => e.company)).toEqual([
      "Cascade Logistics Group",
      "NGP Professional Education",
      "Harbor Point Systems",
    ]);
    expect(exp.map((e) => e.title)).toEqual([
      "Lead Platform Engineer",
      "Staff Engineer",
      "Software Engineer",
    ]);
  });

  it("opens exactly one education section, holding only the real degree", () => {
    const edu = cascade.canonical.fields.education ?? [];
    expect(edu).toHaveLength(1);
    expect(edu[0].institution).toBe("State University");
    // No role bullet became an institution, no bullet fragment became coursework.
    expect(edu[0].institution).not.toContain("NGP");
    expect(edu[0].coursework ?? []).toHaveLength(0);
  });
});
