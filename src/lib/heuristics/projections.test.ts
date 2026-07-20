// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Faithfulness gate for the Stage B canonical projections (#443).
 *
 * `runCascade` now builds a `CanonicalResume` and hands its cores back out as
 * the `CascadeResult` façade; the scorer and `ReconstructedResume` read section
 * pools / display fields through `projectScoreSections` / `projectDisplay`
 * instead of off the cascade result directly. This is behaviour-preserving ONLY
 * if the projections reproduce exactly what the direct reads returned. Two
 * proofs here:
 *
 *   1. **Unit** — the projections and the canonical constructor carry their
 *      cores by reference (identity-holder, Stage B), so display/score reads are
 *      the same objects the façade held.
 *   2. **Corpus (re-derivation tripwire)** — over the WHOLE fixture corpus,
 *      build a canonical model from DEEP-CLONED cores (so reference identity
 *      can't mask a content bug) and assert the score projection deep-equals the
 *      cascade's `sections` and reproduces the same score. With Stage B's
 *      identity-holder bodies this is near-trivially true; its job is to FIRE
 *      when a later stage swaps a body to re-derivation and the re-derived pools
 *      drift. The byte-identical Stage-B behaviour proof proper is the unchanged
 *      corpus goldens in `heuristics/corpus.test.ts`, not this file.
 *
 * Fixtures are synthetic personas only — see tests/fixtures/pdfs/README.md.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { toCanonicalResume, type CanonicalResume } from "./canonical.ts";
import {
  projectScoreSections,
  projectDisplay,
  projectLlmDiff,
} from "./projections.ts";
import type { LlmParsedResume } from "../webllm/parse-resume.ts";
import { runCascade } from "./cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { SectionedResume } from "./sections.ts";
import type { HeuristicParsedResume } from "./types.ts";

describe("canonical projections — identity-holder semantics (#443, Stage B)", () => {
  const fields = {
    full_name: "Jane Candidate",
    skills: ["TypeScript"],
    experience: [],
    education: [],
  } satisfies HeuristicParsedResume;
  const sections: SectionedResume = {
    byName: new Map([["skills", ["TypeScript · React"]]]),
    accomplishmentSections: ["experience", "projects", "achievements"],
    sectionHeadings: new Map([["skills", "Technical Skills"]]),
    source: "markdown",
  };
  const fieldConfidence = { full_name: 1, skills: 0.8 };
  const canonical: CanonicalResume = toCanonicalResume(
    fields,
    sections,
    fieldConfidence,
  );

  it("composes the three cores by reference", () => {
    expect(canonical.fields).toBe(fields);
    expect(canonical.sections).toBe(sections);
    expect(canonical.fieldConfidence).toBe(fieldConfidence);
  });

  it("projectScoreSections returns the section core by reference", () => {
    expect(projectScoreSections(canonical)).toBe(sections);
  });

  it("projectDisplay returns the field core + headings by reference", () => {
    const display = projectDisplay(canonical);
    expect(display.parsed).toBe(fields);
    expect(display.sectionHeadings).toBe(sections.sectionHeadings);
  });

  it("projectLlmDiff coerces LLM output into a canonical shape (field-name map, empty sections/confidence)", () => {
    const llm: LlmParsedResume = {
      full_name: "Jane Candidate",
      email: null,
      phone: null,
      location: null,
      summary: "Summary text",
      skills: ["TypeScript", "React"],
      experience: [
        { company: "Acme", title: "Engineer", description: "Built things" },
      ],
      education: [{ institution: "State U", degree: "BS" }],
    };
    const back = projectLlmDiff(llm);
    // Field-name mapping: scalars carried, null → undefined; arrays mapped 1:1.
    expect(back.fields.full_name).toBe("Jane Candidate");
    expect(back.fields.email).toBeUndefined();
    expect(back.fields.summary).toBe("Summary text");
    expect(back.fields.skills).toEqual(["TypeScript", "React"]);
    expect(back.fields.experience).toHaveLength(1);
    expect(back.fields.experience[0]).toMatchObject({
      company: "Acme",
      title: "Engineer",
      description: "Built things",
    });
    expect(back.fields.education).toHaveLength(1);
    // Best-effort/empty: no section pools, no confidence (the diff derives its
    // section gate from the heuristic canonical, never the LLM side).
    expect(back.sections.byName.size).toBe(0);
    expect(back.fieldConfidence).toEqual({});
  });
});

// ── Corpus proof: projections are content-faithful across every fixture ───────

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "../../..", "tests/fixtures/pdfs");

function walkPdfs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkPdfs(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) out.push(p);
  }
  return out.sort();
}

describe("canonical projections — corpus parity (synthetic personas)", { timeout: 20000 }, () => {
  const fixtures = walkPdfs(FIXTURE_ROOT);

  it("finds fixtures to project", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    const name = fixture.slice(FIXTURE_ROOT.length + 1);
    it(`projects score sections faithfully: ${name}`, async () => {
      const cascade = await runCascade(new Uint8Array(readFileSync(fixture)));

      // Deep-clone the cores so the projection can't pass on reference identity
      // alone — a content bug in re-derivation would surface here.
      const canonical = toCanonicalResume(
        structuredClone(cascade.canonical.fields),
        structuredClone(cascade.canonical.sections),
        structuredClone(cascade.canonical.fieldConfidence),
      );

      // Score projection reproduces the cascade's section pools byte-for-byte.
      expect(projectScoreSections(canonical)).toEqual(cascade.canonical.sections);

      // And the anonymous score is identical whether the scorer reads the
      // projection or `cascade.canonical.sections` directly — the app-path invariant.
      const baseInput = {
        parsed: cascade.canonical.fields,
        fieldConfidence: cascade.canonical.fieldConfidence,
        triggers: cascade.triggers,
        rawText: cascade.rawText,
      };
      const viaProjection = computeAnonymousAtsScore({
        ...baseInput,
        sections: projectScoreSections(canonical),
      });
      const viaDirect = computeAnonymousAtsScore({
        ...baseInput,
        sections: cascade.canonical.sections,
      });
      expect(viaProjection).toEqual(viaDirect);

      // Display projection reproduces the parsed core + headings.
      const display = projectDisplay(canonical);
      expect(display.parsed).toEqual(cascade.canonical.fields);
      expect(display.sectionHeadings).toEqual(
        cascade.canonical.sections.sectionHeadings,
      );
    });
  }
});
