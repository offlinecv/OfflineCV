// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for `parseHeuristicFromMarkdown`.
 *
 * Fixtures are representative of mammoth+turndown output for DOCX resumes:
 *   - Section labels as `**BOLD**` standalone paragraphs (the most common
 *     DOCX pattern — sections are styled as bold, not real heading styles).
 *   - Section labels as `## Heading` (when the source uses real heading
 *     styles). Verified against the classifier's known shapes.
 *   - Experience headers as `**Title** | **Company** | Dates` on one line
 *     — the other common shape mammoth emits for DOCX tables of roles.
 *   - Bullets as `- item`.
 *
 * Field-confidence expectations mirror `FIELD_CONFIDENCE_TARGETS` — the
 * LLM-skip gate is overall cascade confidence ≥ `CANONICAL_CONFIDENCE_THRESHOLD`,
 * but the per-field floors are what catch extractor regressions.
 */

import { parseHeuristicFromMarkdown } from "./openresume.ts";
import { FIELD_CONFIDENCE_TARGETS } from "./thresholds.ts";

describe("parseHeuristicFromMarkdown — bold-paragraph section labels (mammoth default)", () => {
  const markdown = [
    "**Jane Q. Doe**",
    "",
    "jane.doe@example.com · (415) 555-0199 · San Francisco, CA",
    "",
    "https://linkedin.com/in/janedoe · github.com/janedoe",
    "",
    "**EXPERIENCE**",
    "",
    "**Senior Software Engineer** | Acme Corp. | Jan 2022 - Present",
    "",
    "- Led migration of payments service to Kotlin, cutting P95 by 40%.",
    "- Mentored 4 engineers; owned weekly design review cadence.",
    "",
    "**Software Engineer** | Globex Inc. | Jun 2019 - Dec 2021",
    "",
    "- Shipped v2 of analytics pipeline handling 1B events/day.",
    "",
    "**EDUCATION**",
    "",
    "Stanford University — B.S. Computer Science — 2019",
    "",
    "**SKILLS**",
    "",
    "Kotlin, TypeScript, Go, Postgres, Kubernetes, AWS, React",
  ].join("\n");

  const rawText = markdown.replace(/\*\*/g, "");

  it("extracts name, contact, experience, education, and skills", () => {
    const result = parseHeuristicFromMarkdown(markdown, rawText);

    expect(result.parsed.full_name).toBe("Jane Q. Doe");
    expect(result.parsed.email).toBe("jane.doe@example.com");
    expect(result.parsed.phone).toBeTruthy();
    expect(result.parsed.location).toContain("San Francisco");
    expect(result.parsed.linkedin_url).toContain("linkedin.com/in/janedoe");
    expect(result.parsed.github_url).toContain("github.com/janedoe");

    expect(result.parsed.experience.length).toBeGreaterThanOrEqual(2);
    const firstExp = result.parsed.experience[0];
    expect(firstExp.company + " " + firstExp.title).toMatch(/Acme/);
    expect(firstExp.is_current).toBe(true);
    const secondExp = result.parsed.experience[1];
    expect(secondExp.company + " " + secondExp.title).toMatch(/Globex/);

    expect(result.parsed.education.length).toBe(1);
    expect(result.parsed.education[0].institution).toContain("Stanford");
    expect(result.parsed.education[0].degree).toMatch(/B\.S\./);

    expect(result.parsed.skills).toEqual(
      expect.arrayContaining(["Kotlin", "TypeScript", "Go", "React"]),
    );
  });

  it("clears the canonical field-confidence floors for the DOCX path", () => {
    const result = parseHeuristicFromMarkdown(markdown, rawText);

    expect(result.fieldConfidence.full_name ?? 0).toBeGreaterThanOrEqual(
      FIELD_CONFIDENCE_TARGETS.full_name,
    );
    expect(result.fieldConfidence.email ?? 0).toBeGreaterThanOrEqual(
      FIELD_CONFIDENCE_TARGETS.email,
    );
    expect(result.fieldConfidence.experience ?? 0).toBeGreaterThanOrEqual(
      FIELD_CONFIDENCE_TARGETS.experience,
    );
  });
});

describe("parseHeuristicFromMarkdown — ATX heading section labels", () => {
  const markdown = [
    "# John Smith",
    "",
    // 415-555-0123 is a libphonenumber-valid synthetic US number (formats to (415) 555-0123).
    "john.smith@example.com | 415-555-0123 | Boston, MA",
    "",
    "## Summary",
    "",
    "Experienced engineer with 8+ years building data infrastructure at scale. Specializes in reliability, observability, and team leadership across distributed systems.",
    "",
    "## Experience",
    "",
    "### Principal Engineer, Initech Corporation",
    "Mar 2021 - Present",
    "",
    "- Architected a 10x scale-up of the ingestion pipeline.",
    "- Led cross-team reliability initiative; on-call pages down 60%.",
    "",
    "### Staff Engineer, Umbrella Systems Inc.",
    "Jan 2018 - Feb 2021",
    "",
    "- Owned the data-platform re-architecture delivering $2M annual cost savings.",
    "",
    "## Education",
    "",
    "MIT — M.S. Computer Science — 2017",
    "",
    "## Skills",
    "",
    "Go, Python, Postgres, Kafka, AWS, Terraform",
  ].join("\n");

  const rawText = markdown.replace(/#+\s+/g, "").replace(/\*\*/g, "");

  it("extracts the basics with ATX headings", () => {
    const result = parseHeuristicFromMarkdown(markdown, rawText);

    expect(result.parsed.full_name).toBe("John Smith");
    expect(result.parsed.email).toBe("john.smith@example.com");
    expect(result.parsed.phone).toBeTruthy();
    expect(result.parsed.location).toContain("Boston");

    expect(result.parsed.summary).toMatch(/data infrastructure/);

    expect(result.parsed.experience.length).toBeGreaterThanOrEqual(2);
    const firstExp = result.parsed.experience[0];
    expect(firstExp.company + " " + firstExp.title).toMatch(/Initech/);
    expect(firstExp.is_current).toBe(true);

    expect(result.parsed.education.length).toBeGreaterThanOrEqual(1);
    expect(result.parsed.education[0].institution).toMatch(/MIT/);
  });

  it("clears field-confidence floors", () => {
    const result = parseHeuristicFromMarkdown(markdown, rawText);
    expect(result.fieldConfidence.full_name ?? 0).toBeGreaterThanOrEqual(
      FIELD_CONFIDENCE_TARGETS.full_name,
    );
    expect(result.fieldConfidence.email ?? 0).toBeGreaterThanOrEqual(
      FIELD_CONFIDENCE_TARGETS.email,
    );
    expect(result.fieldConfidence.experience ?? 0).toBeGreaterThanOrEqual(
      FIELD_CONFIDENCE_TARGETS.experience,
    );
  });
});

describe("parseHeuristicFromMarkdown — real-world DOCX artefacts", () => {
  it("unescapes turndown's backslash-escaped underscores in emails", () => {
    // Mammoth+turndown produces `Jordan\_Lee@example.com` from a DOCX
    // where the email contains an underscore. Without preprocessing the
    // email regex skipped the escaped prefix and extracted
    // `_Lee@example.com`. See investigation on 2026-04-23.
    const markdown = [
      "**Jordan Lee**",
      "",
      "Sr. Software Engineer",
      "",
      "Fairview, CA | Jordan\\_Lee@example.com | 408-555-0100",
      "",
      "**EXPERIENCE**",
      "",
      "**Sr. Software Engineer** · NIMBUS LABS _Dec '00 - Present_",
      "",
      "• Did initial research and development of an input-method engine.",
      "• Created PHP/MySQL pages to verify and activate licenses.",
      "",
      "**Sr. Consultant** · ORION SYSTEMS _Apr 1995 - Dec 2000_",
      "",
      "• Designed XML interfaces for database operations.",
      "",
      "**EDUCATION**",
      "",
      "Example State University — M.S. Computer Science — 1994",
    ].join("\n");

    const result = parseHeuristicFromMarkdown(markdown, markdown);

    expect(result.parsed.email).toBe("Jordan_Lee@example.com");
    expect(result.fieldConfidence.email ?? 0).toBeGreaterThanOrEqual(
      FIELD_CONFIDENCE_TARGETS.email,
    );
  });

  it("extracts experience from 2-digit apostrophe-year date ranges", () => {
    const markdown = [
      "**Jane Doe**",
      "jane@example.com | (555) 555-1234",
      "",
      "**EXPERIENCE**",
      "",
      "**Sr. Software Engineer** · Acme _Dec '00 - Present_",
      "",
      "• Led a team shipping a distributed cache.",
      "",
      "**Engineer** · Globex _Jan '95 - Nov '00_",
      "",
      "• Built internal tooling.",
    ].join("\n");
    const result = parseHeuristicFromMarkdown(markdown, markdown);
    expect(result.parsed.experience.length).toBeGreaterThanOrEqual(2);
    expect(result.parsed.experience[0].is_current).toBe(true);
    expect(result.fieldConfidence.experience ?? 0).toBeGreaterThanOrEqual(
      FIELD_CONFIDENCE_TARGETS.experience,
    );
  });

  it("tolerates Word icon-letter section headers like `**S UMMARY**`", () => {
    // Word templates render a decorative first letter as a separate glyph,
    // so DOCX → markdown produces `**S UMMARY**` / `# E XPERIENCE`.
    // Normalizer should join these back before section detection runs.
    const markdown = [
      "**Jordan Lee**",
      "",
      "**Software Engineering Leader**",
      "",
      "E **415-555-0123**",
      "",
      " [**jordan.lee@example.com**](mailto:jordan.lee@example.com)",
      "",
      "e **Brookfield, CA**",
      "",
      "**S UMMARY**",
      "",
      "A seasoned engineering leader with experience managing large cross-functional teams.",
      "",
      "# E XPERIENCE",
      "",
      "## Sr. Engineering Manager (L7)",
      "",
      "### Globex / CloudWave - Customer Experience Engineering",
      "",
      "04/2021 - Present",
      "",
      "- Led the customer-experience engineering org.",
      "- Owned reliability + observability initiatives.",
      "",
      "## Director of Engineering",
      "",
      "### Flywheel Software",
      "",
      "06/2018 - 03/2021",
      "",
      "- Scaled engineering from 12 to 45.",
      "",
      "# E DUCATION",
      "",
      "Stanford University — M.S. Computer Science — 2005",
    ].join("\n");
    const rawText = markdown;
    const result = parseHeuristicFromMarkdown(markdown, rawText);
    expect(result.parsed.summary).toMatch(/seasoned engineering leader/);
    expect(result.parsed.experience.length).toBeGreaterThanOrEqual(2);
    expect(result.parsed.education.length).toBeGreaterThanOrEqual(1);
  });

  it("strips base64 data-URI image blobs", () => {
    const bigBase64 = "iVBORw0KGgoAAAAN" + "A".repeat(5000);
    const markdown = [
      "**Jordan Lee**",
      "jane@example.com | 415-555-0199",
      "",
      "**EXPERIENCE**",
      "",
      `**Sr. Engineer** · Acme ![](data:image/png;base64,${bigBase64}) 01/2020 - Present`,
      "",
      "- Led migrations.",
    ].join("\n");
    const result = parseHeuristicFromMarkdown(markdown, markdown);
    // Image is gone; experience still extracted.
    expect(result.parsed.experience.length).toBeGreaterThanOrEqual(1);
    expect(result.parsed.experience[0].is_current).toBe(true);
  });
});

describe("parseHeuristicFromMarkdown — minimal / missing sections", () => {
  it("returns zero-confidence on empty markdown", () => {
    const result = parseHeuristicFromMarkdown("", "");
    expect(result.parsed.experience).toEqual([]);
    expect(result.parsed.education).toEqual([]);
    expect(result.parsed.skills).toEqual([]);
    expect(result.fieldConfidence.full_name ?? 0).toBe(0);
    expect(result.fieldConfidence.email ?? 0).toBe(0);
  });

  it("still extracts name + email when only profile content is present", () => {
    const markdown = [
      "**Alice Stone**",
      "alice@example.com",
      "New York, NY",
    ].join("\n");
    const result = parseHeuristicFromMarkdown(markdown, markdown);
    expect(result.parsed.full_name).toBe("Alice Stone");
    expect(result.parsed.email).toBe("alice@example.com");
    expect(result.parsed.experience).toEqual([]);
  });
});

describe("parseHeuristicFromMarkdown — promoted-link de-duplication", () => {
  it("promotes a bottom LinkedIn/GitHub link to contact and removes it from the body", () => {
    // The bare links trailing the Projects section are promoted into the
    // contact card (document-wide identity-link detection). They must not also
    // survive as a phantom project entry whose only content is the URL.
    const markdown = [
      "# Jane Smith",
      "jane.smith@example.com",
      "## Projects",
      "**Cool App** · 2024",
      "- Built a thing that scaled to 1M users with 99.9% uptime reliability",
      "github.com/janesmith",
      "linkedin.com/in/janesmith",
    ].join("\n");
    const result = parseHeuristicFromMarkdown(markdown, markdown);

    // Promoted into contact …
    expect(result.parsed.github_url).toBe("https://github.com/janesmith");
    expect(result.parsed.linkedin_url).toBe("https://linkedin.com/in/janesmith");
    // … and NOT duplicated in the body: only the real project survives.
    expect(result.parsed.projects?.map((p) => p.name)).toEqual(["Cool App"]);
    expect(
      result.parsed.projects?.some(
        (p) => /github\.com|linkedin\.com/.test(p.url ?? "") ||
          /github\.com|linkedin\.com/.test(p.description ?? ""),
      ),
    ).toBe(false);
  });

  it("preserves a deeper repo path mentioned in a real bullet", () => {
    // Contact github is github.com/janesmith; a bullet referencing a deeper
    // path under it (a specific repo) is a real mention, not the identity link.
    const markdown = [
      "# Jane Smith",
      "jane.smith@example.com | github.com/janesmith",
      "## Projects",
      "**Cool App** · 2024",
      "- Shipped github.com/janesmith/cool-app reaching 1M users with strong reliability",
    ].join("\n");
    const result = parseHeuristicFromMarkdown(markdown, markdown);

    expect(result.parsed.github_url).toBe("https://github.com/janesmith");
    expect(result.parsed.projects?.[0]?.description).toContain(
      "github.com/janesmith/cool-app",
    );
  });

  it("preserves a different, longer handle that shares the promoted slug's prefix", () => {
    // Contact github is github.com/jane; a bullet citing github.com/jane-doe is a
    // DIFFERENT handle. The strip lookahead must reject the trailing "-" so the
    // longer handle is not chopped to "-doe".
    const markdown = [
      "# Jane Smith",
      "jane.smith@example.com | github.com/jane",
      "## Projects",
      "**Cool App** · 2024",
      "- Contributed to github.com/jane-doe/awesome serving many active users daily",
    ].join("\n");
    const result = parseHeuristicFromMarkdown(markdown, markdown);

    expect(result.parsed.github_url).toBe("https://github.com/jane");
    expect(result.parsed.projects?.[0]?.description).toContain(
      "github.com/jane-doe/awesome",
    );
  });
});
