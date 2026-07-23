// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { extractSkills, tokenizeSkillLine } from "./skills.ts";
import type { PdfLine, PdfSection } from "../sections.ts";
import type { PdfTextItem } from "../types.ts";
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

  it("splits on inline round/square bullet glyphs incl. ● U+25CF (not just • U+2022)", () => {
    // Word / Google-Docs commonly separate inline skills with a `●` BLACK CIRCLE
    // (U+25CF), a different codepoint from the `•` BULLET (U+2022) the splitter
    // already handled — so `Python ● SQL ● Docker` used to come back as ONE
    // merged token carrying two literal `●` glyphs (which then rewrote to `?` on
    // the Download-PDF round-trip via the WinAnsi sanitizer).
    const result = tokenizeSkillLine("Python ● SQL ● Docker ● Kubernetes");
    expect(result).toEqual(["Python", "SQL", "Docker", "Kubernetes"]);
    // The sibling bullet glyphs from the canonical set split too.
    expect(tokenizeSkillLine("Go ‣ Rust ▪ Scala ◦ Elixir")).toEqual([
      "Go",
      "Rust",
      "Scala",
      "Elixir",
    ]);
  });

  it("does NOT split a hyphenated skill name on its dash", () => {
    // The dash glyphs are excluded from the bullet-separator set precisely so a
    // real hyphenated skill survives whole.
    expect(tokenizeSkillLine("CI-CD, front-end, back-end")).toEqual([
      "CI-CD",
      "front-end",
      "back-end",
    ]);
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

  it("rejoins a skill list that wrapped right before a leading connector glyph", () => {
    // pdfjs broke the last skill "API Design & Development" so the connector `&`
    // leads the final line: "…, API Design" ⏎ "& Development". The tail carries
    // no comma, so Condition B can't fire and the pre-fix code emitted a bogus
    // "& Development" skill while stranding "API Design" alone. Condition A′
    // (next line leads with a bare `&`/`+`) rejoins them.
    // Synthetic persona: Morgan Diaz, morgan.diaz@example.com, (312) 555-0155
    const items = mkItems([
      { text: "Morgan Diaz", fontSize: 18 },
      { text: "morgan.diaz@example.com  (312) 555-0155  Austin, TX", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "SKILLS", fontSize: 13 },
      { text: "Performance Optimization, API Design", fontSize: 10 },
      { text: "& Development", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);

    // The wrapped skill is rejoined whole
    expect(result.parsed.skills).toContain("API Design & Development");
    // Neither orphan half survives
    expect(result.parsed.skills).not.toContain("API Design");
    expect(result.parsed.skills).not.toContain("& Development");
    // A skill before the wrap is untouched
    expect(result.parsed.skills).toContain("Performance Optimization");
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

// ── Issue #282: "Programs, Skills, Software" header + connector-glyph sub-labels
describe('parseHeuristic — "Programs, Skills, Software" section, all sub-lines (#282)', () => {
  it("recognizes the comma-list header and recovers every sub-labeled line, incl. an & label", () => {
    const items = mkItems([
      { text: "Jordan Rivera", fontSize: 18 },
      { text: "jordan.rivera@example.com · (408) 555-0142 · Berkeley, CA", fontSize: 10 },
      { text: "", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp Jan 2022 - Present", fontSize: 11 },
      { text: "• Led the thing", fontSize: 10 },
      { text: "", fontSize: 10 },
      // Header is NOT a bare "Skills" — only recognized via the new alias (#282).
      { text: "Programs, Skills, Software", fontSize: 13 },
      { text: "Team Management: Asana, Notion, Trello", fontSize: 10 },
      { text: "Technical Skills: G Suite, InDesign, Microsoft Word, Canva", fontSize: 10 },
      // The `&` in this sub-label previously failed the label char-class, so the
      // line was soft-wrap-joined into the preceding cell and its tokens dropped.
      { text: "Writing & Editing: grammar, spelling, style", fontSize: 10 },
    ]);
    const pages = mkDefaultPages(items);
    const result = parseHeuristic(items, pages);

    // A token from EACH of the three sub-labeled lines must survive.
    expect(result.parsed.skills).toEqual(
      expect.arrayContaining([
        "Asana", // Team Management
        "Canva", // Technical Skills
        "grammar", // Writing & Editing (the & line that used to be dropped)
      ]),
    );
    // The `&` sub-label itself must not leak in as a skill token.
    expect(result.parsed.skills).not.toContain("Writing & Editing");
    // Real section path (≥5 tokens) → 0.85, not the recovery constant 0.65.
    expect(result.fieldConfidence.skills).toBe(0.85);
  });
});

// ── Bulleted labelled single-column rows (#465) ──────────────────────────────

/**
 * Build a Skills section from item-level geometry.
 *
 * The bullet geometry is load-bearing and mirrors what pdfjs emits for a real
 * Word/LaTeX bulleted list: the marker is its own text run at the margin, and
 * the hanging indent behind it arrives as a synthesized blank item wider than
 * the column-spacer floor (`> max(fontSize, 10)`).
 */
function skillsLines(
  rows: Array<Array<{ x: number; str: string; w: number }>>,
): PdfSection {
  const lines: PdfLine[] = rows.map((runs, i) => {
    const y = 300 + i * 13;
    const items: PdfTextItem[] = runs.map((r) => ({
      page: 1,
      str: r.str,
      x: r.x,
      y,
      width: r.w,
      height: 10,
      fontSize: 10,
      fontName: "font-10",
      hasEOL: true,
    }));
    return {
      page: 1,
      y,
      x: runs[0].x,
      items,
      text: runs
        .map((r) => r.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
      maxFontSize: 10,
      allCaps: false,
      gapAbove: 0,
    };
  });
  return { name: "skills", lines };
}

/** The bullet marker (`w: 3.5`) plus its hanging-indent blank (`w: 10.5`, wider
 *  than the 10pt spacer floor — this is what used to read as a column gutter). */
const BULLET_RUNS = [
  { x: 60, str: "•", w: 3.5 },
  { x: 64, str: " ", w: 10.5 },
];

describe("extractSkills — bulleted labelled single-column rows (#465)", () => {
  it("rejoins a skill name the wrap broke, despite the bullet's hanging indent", () => {
    // "… Tailwind" ⏎ "CSS, React Query" — before the fix the bullet's indent
    // blank made the row look multi-column, which bypassed the soft-wrap
    // rejoin and shredded "Tailwind CSS" into two tokens.
    const section = skillsLines([
      [
        ...BULLET_RUNS,
        { x: 74, str: "Frontend:", w: 46.7 },
        { x: 121, str: " ", w: 2.6 },
        { x: 123, str: "React, TypeScript, Tailwind", w: 130 },
      ],
      [{ x: 74, str: "CSS, React Query", w: 78 }],
    ]);
    const value = extractSkills(section).value;

    expect(value).toContain("Tailwind CSS");
    expect(value).toContain("React Query");
    expect(value).not.toContain("Tailwind");
    expect(value).not.toContain("CSS");
    // The category label is not a skill.
    expect(value).not.toContain("Frontend");
  });

  it("keeps a parenthesised clarifier whole when the wrap lands inside it", () => {
    // "… AWS (EC2," ⏎ "S3, RDS)" — the pending line ends on a comma, so the
    // comma-list rule alone declines to rejoin; the unclosed paren is what
    // proves the break is mid-token.
    const section = skillsLines([
      [
        ...BULLET_RUNS,
        { x: 74, str: "Cloud & Infra:", w: 66.1 },
        { x: 140, str: " ", w: 2.8 },
        { x: 143, str: "Docker, Terraform, AWS (EC2,", w: 135 },
      ],
      [{ x: 74, str: "S3, RDS)", w: 38 }],
    ]);
    const value = extractSkills(section).value;

    expect(value).toContain("AWS (EC2, S3, RDS)");
    expect(value).toEqual(expect.arrayContaining(["Docker", "Terraform"]));
    expect(value).not.toContain("AWS (EC2");
    expect(value).not.toContain("S3");
    expect(value).not.toContain("RDS)");
    expect(value).not.toContain("Cloud");
  });

  it("does not swallow the section behind a STRAY open paren", () => {
    // Regression guard for the bounded half of Condition C. An open paren that
    // the next line never closes is an OCR artifact, not a wrap. Joining on the
    // open paren alone never re-satisfies its own predicate, so every following
    // line would keep joining and the whole section would collapse into one
    // garbage token — starving the unbalanced-paren fallback in
    // `splitRespectingParens` that recovers the items after the stray "(".
    const section = skillsLines([
      [{ x: 74, str: "Cloud (AWS", w: 50 }],
      [{ x: 74, str: "Docker", w: 30 }],
      [{ x: 74, str: "Kubernetes", w: 50 }],
      [{ x: 74, str: "Terraform", w: 45 }],
    ]);

    expect(extractSkills(section).value).toEqual([
      "Cloud (AWS",
      "Docker",
      "Kubernetes",
      "Terraform",
    ]);
  });

  it("rejoins a tab-aligned label torn off its body, and rejoins its wrap", () => {
    // A Word/Google-Docs tab stop sets the body far enough after the bold
    // `Label:` that the blank clears the spacer floor — so the row splits into
    // `Label:` + body and takes the multi-column branch, which cannot
    // soft-wrap-rejoin. `dropLeadingBullet` alone does NOT rescue this (the gap
    // is not the bullet's hanging indent); the bare-label rejoin does.
    const section = skillsLines([
      [
        ...BULLET_RUNS,
        { x: 74, str: "Frontend:", w: 46.7 },
        { x: 121, str: " ", w: 24 }, // tab stop — above the 10pt spacer floor
        { x: 145, str: "React, TypeScript, Tailwind", w: 130 },
      ],
      [{ x: 74, str: "CSS, React Query", w: 78 }],
    ]);
    const value = extractSkills(section).value;

    expect(value).toContain("Tailwind CSS");
    expect(value).not.toContain("Tailwind");
    expect(value).not.toContain("CSS");
    expect(value).not.toContain("Frontend");
  });

  it("keeps a tab-aligned MULTI-column labelled grid as separate columns", () => {
    // The bare-label rejoin must re-attach each label to its OWN body only —
    // collapsing the whole row instead would strip just the first label and
    // leave a garbage "Vue Backend: Java" token.
    const section = skillsLines([
      [
        { x: 74, str: "Frontend:", w: 46.7 },
        { x: 121, str: " ", w: 24 },
        { x: 145, str: "React, Vue", w: 50 },
        { x: 195, str: " ", w: 60 },
        { x: 255, str: "Backend:", w: 44 },
        { x: 299, str: " ", w: 24 },
        { x: 323, str: "Java, Go", w: 40 },
      ],
    ]);

    expect(extractSkills(section).value).toEqual([
      "React",
      "Vue",
      "Java",
      "Go",
    ]);
  });

  it("drops a bare label that another bare label would otherwise absorb", () => {
    // Two consecutive label-only cells ("Frontend:" ⇥ "Backend:" ⇥ "Java, Go").
    // The rejoin must not let the FIRST label swallow the SECOND: the merged
    // "Frontend: Backend:" is no longer bare, so the real body would attach to
    // the wrong label and `Backend:` would survive as a skill token (the
    // trailing-punctuation strip in `tokenizeCell` excludes `:`). A label with
    // no body of its own is neither a column nor a skill — it is dropped.
    const section = skillsLines([
      [
        { x: 74, str: "Frontend:", w: 46.7 },
        { x: 121, str: " ", w: 24 },
        { x: 145, str: "Backend:", w: 44 },
        { x: 190, str: " ", w: 24 },
        { x: 214, str: "Java, Go", w: 40 },
      ],
    ]);

    expect(extractSkills(section).value).toEqual(["Java", "Go"]);
  });

  it("does not marry a stray open paren to an unrelated stray close paren", () => {
    // "Tools: Vim (advanced" ⏎ "Emacs, VS Code)". Both parens are strays, on
    // unrelated lines. Condition C keys on paren balance, so without its
    // "pending ends on a comma" conjunct it would join them into one garbage
    // token and LOSE `Emacs` and `VS Code`. The break here is not mid-list
    // inside a clarifier — pending does not end on a comma — so C declines.
    const section = skillsLines([
      [{ x: 74, str: "Tools: Vim (advanced", w: 95 }],
      [{ x: 74, str: "Emacs, VS Code)", w: 70 }],
    ]);

    expect(extractSkills(section).value).toEqual([
      "Vim (advanced",
      "Emacs",
      "VS Code)",
    ]);
    expect(extractSkills(section).value).not.toContain(
      "Vim (advanced Emacs, VS Code)",
    );
  });

  it("keeps a clarifier whole when it wraps across THREE lines (#475)", () => {
    // The complement of the two-line case above: closure now arrives on the
    // THIRD line. Condition C's bounded n-line look-ahead sees that
    // "Cloud & Infra: AWS (EC2," ⏎ "S3," ⏎ "RDS), Docker, Kubernetes" closes the
    // clarifier within the window, so the wrapped lines rejoin and
    // splitRespectingParens re-splits on the outside commas. Previously this was
    // a KNOWN LIMIT (shredded into "AWS (EC2" / "S3" / "RDS)").
    const section = skillsLines([
      [{ x: 74, str: "Cloud & Infra: AWS (EC2,", w: 118 }],
      [{ x: 74, str: "S3,", w: 20 }],
      [{ x: 74, str: "RDS), Docker, Kubernetes", w: 118 }],
    ]);
    const value = extractSkills(section).value;

    expect(value).toEqual(["AWS (EC2, S3, RDS)", "Docker", "Kubernetes"]);
    expect(value).not.toContain("AWS (EC2");
    expect(value).not.toContain("S3");
    expect(value).not.toContain("RDS)");
  });

  it("degrades to shredded-but-bounded when a clarifier wraps past the window", () => {
    // The look-ahead is CLARIFIER_WRAP_LOOKAHEAD lines deep, on purpose: a paren
    // whose close never arrives inside the window is treated as a stray "(" and
    // the join is refused — never swallowing the section into one cell. Here the
    // clarifier's items are spread one-per-line so closure sits well beyond the
    // window; the fallback shreds it, but every item survives as its own token
    // (nothing is lost, nothing is merged into a garbage super-token).
    const section = skillsLines([
      [{ x: 74, str: "Cloud: AWS (EC2,", w: 80 }],
      [{ x: 74, str: "S3,", w: 20 }],
      [{ x: 74, str: "RDS,", w: 25 }],
      [{ x: 74, str: "Lambda,", w: 40 }],
      [{ x: 74, str: "DynamoDB,", w: 55 }],
      [{ x: 74, str: "ECS,", w: 30 }],
      [{ x: 74, str: "EKS,", w: 30 }],
      [{ x: 74, str: "CloudFront)", w: 60 }],
    ]);
    const value = extractSkills(section).value;

    // Bounded: the stray-looking "(" is not swallowed; the trailing items are
    // recovered individually rather than collapsed into one cell.
    expect(value).toContain("AWS (EC2");
    expect(value).toContain("DynamoDB");
    expect(value).toContain("CloudFront)");
    expect(value).not.toContain(
      "AWS (EC2, S3, RDS, Lambda, DynamoDB, ECS, EKS, CloudFront)",
    );
  });

  it("recovers BOTH clarifiers when one closes and another opens across the wrap (#475)", () => {
    // "Cloud: AWS (EC2," ⏎ "S3), Azure (VMs," ⏎ "Blobs)". The middle line closes
    // the first clarifier and opens a second. Under #465's single-line look-ahead
    // the first join was declined (the one-line join `…(EC2, S3), Azure (VMs,`
    // does not balance) and the first clarifier shredded to "AWS (EC2" / "S3)".
    // With #475's bounded n-line look-ahead the scan sees the whole run balance
    // by the third line, so it rejoins; splitRespectingParens then re-splits on
    // the outside comma and BOTH clarifiers come back whole — strictly better
    // than the old shred-the-first behaviour.
    const section = skillsLines([
      [{ x: 74, str: "Cloud: AWS (EC2,", w: 80 }],
      [{ x: 74, str: "S3), Azure (VMs,", w: 80 }],
      [{ x: 74, str: "Blobs)", w: 35 }],
    ]);

    expect(extractSkills(section).value).toEqual([
      "AWS (EC2, S3)",
      "Azure (VMs, Blobs)",
    ]);
  });

  it("still splits a genuine multi-column row whose columns each carry a bullet", () => {
    // Regression guard: dropping the LEADING bullet must not collapse a real
    // multi-column skills grid. The wide inter-column blanks remain gutters.
    const section = skillsLines([
      [
        ...BULLET_RUNS,
        { x: 74, str: "Project management", w: 85 },
        { x: 207, str: " ", w: 59 },
        { x: 266, str: "•", w: 3.5 },
        { x: 271, str: "Data analysis", w: 53 },
        { x: 324, str: " ", w: 99 },
        { x: 423, str: "•", w: 3.5 },
        { x: 428, str: "Communication", w: 64 },
      ],
    ]);

    expect(extractSkills(section).value).toEqual([
      "Project management",
      "Data analysis",
      "Communication",
    ]);
  });
});

describe("extractSkills — category capture (#473)", () => {
  it("captures each label as a category and keeps `skills` the flat union", () => {
    const section = skillsLines([
      [...BULLET_RUNS, { x: 74, str: "Frontend: React, TypeScript", w: 140 }],
      [...BULLET_RUNS, { x: 74, str: "Backend: Java, Python", w: 120 }],
    ]);
    const { value, categories } = extractSkills(section);

    expect(value).toEqual(["React", "TypeScript", "Java", "Python"]);
    expect(categories).toEqual([
      { label: "Frontend", skills: ["React", "TypeScript"] },
      { label: "Backend", skills: ["Java", "Python"] },
    ]);
  });

  it("INVARIANT 1: `skills` deep-equals `categories.flatMap((c) => c.skills)`", () => {
    // A wrapped Frontend list whose continuation flushed as its own bare cell
    // ("… HTML5," ⏎ "CSS3, JavaScript") must fold back into Frontend, not become
    // an uncategorised tail that suppresses the whole structured view.
    const section = skillsLines([
      [
        ...BULLET_RUNS,
        { x: 74, str: "Frontend: React, TypeScript, HTML5,", w: 180 },
      ],
      [{ x: 74, str: "CSS3, JavaScript", w: 78 }],
      [...BULLET_RUNS, { x: 74, str: "Backend: Java, Go", w: 110 }],
    ]);
    const { value, categories } = extractSkills(section);

    expect(categories).toBeDefined();
    expect(value).toEqual(categories!.flatMap((c) => c.skills));
    // The wrap continuation belongs to Frontend, not to a bare bucket.
    expect(categories![0]).toEqual({
      label: "Frontend",
      skills: ["React", "TypeScript", "HTML5", "CSS3", "JavaScript"],
    });
  });

  it("INVARIANT 2: an uncategorised comma list yields `categories === undefined`", () => {
    const section = skillsLines([
      [{ x: 74, str: "React, TypeScript, Java, Python", w: 180 }],
    ]);
    const { value, categories } = extractSkills(section);

    expect(value).toEqual(["React", "TypeScript", "Java", "Python"]);
    expect(categories).toBeUndefined(); // not [], not a synthetic empty bucket
  });

  it("suppresses categories when a bare head precedes the first label", () => {
    // A partly-categorised section cannot satisfy invariant (1) without inventing
    // a bucket for the leading bare skills, so the structured view is dropped and
    // the flat list is preserved intact.
    const section = skillsLines([
      [{ x: 74, str: "React, TypeScript", w: 110 }],
      [...BULLET_RUNS, { x: 74, str: "Backend: Java, Go", w: 110 }],
    ]);
    const { value, categories } = extractSkills(section);

    expect(value).toEqual(["React", "TypeScript", "Java", "Go"]);
    expect(categories).toBeUndefined();
  });

  it("does not treat a hobbies/interests sub-label as a category", () => {
    // A non-skill sub-label contributes no tokens and must not become a category.
    const section = skillsLines([
      [...BULLET_RUNS, { x: 74, str: "Backend: Java, Go", w: 110 }],
      [...BULLET_RUNS, { x: 74, str: "Interests: Tennis, Gardening", w: 150 }],
    ]);
    const { value, categories } = extractSkills(section);

    expect(value).toEqual(["Java", "Go"]);
    expect(categories).toEqual([{ label: "Backend", skills: ["Java", "Go"] }]);
  });
});
