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
    // HTML/CSS has word chars on both sides of the slash — the fix (issue #220)
    // keeps it as one token rather than splitting. "HTML" and "CSS" do NOT
    // appear as separate tokens.
    expect(result).toEqual(expect.arrayContaining(["HTML/CSS"]));
    expect(result).not.toContain("HTML");
    expect(result).not.toContain("CSS");
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
    // Splitting on comma/semicolon gives multi-word phrases:
    //   "Advanced in SQL", "PHP", "Javascript", "HTML/CSS" (kept whole — #220
    //   fix: slash between word chars no longer splits),
    //   "Proficient in MATLAB", "Python"
    // Assert on the tokens that actually survive isSkillToken (≤6 words each).
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

// ── Issue #220: comma-in-parens, AI/ML slash, 5-word skill, soft-wrap ────────

describe("tokenizeSkillLine — issue #220 fixes", () => {
  it("does not split on a comma inside balanced parentheses", () => {
    // "Cloud Infrastructure (GCP, Hybrid Cloud)" must be ONE token, not two.
    const result = tokenizeSkillLine(
      "Distributed Systems Architecture, Cloud Infrastructure (GCP, Hybrid Cloud), AI/ML Orchestration",
    );
    expect(result).toContain("Cloud Infrastructure (GCP, Hybrid Cloud)");
    expect(result).toContain("Distributed Systems Architecture");
    expect(result).toContain("AI/ML Orchestration");
    // The in-parens comma must NOT produce orphan tokens
    expect(result).not.toContain("Cloud Infrastructure (GCP");
    expect(result).not.toContain("Hybrid Cloud)");
  });

  it("keeps AI/ML, CI/CD, TCP/IP as single tokens (slash between word chars)", () => {
    const result = tokenizeSkillLine("AI/ML Orchestration, CI/CD Pipelines, TCP/IP Networking");
    expect(result).toContain("AI/ML Orchestration");
    expect(result).toContain("CI/CD Pipelines");
    expect(result).toContain("TCP/IP Networking");
    // Must NOT split any of them on the slash
    expect(result).not.toContain("AI");
    expect(result).not.toContain("ML Orchestration");
    expect(result).not.toContain("CI");
    expect(result).not.toContain("CD Pipelines");
  });

  it("still splits on a standalone slash flanked by spaces (e.g. Python / JavaScript)", () => {
    // A slash that is NOT flanked by word chars (spaces on both sides) IS a
    // separator — this is intentional and must not regress.
    const result = tokenizeSkillLine("Python / JavaScript");
    expect(result).toEqual(expect.arrayContaining(["Python", "JavaScript"]));
    expect(result).not.toContain("Python / JavaScript");
  });

  it("allows 5-word skill phrases through the word-count filter", () => {
    // "LLM Architectures & Prompt Engineering" is 5 words — the old >4 filter
    // dropped it; the new >6 filter retains it.
    const result = tokenizeSkillLine(
      "LLM Architectures & Prompt Engineering, Cloud Infrastructure (GCP, Hybrid Cloud)",
    );
    expect(result).toContain("LLM Architectures & Prompt Engineering");
    expect(result).toContain("Cloud Infrastructure (GCP, Hybrid Cloud)");
  });

  it("still rejects obvious sentence fragments (7+ words)", () => {
    // The word-count cap moved from >4 to >6. A 7-word sentence fragment must
    // still be rejected.
    const result = tokenizeSkillLine(
      "Python, Over 200 technical interviews for senior engineering roles, SQL",
    );
    // "Over 200 technical interviews for senior engineering roles" is 8 words →
    // dropped. The short tokens survive.
    expect(result).toContain("Python");
    expect(result).toContain("SQL");
    expect(result).not.toContain("Over 200 technical interviews for senior engineering roles");
  });

  it("does not swallow items after an unbalanced open paren (OCR artifact)", () => {
    // "C++ (advanced" never closes its paren, so depth-tracked comma-splitting
    // would suppress every comma after it and absorb the trailing items into one
    // token. The unbalanced-paren fallback re-splits paren-blind so "Node" is
    // still recovered as its own token.
    const result = tokenizeSkillLine("React, C++ (advanced, Node");
    expect(result).toContain("React");
    expect(result).toContain("Node");
    // The whole tail is not glued into one swallowed token.
    expect(result).not.toContain("C++ (advanced, Node");
  });
});

describe("parseHeuristic — soft-wrapped skills lines rejoined (#220)", () => {
  it("rejoins a skill name that pdfjs broke across two lines", () => {
    // Simulates: "..., ISP Network" on line N and "Engineering, ..." on line N+1.
    // After rejoin: "ISP Network Engineering" is one token.
    // Synthetic resume persona: Jordan Lee, jordan.lee@example.com, (415) 555-0147
    const items = mkItems([
      { text: "Jordan Lee", fontSize: 18 },
      { text: "jordan.lee@example.com  (415) 555-0147  San Francisco, CA", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "SKILLS", fontSize: 13 },
      // Line 1 of a comma list that wraps: ends mid-skill-name "ISP Network"
      { text: "Distributed Systems Architecture, Cloud Infrastructure (GCP, Hybrid Cloud), ISP Network", fontSize: 10 },
      // Line 2: continuation — "Engineering" completes "ISP Network Engineering"
      { text: "Engineering, AI/ML Orchestration, LLM Architectures & Prompt Engineering", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);

    // The rejoined skill must appear
    expect(result.parsed.skills).toContain("ISP Network Engineering");
    // The parenthetical form must not be split
    expect(result.parsed.skills).toContain("Cloud Infrastructure (GCP, Hybrid Cloud)");
    // AI/ML slash stays together
    expect(result.parsed.skills).toContain("AI/ML Orchestration");
    // 5-word skill survives the word filter
    expect(result.parsed.skills).toContain("LLM Architectures & Prompt Engineering");
    // Orphan half-tokens must NOT appear
    expect(result.parsed.skills).not.toContain("ISP Network");
    expect(result.parsed.skills).not.toContain("Engineering");
  });

  it("does not merge label-prefixed sub-lines into a continuation", () => {
    // "Databases: MySQL" must NOT be joined to the previous "Languages: Python, JS" line.
    const items = mkItems([
      { text: "Casey Kim", fontSize: 18 },
      { text: "casey.kim@example.com  (312) 555-0182  Chicago, IL", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "SKILLS", fontSize: 13 },
      { text: "Languages: Python, JavaScript", fontSize: 10 },
      { text: "Databases: MySQL, PostgreSQL", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);

    // Each label group is a separate logical cell — tokens from both survive
    expect(result.parsed.skills).toEqual(
      expect.arrayContaining(["Python", "JavaScript", "MySQL", "PostgreSQL"]),
    );
    // "JavaScript Databases" must NOT appear (it would if the lines were naively joined)
    expect(result.parsed.skills).not.toContain("JavaScript Databases");
  });

  it("does not merge a comma-less standalone skill into a following comma-list", () => {
    // A single-skill line with no comma ("Machine Learning") followed by an
    // independent comma-list ("Data Analysis, Python, SQL") must NOT be treated
    // as a soft-wrap continuation — the old Condition B merged them into
    // "Machine Learning Data Analysis", losing both as standalone skills.
    const items = mkItems([
      { text: "Riley Park", fontSize: 18 },
      { text: "riley.park@example.com  (206) 555-0133  Seattle, WA", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "SKILLS", fontSize: 13 },
      { text: "Machine Learning", fontSize: 10 },
      { text: "Data Analysis, Python, SQL", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);

    expect(result.parsed.skills).toEqual(
      expect.arrayContaining(["Machine Learning", "Data Analysis", "Python", "SQL"]),
    );
    expect(result.parsed.skills).not.toContain("Machine Learning Data Analysis");
  });
});

// ── Issue #221: Interests/Hobbies sub-labels must not bleed into skills ───────

describe("tokenizeSkillLine — issue #221 non-skill sub-labels", () => {
  it("drops an Interests: sub-label cell entirely", () => {
    const result = tokenizeSkillLine(
      "Interests: Science Fiction Novels, Weightlifting, Gardening, Tennis",
    );
    expect(result).toEqual([]);
  });

  it("drops a Hobbies: sub-label cell entirely", () => {
    expect(tokenizeSkillLine("Hobbies: Reading, Cooking, Hiking")).toEqual([]);
  });

  it("drops an Activities: sub-label cell entirely", () => {
    expect(tokenizeSkillLine("Activities: Basketball, Chess")).toEqual([]);
  });

  it("drops a qualified 'Personal Interests:' / 'Other Hobbies:' cell", () => {
    expect(tokenizeSkillLine("Personal Interests: Eating, Travel")).toEqual([]);
    expect(tokenizeSkillLine("Other Hobbies: Painting")).toEqual([]);
  });

  it("keeps skill sub-labels (Languages/Technologies/Tools/Frameworks)", () => {
    expect(tokenizeSkillLine("Languages: Python, Go, C++, Java")).toEqual(
      expect.arrayContaining(["Python", "Go", "C++", "Java"]),
    );
    expect(tokenizeSkillLine("Technologies: Linux, AWS, Docker, iOS")).toEqual(
      expect.arrayContaining(["Linux", "AWS", "Docker", "iOS"]),
    );
    expect(tokenizeSkillLine("Tools: Git, Vim")).toEqual(
      expect.arrayContaining(["Git", "Vim"]),
    );
    expect(tokenizeSkillLine("Frameworks: React, Vue")).toEqual(
      expect.arrayContaining(["React", "Vue"]),
    );
  });

  it("does not catch a real skill that merely starts with a denylist word", () => {
    // "Interest Rate Modeling" is a legitimate skill, not an "Interests:" label
    // — the denylist matches the WHOLE label phrase, so this survives.
    const result = tokenizeSkillLine("Interest Rate Modeling, Risk Analysis");
    expect(result).toEqual(
      expect.arrayContaining(["Interest Rate Modeling", "Risk Analysis"]),
    );
  });
});

describe("parseHeuristic — issue #221 Interests sub-label in SKILLS section", () => {
  it("excludes Interests items while keeping Languages/Technologies skills", () => {
    // Repro from the issue: a Technical Skills section internally sub-labeled
    // with Languages / Technologies / Interests. Only the genuine skill
    // sub-labels should reach parsed.skills.
    const items = mkItems([
      { text: "Jordan Lee", fontSize: 18 },
      { text: "jordan.lee@example.com  (312) 555-0123  Chicago, IL", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "TECHNICAL SKILLS", fontSize: 13 },
      { text: "Languages: Python, Go, C++, Java, JavaScript", fontSize: 10 },
      { text: "Technologies: Linux, AWS, Docker, iOS", fontSize: 10 },
      {
        text: "Interests: Science Fiction Novels, Weightlifting, Gardening, Eating, Tennis, Basketball",
        fontSize: 10,
      },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);

    // Genuine skills survive.
    expect(result.parsed.skills).toEqual(
      expect.arrayContaining(["Python", "Go", "Java", "Linux", "AWS", "Docker"]),
    );
    // Hobbies must NOT be scored/displayed as professional skills.
    for (const hobby of [
      "Science Fiction Novels",
      "Weightlifting",
      "Gardening",
      "Eating",
      "Tennis",
      "Basketball",
    ]) {
      expect(result.parsed.skills).not.toContain(hobby);
    }
  });
});
