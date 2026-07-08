// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Value-locking regression for #369 and #370 — a two-column Google-Docs résumé
 * whose left sidebar (CONTACT / SKILLS / EDUCATION / AWARDS) sits alongside the
 * right-column EXPERIENCE list.
 *
 * Both issues were filed against an earlier reading order that interleaved the
 * `AWARDS` sidebar block into the third experience entry (Initech):
 *   - #369: Initech's company was dropped, the `·` date/location separator bled
 *     into the company slot, and the multi-word city `Pacific Coast` was
 *     corrupted to `Pacific, Coast`.
 *   - #370: every role's `<dates> · <location>` location came back "not detected".
 *
 * Accumulated two-column / sidebar work (page-wide gutter detection now fires —
 * `columnBoundaries` splits the page, so the sidebar reads fully before the
 * experience column) resolved both. This test LOCKS the corrected field values:
 * the lossy `*.expected.json` golden records only `experienceCount: 3` and cannot
 * catch a company drop or a city-value corruption, so a regression would slip
 * past it silently. Asserting the exact mapping here closes that guard gap.
 *
 * Persona is synthetic (Jane Smith / jane.smith@example.com), per the fixtures
 * PII policy — no new PDF, no real-person data.
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
  "tests/fixtures/pdfs/google-docs/google-docs-skia-proxy-two-column.pdf",
);

describe("#369/#370 — two-column sidebar must not corrupt experience fields", () => {
  let parsed: HeuristicParsedResume;

  beforeAll(async () => {
    const bytes = readFileSync(FIXTURE);
    const c = await runCascade(new Uint8Array(bytes));
    parsed = c.parsed;
  });

  it("segments all three roles in source order (sidebar not merged in)", () => {
    const exp = parsed.experience ?? [];
    expect(exp).toHaveLength(3);
    expect(exp.map((e) => e.company)).toEqual([
      "Acme Corp",
      "Globex Corporation",
      "Initech",
    ]);
  });

  it("maps each role's title, company, and per-entry location (#370)", () => {
    const exp = parsed.experience ?? [];
    expect({ title: exp[0].title, company: exp[0].company, location: exp[0].location }).toEqual({
      title: "Senior Software Engineer",
      company: "Acme Corp",
      location: "Springfield, IL",
    });
    expect({ title: exp[1].title, company: exp[1].company, location: exp[1].location }).toEqual({
      title: "Software Engineer",
      company: "Globex Corporation",
      location: "Remote",
    });
    expect({ title: exp[2].title, company: exp[2].company, location: exp[2].location }).toEqual({
      title: "Junior Engineer",
      company: "Initech",
      location: "Pacific Coast, CA",
    });
  });

  it("keeps the Initech entry free of the #369 corruptions", () => {
    const initech = (parsed.experience ?? [])[2];
    // Company is exactly the org — not dropped, no `·` separator bled in.
    expect(initech.company).toBe("Initech");
    expect(initech.company).not.toContain("·");
    // Multi-word city stays whole — not split to "Pacific, Coast".
    expect(initech.location).toBe("Pacific Coast, CA");
    expect(initech.location).not.toContain("Pacific, Coast");
    // No AWARDS sidebar text leaked into any Initech field.
    const blob = [initech.title, initech.company, initech.location, initech.description]
      .filter(Boolean)
      .join(" ");
    expect(blob).not.toMatch(/AWARDS|Excellence|Innovation Prize/i);
  });
});
