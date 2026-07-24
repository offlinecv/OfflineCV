// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip test for the markdown export ↔ import pair (#552): a model
 * exported via `toCareerOpsMarkdown` and dropped back in must re-parse to the
 * same load-bearing fields. Mirrors the exact app path a user takes —
 * `toCareerOpsMarkdown` → `parseMarkdownFile` → `runCascadeFromMarkdown` —
 * so the two halves are pinned as a pair, not just unit-tested in isolation.
 *
 * This is the markdown analogue of the PDF `corpus-roundtrip` invariant, scoped
 * to the fields the freeform career-ops shape can carry (name, email,
 * experience org/title, education, skills) — NOT byte-exact fidelity, which the
 * freeform target never promised.
 */

import { describe, it, expect } from "vitest";
import { toCareerOpsMarkdown } from "./to-markdown.ts";
import { parseMarkdownFile } from "../ingest/markdown.ts";
import { runCascadeFromMarkdown } from "../heuristics/cascade.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";

const MODEL: AtsResumeModel = {
  contact: {
    name: "Jane Q. Candidate",
    email: "jane.candidate@example.com",
    phone: "(415) 555-0123",
    location: "San Francisco, CA",
    links: [],
    profiles: [
      {
        url: "https://linkedin.com/in/janecandidate",
        network: "LinkedIn",
        kind: "social",
        legacyKey: "linkedin_url",
      },
    ],
  },
  summary: "A pragmatic engineer who ships.",
  summaryHeading: "Summary",
  sections: [
    {
      heading: "Experience",
      kind: "experience",
      entries: [
        {
          headerLine: "Senior Software Engineer",
          bullets: [
            "Led migration of the payments service, cutting P95 latency by 40%.",
            "Mentored four engineers and owned the weekly design-review cadence.",
          ],
          fields: {
            organization: "Acme Corp",
            position: "Senior Software Engineer",
            startDate: "2022",
            isCurrent: true,
          },
        },
        {
          headerLine: "Software Engineer",
          bullets: ["Shipped v2 of the analytics pipeline handling 1B events/day."],
          fields: {
            organization: "Globex Inc",
            position: "Software Engineer",
            startDate: "2019",
            endDate: "2021",
          },
        },
      ],
    },
    {
      heading: "Education",
      kind: "education",
      entries: [
        {
          headerLine: "B.S., Computer Science",
          bullets: [],
          fields: {
            organization: "State University",
            studyType: "B.S.",
            area: "Computer Science",
            endDate: "2019",
          },
        },
      ],
    },
    {
      heading: "Skills",
      kind: "skills",
      entries: [
        {
          headerLine: "Languages",
          bullets: [],
          fields: {
            skillCategory: "Languages",
            skills: ["TypeScript", "Kotlin", "Go", "Postgres"],
          },
        },
      ],
    },
  ],
};

describe("toCareerOpsMarkdown ↔ parseMarkdownFile round-trip", () => {
  it("re-parses to the same load-bearing fields via the real import path", async () => {
    const md = toCareerOpsMarkdown(MODEL);
    const { rawText, markdown } = parseMarkdownFile(md);
    const result = await runCascadeFromMarkdown(rawText, markdown);

    expect(result.canonical.fields.full_name).toBe("Jane Q. Candidate");
    expect(result.canonical.fields.email).toBe("jane.candidate@example.com");

    // Both experience entries survive with their organizations recovered.
    expect(result.canonical.fields.experience.length).toBeGreaterThanOrEqual(2);
    const orgs = result.canonical.fields.experience
      .map((e) => e.company ?? "")
      .join(" | ");
    expect(orgs).toMatch(/Acme/);
    expect(orgs).toMatch(/Globex/);

    // Education and skills carry across.
    expect(result.canonical.fields.education.length).toBeGreaterThanOrEqual(1);
    expect(result.canonical.fields.skills.length).toBeGreaterThanOrEqual(1);
  });
});
