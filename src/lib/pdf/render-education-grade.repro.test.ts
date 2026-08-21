// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * #883 AC#1 end to end — the issue's own source line, through the real exporter
 * and back:
 *
 *   B.S. in Computer Science, cum laude, GPA: 3.72/4.00
 *
 * The two halves are pinned separately elsewhere: `extract/education.gpa-honors`
 * proves that line PARSES to `gpa` / `honors`, and the corpus round-trip gate
 * compares both fields on all 60 fixtures. Neither covers the composed shape the
 * exporter invents for values a fixture does not happen to carry together —
 * honors AND a slash-scale grade on one degree line — so this drives that shape
 * through `buildAtsResumeModel` → `renderAtsResumePdf` → `runCascade`.
 *
 * No new fixture: the input is a parse built in code, so the assertions are
 * about the render↔re-parse hop and nothing else. Synthetic persona throughout,
 * per the fixtures PII policy.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import type { ResumeEducation } from "../score/types.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "../heuristics/sections.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

function parseWithEducation(education: ResumeEducation[]): CascadeResult {
  return {
    canonical: {
      sections: {
        byName: new Map(),
        accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
        source: "regex",
      },
      fields: {
        full_name: "Jane Candidate",
        email: "jane@example.com",
        phone: "(312) 555-0123",
        location: "Dallas, TX",
        summary: "Backend engineer focused on distributed systems.",
        skills: ["TypeScript", "Go"],
        experience: [
          {
            title: "Software Engineer",
            company: "Northwind Systems",
            start_date: "2024",
            end_date: "2026",
            description: "Cut p99 latency 40% across the ingestion path",
          },
        ],
        education,
        projects: [],
        heuristic_achievements: [],
      },
      fieldConfidence: {},
    },
    confidence: 0.9,
    triggers: [],
    suggestedEscalation: "none",
    tiers: ["t1_openresume"],
    rawText: "",
  } as unknown as CascadeResult;
}

async function roundtrip(education: ResumeEducation[]): Promise<ResumeEducation[]> {
  const parse1 = parseWithEducation(education);
  const score = computeAnonymousAtsScore({
    parsed: parse1.canonical.fields,
    fieldConfidence: parse1.canonical.fieldConfidence,
    triggers: parse1.triggers,
    rawText: parse1.rawText,
    sections: parse1.canonical.sections,
  });
  const { bytes } = await renderAtsResumePdf(buildAtsResumeModel(parse1, score));
  const parse3 = await runCascade(bytes);
  return parse3.canonical.fields.education ?? [];
}

describe("#883 — GPA and honors survive parse → export → re-parse", () => {
  let reparsed: ResumeEducation[];

  beforeAll(async () => {
    reparsed = await roundtrip([
      {
        degree: "B.S.",
        field: "Computer Science",
        institution: "The University of Texas at Dallas",
        honors: "cum laude",
        gpa: "3.72/4.00",
        end_date: "May 2024",
        year: "2024",
      },
    ]);
  }, 30000);

  it("recovers the entry with all four fields intact", () => {
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].degree).toBe("B.S.");
    expect(reparsed[0].field).toBe("Computer Science");
    expect(reparsed[0].institution).toBe("The University of Texas at Dallas");
  });

  it("recovers the grade with its scale, not a rounded number", () => {
    expect(reparsed[0].gpa).toBe("3.72/4.00");
  });

  it("recovers the honors phrase", () => {
    expect(reparsed[0].honors).toBe("cum laude");
  });

  it("leaves neither glued into the subject or the institution", () => {
    expect(reparsed[0].field ?? "").not.toMatch(/gpa|laude/i);
    expect(reparsed[0].institution ?? "").not.toMatch(/gpa|laude/i);
  });

  it("round-trips a non-4.0 scale and an unlabelled classification", async () => {
    const [scaled, classified] = await Promise.all([
      roundtrip([
        {
          degree: "B.Tech",
          field: "Computer Science",
          institution: "Northwind Institute of Technology",
          gpa: "8.4/10",
          year: "2022",
        },
      ]),
      roundtrip([
        {
          degree: "B.A.",
          field: "Economics",
          institution: "Ridgemont College",
          gpa: "First Class",
          year: "2022",
        },
      ]),
    ]);
    expect(scaled[0]?.gpa).toBe("8.4/10");
    expect(classified[0]?.gpa).toBe("First Class");
  }, 30000);
});

describe("#883 review — a degree-LESS program entry's honors survives the same round-trip", () => {
  // The composed headerLine has no degree line to anchor recognition — the
  // program title and its honors/grade note are the ONLY text on the entry's
  // lead line. Pinned separately from the degree-bearing suite above because
  // this shape is recognized by isProgramLeadAt/isInlineDatedProgram
  // (education.ts), a different code path than the degree-line collector.
  it("known limitation: an honors-ONLY degree-less program loses its title, but keeps the entry and the honors", async () => {
    // Round 1 of this review rescued isInlineDatedProgram's annotation veto for
    // ANY recognized trailing note, honors included — which fixed this case, but
    // also let "Phi Beta Kappa, cum laude 2021" (a real honor-society mention, no
    // program at all) read as a phantom degree-less program (pinned in
    // education.test.ts). Round 2 narrowed the rescue to GPA-kind notes only,
    // because a GPA note is unambiguous structured data while a bare honors
    // phrase is exactly the shape a genuine annotation line also takes — no
    // mechanical test tells "Applied Robotics Certificate" and "Phi Beta Kappa"
    // apart. So an honors-only degree-less program (no gpa, no degree line) is a
    // known, accepted gap: `isProgramLeadAt` no longer recognizes the lead line,
    // so `field` (the program title) is lost — but `parseEducationGrade` still
    // scans the chunk independently and recovers `honors`, and the generic
    // institution scan still recovers `institution`, so the entry survives in
    // degraded form rather than disappearing outright. The GPA-bearing sibling
    // below, and every degree-BEARING case (a different code path entirely,
    // untouched by this gate), still round-trip in full.
    const reparsed = await roundtrip([
      {
        degree: "",
        field: "Applied Robotics Certificate",
        institution: "Northwind Institute",
        honors: "cum laude",
        year: "2023",
      },
    ]);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].institution).toBe("Northwind Institute");
    expect(reparsed[0].honors).toBe("cum laude");
    expect(reparsed[0].field).toBeUndefined();
  });

  it("recovers a degree-less program's GPA too", async () => {
    const reparsed = await roundtrip([
      {
        degree: "",
        field: "Data Analytics Certificate",
        institution: "Ridgemont Institute",
        gpa: "3.9/4.0",
        year: "2023",
      },
    ]);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].field).toBe("Data Analytics Certificate");
    expect(reparsed[0].gpa).toBe("3.9/4.0");
  });
});
