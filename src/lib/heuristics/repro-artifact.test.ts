// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Tests for buildReproArtifact (issue #245).
 *
 * The LOAD-BEARING test is "carries no PII by construction": we plant a unique
 * sentinel string in EVERY PII-bearing field a real résumé parse would hold
 * (name, email, phone, location, summary, company/title/bullet text, skills,
 * rawText, markdown, link URL, and the disagreement value fields), build the
 * artifact, serialize it to JSON exactly as the download path does, and assert
 * NOT ONE sentinel survives. If a future contributor "helpfully" widens the
 * artifact to carry literal text, this fails — that is the whole point.
 *
 * The remaining tests pin the structure-only shape (counts, section boundaries,
 * triggers, disagreement kinds) the maintainer needs to reproduce a gap.
 */

import { describe, it, expect } from "vitest";
import {
  buildReproArtifact,
  REPRO_ARTIFACT_VERSION,
} from "./repro-artifact.ts";
import type { CascadeResult } from "./types.ts";
import { toCanonicalResume } from "./canonical.ts";
import type { SectionedResume } from "./sections.ts";
import type { SectionName } from "./regex.ts";
import type { ParseDisagreement } from "./disagreement.ts";

// ── Sentinels ────────────────────────────────────────────────────────────────
// Each is a distinctive, non-structural string that must NEVER appear in the
// artifact. Keyed by the field it occupies so a failure names the leak.
const PII = {
  fullName: "SENTINEL_FULL_NAME_Aria_Q_Testperson",
  email: "SENTINEL_EMAIL_aria@leak.invalid",
  phone: "SENTINEL_PHONE_+1-202-555-0142",
  location: "SENTINEL_LOCATION_Atlantis_Xy",
  summary: "SENTINEL_SUMMARY_drove_a_thing",
  company: "SENTINEL_COMPANY_AcmeLeak",
  title: "SENTINEL_TITLE_ChiefLeak",
  bullet: "SENTINEL_BULLET_did_a_thing_42pct",
  institution: "SENTINEL_INSTITUTION_Leak_University",
  degree: "SENTINEL_DEGREE_BS_Leakology",
  skill: "SENTINEL_SKILL_LeakScript",
  rawText: "SENTINEL_RAWTEXT_whole_resume_body",
  markdown: "SENTINEL_MARKDOWN_# whole resume",
  sectionLine: "SENTINEL_SECTION_LINE_a_real_bullet",
  linkUrl: "https://SENTINEL.linkedin.example/in/aria-leak",
  disagreementHeuristic: "SENTINEL_DISAGREE_HEURISTIC_value",
  disagreementLlm: "SENTINEL_DISAGREE_LLM_value",
} as const;

const ALL_SENTINELS = Object.values(PII);

function sectioned(): SectionedResume {
  const byName = new Map<SectionName | "profile", readonly string[]>([
    ["profile", [PII.fullName, PII.email]],
    ["experience", [PII.company, PII.title, PII.bullet]],
    ["education", [PII.institution]],
    ["skills", [PII.skill]],
  ]);
  return { byName, accomplishmentSections: ["experience"], source: "markdown" };
}

/** A CascadeResult salted with PII in every value-bearing field. */
function pollutedResult(): CascadeResult {
  return {
    canonical: toCanonicalResume(
      {
      full_name: PII.fullName,
      email: PII.email,
      phone: PII.phone,
      location: PII.location,
      summary: PII.summary,
      skills: [PII.skill],
      experience: [
        {
          company: PII.company,
          title: PII.title,
          description: PII.bullet,
          is_current: false,
        },
      ],
      education: [{ institution: PII.institution, degree: PII.degree }],
      },
      sectioned(),
      {},
    ),
    confidence: 0.7,
    triggers: ["two_column"],
    suggestedEscalation: "none",
    tiers: ["t0_layout", "t1_openresume"],
    rawText: PII.rawText,
    markdown: PII.markdown,
    linkAnnotations: [
      { page: 1, url: PII.linkUrl, rect: [0, 0, 1, 1], yTop: 0 },
    ],
    diagnostics: {
      rawCharCount: 4000,
      extractedCharCount: 2500,
      pages: 2,
      elapsedMs: 120,
      sectionSource: "markdown",
    },
    timings: { t0_layout_ms: 10, t1_openresume_ms: 20 },
  };
}

const pollutedDisagreements: ParseDisagreement[] = [
  {
    kind: "merged_roles",
    field: "experience",
    heuristicValue: PII.disagreementHeuristic,
    llmValue: PII.disagreementLlm,
    likelyCause: "two_column",
  },
  {
    kind: "missing_field",
    field: "email",
    heuristicValue: null,
    llmValue: PII.disagreementLlm,
  },
];

// ── The load-bearing PII assertion ───────────────────────────────────────────

describe("buildReproArtifact — PII-redacted by construction", () => {
  it("carries no literal field value, anywhere, when serialized", () => {
    const artifact = buildReproArtifact(pollutedResult(), pollutedDisagreements);
    // Serialize exactly as the download path does.
    const json = JSON.stringify(artifact);
    for (const sentinel of ALL_SENTINELS) {
      expect(json).not.toContain(sentinel);
    }
  });

  it("also leaks nothing when no disagreements are supplied", () => {
    const json = JSON.stringify(buildReproArtifact(pollutedResult()));
    for (const sentinel of ALL_SENTINELS) {
      expect(json).not.toContain(sentinel);
    }
  });
});

// ── Structure-only shape ─────────────────────────────────────────────────────

describe("buildReproArtifact — structure-only shape", () => {
  it("captures counts, boundaries, triggers, and disagreement kinds", () => {
    const a = buildReproArtifact(pollutedResult(), pollutedDisagreements);

    expect(a.artifactVersion).toBe(REPRO_ARTIFACT_VERSION);
    expect(a.triggers).toEqual(["two_column"]);
    expect(a.sectionSource).toBe("markdown");
    expect(a.pageCount).toBe(2);
    expect(a.rawCharCount).toBe(4000);
    expect(a.extractedCharCount).toBe(2500);
    expect(a.linkAnnotationCount).toBe(1);

    // Section boundaries — names + line counts, no text.
    const exp = a.sections.find((s) => s.name === "experience");
    expect(exp?.lineCount).toBe(3);
    const skills = a.sections.find((s) => s.name === "skills");
    expect(skills?.lineCount).toBe(1);

    // Parse cardinality — presence flags + counts.
    expect(a.parsedCounts.hasEmail).toBe(true);
    expect(a.parsedCounts.hasFullName).toBe(true);
    expect(a.parsedCounts.experienceCount).toBe(1);
    expect(a.parsedCounts.educationCount).toBe(1);
    expect(a.parsedCounts.skillsCount).toBe(1);

    // Disagreements — kind/field/cause only.
    expect(a.disagreements).toHaveLength(2);
    expect(a.disagreements[0]).toEqual({
      kind: "merged_roles",
      field: "experience",
      likelyCause: "two_column",
    });
    expect(a.disagreements[1]).toEqual({
      kind: "missing_field",
      field: "email",
    });
    // No likelyCause key when none applied.
    expect("likelyCause" in a.disagreements[1]).toBe(false);
  });

  it("reports presence=false for empty scalar fields", () => {
    const r = pollutedResult();
    r.canonical.fields.email = undefined;
    r.canonical.fields.location = "   ";
    const a = buildReproArtifact(r);
    expect(a.parsedCounts.hasEmail).toBe(false);
    expect(a.parsedCounts.hasLocation).toBe(false);
  });
});
