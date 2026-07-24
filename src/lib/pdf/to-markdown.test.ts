// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the pure `toCareerOpsMarkdown` adapter (#552): contact line,
 * summary, experience (incl. `isCurrent`), projects, education, categorised
 * and flat skills, achievements, empty-section omission, and the
 * never-fabricate-a-date contract.
 */

import { describe, it, expect } from "vitest";
import { toCareerOpsMarkdown } from "./to-markdown.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";

// A structurally complete model covering every mapped section kind.
const FULL_MODEL: AtsResumeModel = {
  contact: {
    name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    links: ["linkedin.com/in/jane"],
    profiles: [
      {
        url: "https://linkedin.com/in/jane",
        network: "LinkedIn",
        kind: "social",
        legacyKey: "linkedin_url",
      },
      {
        url: "https://github.com/JaneC",
        network: "GitHub",
        kind: "code",
        legacyKey: "github_url",
      },
      {
        url: "https://jane.dev",
        network: "jane.dev",
        kind: "other",
        legacyKey: "website_url",
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
          headerLine: "Senior Engineer",
          bullets: ["Shipped X", "Led Y"],
          fields: {
            organization: "Acme Corp",
            position: "Senior Engineer",
            startDate: "2020",
            endDate: "2022",
          },
        },
        {
          headerLine: "Engineer",
          bullets: [],
          fields: {
            organization: "Startup Inc",
            position: "Engineer",
            startDate: "2022",
            isCurrent: true,
            endDate: "2099", // must be dropped because isCurrent
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
          headerLine: "Languages: TypeScript · Python",
          bullets: [],
          fields: { skillCategory: "Languages", skills: ["TypeScript", "Python"] },
        },
      ],
    },
    {
      heading: "Achievements",
      kind: "achievements",
      entries: [
        {
          headerLine: "Employee of the year",
          bullets: [],
          fields: { title: "Employee of the year" },
        },
      ],
    },
  ],
};

describe("toCareerOpsMarkdown — header + contact", () => {
  const md = toCareerOpsMarkdown(FULL_MODEL);

  it("opens with the name heading", () => {
    expect(md).toMatch(/^# Jane Candidate\n/);
  });

  it("emits a middot-joined contact line in order: location · email · linkedin · portfolio/website · github", () => {
    expect(md).toContain(
      "Chicago, IL · jane@example.com · https://linkedin.com/in/jane · https://jane.dev · https://github.com/JaneC",
    );
  });
});

describe("toCareerOpsMarkdown — summary", () => {
  it("emits the summary paragraph under ## Summary", () => {
    const md = toCareerOpsMarkdown(FULL_MODEL);
    expect(md).toContain("## Summary\n\nA pragmatic engineer who ships.");
  });
});

describe("toCareerOpsMarkdown — experience", () => {
  const md = toCareerOpsMarkdown(FULL_MODEL);

  it("emits company, title, date range, and bullets", () => {
    expect(md).toContain(
      "**Acme Corp**\n**Senior Engineer**\n2020-2022\n- Shipped X\n- Led Y",
    );
  });

  it("emits Present (not the placeholder endDate) for an isCurrent role", () => {
    expect(md).toContain("**Startup Inc**\n**Engineer**\n2022-Present");
    expect(md).not.toContain("2099");
  });
});

describe("toCareerOpsMarkdown — education", () => {
  it("emits studyType, area, organization, and year", () => {
    const md = toCareerOpsMarkdown(FULL_MODEL);
    expect(md).toContain("**B.S., Computer Science — State University** (2019)");
  });
});

describe("toCareerOpsMarkdown — skills", () => {
  it("emits a categorised entry as a labeled line", () => {
    const md = toCareerOpsMarkdown(FULL_MODEL);
    expect(md).toContain("**Languages:** TypeScript, Python");
  });

  it("emits a flat (uncategorised) entry as a bare comma-joined line", () => {
    const flatModel: AtsResumeModel = {
      ...FULL_MODEL,
      sections: [
        {
          heading: "Skills",
          kind: "skills",
          entries: [
            {
              headerLine: "TypeScript · React",
              bullets: [],
              fields: { skills: ["TypeScript", "React"] },
            },
          ],
        },
      ],
    };
    const md = toCareerOpsMarkdown(flatModel);
    expect(md).toContain("## Skills\n\nTypeScript, React");
    expect(md).not.toContain("**TypeScript");
  });
});

describe("toCareerOpsMarkdown — achievements", () => {
  it("maps fields.title to a bullet under ## Achievements", () => {
    const md = toCareerOpsMarkdown(FULL_MODEL);
    expect(md).toContain("## Achievements\n\n- Employee of the year");
  });
});

describe("toCareerOpsMarkdown — empty sections omitted", () => {
  it("omits ## Projects entirely when there are none", () => {
    const md = toCareerOpsMarkdown(FULL_MODEL);
    expect(md).not.toContain("## Projects");
  });

  it("omits ## Summary when the model has no summary", () => {
    const md = toCareerOpsMarkdown({ ...FULL_MODEL, summary: undefined });
    expect(md).not.toContain("## Summary");
  });

  it("omits every section on a bare contact-only model", () => {
    const bare: AtsResumeModel = {
      contact: { name: "Bare Candidate", links: [] },
      sections: [],
    };
    const md = toCareerOpsMarkdown(bare);
    expect(md).toBe("# Bare Candidate\n");
  });
});

describe("toCareerOpsMarkdown — escapes inline metacharacters in prose fields", () => {
  it("backslash-escapes *, _, backtick so a value can't break the emphasis", () => {
    const model: AtsResumeModel = {
      contact: { name: "Jane", links: [] },
      sections: [
        {
          heading: "Experience",
          kind: "experience",
          entries: [
            {
              headerLine: "Senior **Staff** Eng",
              bullets: ["Owned the `answer_bank` ingestion path"],
              fields: {
                organization: "Acme_Corp",
                position: "Senior **Staff** Eng",
              },
            },
          ],
        },
      ],
    };
    const md = toCareerOpsMarkdown(model);
    expect(md).toContain("**Acme\\_Corp**");
    expect(md).toContain("**Senior \\*\\*Staff\\*\\* Eng**");
    expect(md).toContain("- Owned the \\`answer\\_bank\\` ingestion path");
  });

  it("leaves the contact line (URLs) unescaped so links round-trip byte-for-byte", () => {
    const model: AtsResumeModel = {
      contact: {
        name: "Jane",
        links: [],
        profiles: [
          {
            url: "https://linkedin.com/in/jane_candidate",
            network: "LinkedIn",
            kind: "social",
            legacyKey: "linkedin_url",
          },
        ],
      },
      sections: [],
    };
    const md = toCareerOpsMarkdown(model);
    expect(md).toContain("https://linkedin.com/in/jane_candidate");
    expect(md).not.toContain("jane\\_candidate");
  });
});

describe("toCareerOpsMarkdown — never fabricates a date", () => {
  it("keeps an unparseable free-form date raw, not guessed", () => {
    const model: AtsResumeModel = {
      contact: { name: "Jane", links: [] },
      sections: [
        {
          heading: "Experience",
          kind: "experience",
          entries: [
            {
              headerLine: "Contractor",
              bullets: [],
              fields: { organization: "Freelance", startDate: "Summer 2021" },
            },
          ],
        },
      ],
    };
    const md = toCareerOpsMarkdown(model);
    expect(md).toContain("Summer 2021");
  });

  it("omits the date line entirely when the entry carries no date", () => {
    const model: AtsResumeModel = {
      contact: { name: "Jane", links: [] },
      sections: [
        {
          heading: "Experience",
          kind: "experience",
          entries: [
            {
              headerLine: "Contractor",
              bullets: [],
              fields: { organization: "Freelance" },
            },
          ],
        },
      ],
    };
    const md = toCareerOpsMarkdown(model);
    expect(md).toContain("**Freelance**\n");
    expect(md).not.toMatch(/\d{4}/);
  });
});
