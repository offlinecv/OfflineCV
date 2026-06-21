// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { tokenizeSkillLine } from "./skills.ts";
import { parseHeuristic } from "../openresume.ts";
import { mkItems, mkDefaultPages } from "../__test-utils__/mkItem.ts";

// ── tokenizeSkillLine ─────────────────────────────────────────────────────────

describe("tokenizeSkillLine", () => {
  it("splits a bare comma-separated list into skill tokens", () => {
    const result = tokenizeSkillLine("SQL, PHP, Javascript, HTML/CSS");
    expect(result).toEqual(expect.arrayContaining(["SQL", "PHP", "Javascript"]));
    // HTML/CSS splits on the slash — both tokens must survive isSkillToken
    expect(result).toEqual(expect.arrayContaining(["HTML", "CSS"]));
  });

  it("strips an inline Label: prefix before tokenizing", () => {
    // The full line as it would appear in the PDF — label is NOT pre-stripped.
    // SKILL_SPLIT_RE splits on comma/semicolon, so the actual tokens are:
    //   "Advanced in SQL"  (3 words ≤ 4-word limit → kept whole)
    //   "PHP"
    //   "Proficient in MATLAB"  (3 words ≤ 4-word limit → kept whole)
    //   "Python"
    // "MATLAB" and "SQL" only appear inside the ≤4-word multi-word tokens;
    // they do NOT surface as standalone tokens.
    const result = tokenizeSkillLine(
      "Technical Skills: Advanced in SQL, PHP; Proficient in MATLAB, Python",
    );
    expect(result).toEqual(
      expect.arrayContaining(["Advanced in SQL", "PHP", "Proficient in MATLAB", "Python"]),
    );
    // The label itself must NOT appear as a skill token.
    expect(result).not.toContain("Technical Skills");
    expect(result).not.toContain("Technical");
  });

  it("returns an empty array for an empty string", () => {
    expect(tokenizeSkillLine("")).toEqual([]);
  });

  it("returns an empty array for a string with only separators", () => {
    // After splitting on SKILL_SPLIT_RE (commas/semicolons) and trimming,
    // there are no non-empty tokens — all-separator input produces [].
    expect(tokenizeSkillLine(",,,;;;")).toEqual([]);
  });

  it("drops the whole cell when a URL is present in a comma-separated list", () => {
    // tokenizeCell's looksLikeContactLink check fires on the ENTIRE cleaned
    // cell before the split.  "github.com/janesmith" matches the path-slash
    // URL pattern, so the whole "Python, github.com/janesmith, React" string
    // is dropped rather than partially split.  This matches the behavior of
    // the normal extractSkills path for whole-cell link lines.
    const result = tokenizeSkillLine("Python, github.com/janesmith, React");
    // The cell is dropped wholesale because of the URL — nothing survives.
    expect(result).toEqual([]);
  });
});

// ── harvestInlineLabeledSkills re-route via parseHeuristic ───────────────────

describe("parseHeuristic — ADDITIONAL section inline-label skills re-route (#122)", () => {
  // (b) no skills anywhere → parsed.skills empty, no false positive.
  it("(b) does not hallucinate skills when no skills exist anywhere", () => {
    const items = mkItems([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp Jan 2022 - Present", fontSize: 11 },
      { text: "• Shipped the thing", fontSize: 10 },
      { text: "", fontSize: 10 },
      // ADDITIONAL section with NO inline-labeled skill line
      { text: "ADDITIONAL", fontSize: 13 },
      { text: "Authorized to work in the US without sponsorship.", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);
    expect(result.parsed.skills).toEqual([]);
    expect(result.fieldConfidence.skills ?? 0).toBe(0);
  });

  // (c) recognized SKILLS section present and non-empty → other bucket ignored.
  it("(c) does not touch a real SKILLS section when ADDITIONAL also carries a skill line", () => {
    const items = mkItems([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "SKILLS", fontSize: 13 },
      // 5+ skills → extractSkills gives confidence 0.85 (real section path)
      { text: "Python, TypeScript, Go, Rust, SQL, Kubernetes", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "ADDITIONAL", fontSize: 13 },
      { text: "Technical Skills: Advanced in PHP, Java", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);
    // The real skills section wins; its tokens are present.
    expect(result.parsed.skills).toEqual(
      expect.arrayContaining(["Python", "TypeScript", "Go"]),
    );
    // The inline-label skills from ADDITIONAL are NOT injected when real section exists
    expect(result.parsed.skills).not.toContain("Advanced in PHP");
    // fieldConfidence.skills is 0.85 (real section with ≥5 skills), not recovery (0.65)
    expect(result.fieldConfidence.skills ?? 0).toBe(0.85);
  });

  // (e) other section with inline-labeled skill line + empty/absent skills section
  //     → parsed.skills populated, fieldConfidence.skills === 0.65
  it("(e) routes Technical Skills from ADDITIONAL into parsed.skills when no SKILLS section", () => {
    const items = mkItems([
      { text: "Jane Doe", fontSize: 18 },
      { text: "jane@example.com · (312) 555-0123 · Chicago, IL", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp Jan 2022 - Present", fontSize: 11 },
      { text: "• Led platform migration", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "EDUCATION", fontSize: 13 },
      { text: "State University B.S. Computer Science 2021", fontSize: 11 },
      { text: "", fontSize: 10 },
      // Unrecognized header → lands in "other" bucket
      { text: "ADDITIONAL", fontSize: 13 },
      {
        text: "Technical Skills: Advanced in SQL, PHP, Javascript, HTML/CSS; Proficient in MATLAB, Python",
        fontSize: 10,
      },
      { text: "Authorized to work in the US without sponsorship.", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);

    // Skills must be populated from the ADDITIONAL inline-labeled line
    expect(result.parsed.skills.length).toBeGreaterThan(0);
    // The SKILL_SPLIT_RE splits on comma/semicolon, giving multi-word phrases:
    //   "Advanced in SQL", "PHP", "Javascript", "HTML", "CSS",
    //   "Proficient in MATLAB", "Python"
    // Assert on the tokens that actually survive isSkillToken (≤4 words each).
    expect(result.parsed.skills).toEqual(
      expect.arrayContaining(["PHP", "Python", "Proficient in MATLAB"]),
    );
    // The label itself must NOT appear as a skill
    expect(result.parsed.skills).not.toContain("Technical Skills");
    expect(result.parsed.skills).not.toContain("Technical");
    // Confidence must be exactly the recovery-path constant
    expect(result.fieldConfidence.skills).toBe(0.65);
  });

  it("(e-variant) also matches 'Key Competencies:' and 'Core Technologies:' labels", () => {
    const items = mkItems([
      { text: "Alex Rivera", fontSize: 18 },
      { text: "alex@example.com", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Globex Corp 2020 - Present", fontSize: 11 },
      { text: "", fontSize: 10 },
      // Two different label variants in the same ADDITIONAL block
      { text: "ADDITIONAL", fontSize: 13 },
      { text: "Key Competencies: Leadership, Agile, Scrum", fontSize: 10 },
      { text: "Core Technologies: Docker, Kubernetes", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);

    expect(result.parsed.skills).toEqual(
      expect.arrayContaining(["Leadership", "Agile", "Scrum", "Docker", "Kubernetes"]),
    );
    expect(result.fieldConfidence.skills).toBe(0.65);
  });
});
