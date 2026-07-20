// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Repro regression for #283 — a page running-header/footer line
 * ("June 3, 2026  Jane Smith · Résumé 1") that falls on a page break INSIDE the
 * Work Experience section used to be absorbed as the company/title of the first
 * role on the next page, dropping that role's real title.
 *
 * The furniture strip already existed for the achievements path (#225); #283
 * promotes `isPageFurniture` to `line-primitives.ts` and filters it centrally in
 * `parseEntryBlocks`, so every entry path (experience/projects/achievements)
 * drops the footer before anchor detection.
 *
 * Reproduces on the in-tree synthetic fixture
 * `tests/fixtures/pdfs/latex/awesome-cv-resume.pdf` (persona: Jane Smith /
 * jane.smith@example.com, a `Jane Smith · Résumé N` running footer). No new PDF
 * and no real-person PII — the fixture is synthetic. The lossy `*.expected.json`
 * golden records only counts and cannot catch a title/company swap, so this
 * asserts the exact field mapping directly.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "./cascade.ts";
import type { HeuristicParsedResume } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/latex/awesome-cv-resume.pdf",
);

// Footer tokens that must never leak into any experience field once furniture is
// stripped: the running-footer date, name, "Résumé", and the page number tail.
const FOOTER_TOKENS = ["Résumé", "Resume", "Jane Smith", "June 3, 2026"];

describe("#283 — page footer bleeds into experience roles across page breaks", () => {
  let parsed: HeuristicParsedResume;

  beforeAll(async () => {
    const bytes = readFileSync(FIXTURE);
    const c = await runCascade(new Uint8Array(bytes));
    parsed = c.canonical.fields;
  });

  it("parses the first page-2 role (Kasa) with its real title, footer stripped", () => {
    const exp = parsed.experience ?? [];
    // The footer corrupted an existing role rather than minting one, so the
    // count is unchanged — no spurious dateless role.
    expect(exp).toHaveLength(8);

    const kasa = exp[3];
    expect(kasa.title).toBe(
      "Founding Member & Director of Infrastructure Division",
    );
    // This two-column fixture folds the right-column location onto the company
    // line for every role. #283 stopped the footer from displacing it; #287 then
    // split the folded location off, so company is the clean org and the folded
    // "Seoul, S.Korea" lands in `location` (Pass D of stripLocationSuffix).
    expect(kasa.company).toBe("Kasa");
    expect(kasa.location).toBe("Seoul, S.Korea");
    expect(kasa.start_date).toBe("Jun. 2018");
    expect(kasa.end_date).toBe("Jan. 2021");
  });

  it("leaves no footer text in any experience field", () => {
    const exp = parsed.experience ?? [];
    for (const role of exp) {
      const blob = [role.title, role.company, role.location, role.description]
        .filter(Boolean)
        .join(" ");
      for (const token of FOOTER_TOKENS) {
        expect(blob).not.toContain(token);
      }
    }
  });
});
