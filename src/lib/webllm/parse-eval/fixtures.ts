// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors
// fallow-ignore-file unused-file

/**
 * Inline eval fixtures for the parse-resume provider (issue #241).
 *
 * PII POLICY (non-negotiable, public repo):
 *   - All personas are fully synthetic: fake names, @example.com emails.
 *   - Phone numbers MUST use a REAL area code + 555 exchange + 0100–0199
 *     subscriber (e.g. (312) 555-0123). Do NOT use 555 as the area code —
 *     555 is invalid NANP and fails libphonenumber-js isValid().
 *   - Employer names, school names, and locations are fictional.
 *   - These fixtures are inline text (not PDF binaries) but the policy
 *     still applies — the repo is public and text is indexable.
 *
 * NOTE: Do NOT use tests/fixtures/pdfs/*.expected.json for ground truth.
 * Those snapshots are lossy by design (keys/counts only, no field values)
 * and cannot score field accuracy. These inline valued fixtures are the
 * correct source.
 */

import type { LlmParsedResume } from "../parse-resume.ts";

// ---------------------------------------------------------------------------
// Fixture type
// ---------------------------------------------------------------------------

export interface ParseEvalFixture {
  /** Stable kebab-case id. Used in report tables. */
  id: string;
  /** Human-readable label for the report. */
  label: string;
  /** Plain-text resume content (always present). */
  text: string;
  /**
   * Optional Markdown version of the same resume — if provided, the eval
   * harness passes it as `markdown` to `parseResumeWithLlm` (which prefers
   * markdown). This lets us measure whether markdown improves accuracy.
   */
  markdown?: string;
  /** Ground-truth expected output for scoring. */
  expected: LlmParsedResume;
}

// ---------------------------------------------------------------------------
// Fixture 1: software-engineer — well-structured, complete resume
// ---------------------------------------------------------------------------

const SOFTWARE_ENGINEER: ParseEvalFixture = {
  id: "software-engineer",
  label: "Software Engineer — complete well-structured resume",
  text: `Alex Rivera
alex.rivera@example.com | (312) 555-0142 | Chicago, IL

SUMMARY
Software engineer with 5 years of experience building distributed backend systems. Strong in Python and Go; experienced in cloud-native deployment with Kubernetes.

SKILLS
Python, Go, PostgreSQL, Redis, Kubernetes, Docker, REST APIs, Apache Kafka, Git, Linux

EXPERIENCE
Senior Software Engineer — Meridian Technology Partners (Jan 2021 – Present)
  Led backend API development for a platform serving 10M daily active users. Reduced P95 latency by 40% via query optimization and connection pooling.

Software Engineer — Calloway Systems (Jun 2018 – Dec 2020)
  Built Go microservices for an order-processing pipeline. Wrote unit and integration tests; maintained 87% line coverage. Integrated Apache Kafka for event streaming.

EDUCATION
B.S. Computer Science — Fenwick State University (2018)`,
  markdown: `# Alex Rivera

alex.rivera@example.com | (312) 555-0142 | Chicago, IL

## Summary

Software engineer with 5 years of experience building distributed backend systems. Strong in Python and Go; experienced in cloud-native deployment with Kubernetes.

## Skills

Python, Go, PostgreSQL, Redis, Kubernetes, Docker, REST APIs, Apache Kafka, Git, Linux

## Experience

**Senior Software Engineer** — Meridian Technology Partners (Jan 2021 – Present)

Led backend API development for a platform serving 10M daily active users. Reduced P95 latency by 40% via query optimization and connection pooling.

**Software Engineer** — Calloway Systems (Jun 2018 – Dec 2020)

Built Go microservices for an order-processing pipeline. Wrote unit and integration tests; maintained 87% line coverage. Integrated Apache Kafka for event streaming.

## Education

**B.S. Computer Science** — Fenwick State University (2018)`,
  expected: {
    full_name: "Alex Rivera",
    email: "alex.rivera@example.com",
    phone: "(312) 555-0142",
    location: "Chicago, IL",
    summary:
      "Software engineer with 5 years of experience building distributed backend systems. Strong in Python and Go; experienced in cloud-native deployment with Kubernetes.",
    skills: [
      "Python",
      "Go",
      "PostgreSQL",
      "Redis",
      "Kubernetes",
      "Docker",
      "REST APIs",
      "Apache Kafka",
      "Git",
      "Linux",
    ],
    experience: [
      {
        company: "Meridian Technology Partners",
        title: "Senior Software Engineer",
        description:
          "Led backend API development for a platform serving 10M daily active users. Reduced P95 latency by 40% via query optimization and connection pooling.",
      },
      {
        company: "Calloway Systems",
        title: "Software Engineer",
        description:
          "Built Go microservices for an order-processing pipeline. Wrote unit and integration tests; maintained 87% line coverage. Integrated Apache Kafka for event streaming.",
      },
    ],
    education: [
      {
        institution: "Fenwick State University",
        degree: "B.S. Computer Science",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Fixture 2: marketing-coordinator — non-tech domain
// ---------------------------------------------------------------------------

const MARKETING_COORDINATOR: ParseEvalFixture = {
  id: "marketing-coordinator",
  label: "Marketing Coordinator — non-tech domain resume",
  text: `Jordan Avery Mitchell
jordan.mitchell@example.com | (206) 555-0117 | Seattle, WA

SUMMARY
Results-driven marketing coordinator with 3 years of experience in digital campaigns, social media management, and brand communications.

SKILLS
Social media marketing, Google Analytics, HubSpot, Canva, Copywriting, Email marketing, SEO basics, Adobe Photoshop

EXPERIENCE
Marketing Coordinator — Northgate Consumer Brands (Mar 2022 – Present)
  Managed social media accounts across Instagram, LinkedIn, and Twitter (30K+ followers). Produced weekly newsletters with 38% average open rate.

Marketing Assistant — Lakeshore Retail Group (Aug 2020 – Feb 2022)
  Supported campaign planning for seasonal promotions. Drafted press releases and coordinated with external PR agency.

EDUCATION
B.A. Communications — Claremont Valley University (2020)`,
  expected: {
    full_name: "Jordan Avery Mitchell",
    email: "jordan.mitchell@example.com",
    phone: "(206) 555-0117",
    location: "Seattle, WA",
    summary:
      "Results-driven marketing coordinator with 3 years of experience in digital campaigns, social media management, and brand communications.",
    skills: [
      "Social media marketing",
      "Google Analytics",
      "HubSpot",
      "Canva",
      "Copywriting",
      "Email marketing",
      "SEO basics",
      "Adobe Photoshop",
    ],
    experience: [
      {
        company: "Northgate Consumer Brands",
        title: "Marketing Coordinator",
        description:
          "Managed social media accounts across Instagram, LinkedIn, and Twitter (30K+ followers). Produced weekly newsletters with 38% average open rate.",
      },
      {
        company: "Lakeshore Retail Group",
        title: "Marketing Assistant",
        description:
          "Supported campaign planning for seasonal promotions. Drafted press releases and coordinated with external PR agency.",
      },
    ],
    education: [
      {
        institution: "Claremont Valley University",
        degree: "B.A. Communications",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Fixture 3: recent-grad — minimal resume, some fields absent
// ---------------------------------------------------------------------------

const RECENT_GRAD: ParseEvalFixture = {
  id: "recent-grad",
  label: "Recent Graduate — minimal resume, no summary, no location",
  text: `Priya Sundarajan
priya.sundarajan@example.com | (617) 555-0188

SKILLS
Python, SQL, Pandas, NumPy, Tableau, Excel

EXPERIENCE
Data Analyst Intern — Ironwood Research Partners (May 2024 – Aug 2024)
  Analyzed customer churn data using Python and Pandas. Built a Tableau dashboard for the marketing team that reduced weekly reporting time by 2 hours.

EDUCATION
B.S. Statistics — Westbrook University (Expected May 2025)`,
  expected: {
    full_name: "Priya Sundarajan",
    email: "priya.sundarajan@example.com",
    phone: "(617) 555-0188",
    // Location absent from resume — expect null
    location: null,
    // No summary section — expect null
    summary: null,
    skills: ["Python", "SQL", "Pandas", "NumPy", "Tableau", "Excel"],
    experience: [
      {
        company: "Ironwood Research Partners",
        title: "Data Analyst Intern",
        description:
          "Analyzed customer churn data using Python and Pandas. Built a Tableau dashboard for the marketing team that reduced weekly reporting time by 2 hours.",
      },
    ],
    education: [
      {
        institution: "Westbrook University",
        degree: "B.S. Statistics",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** All eval fixtures, in run order. */
// fallow-ignore-next-line unused-export
export const PARSE_EVAL_FIXTURES: readonly ParseEvalFixture[] = [
  SOFTWARE_ENGINEER,
  MARKETING_COORDINATOR,
  RECENT_GRAD,
];
