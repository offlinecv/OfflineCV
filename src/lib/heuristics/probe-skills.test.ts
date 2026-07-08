// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Skills-section dev probe — inert in CI, runs ONLY when
 * `RL_SKILLS_PDF=<path>` is set:
 *
 *   RL_SKILLS_PDF=/abs/path/to/resume.pdf npx vitest run \
 *     src/lib/heuristics/probe-skills.test.ts
 *
 * Extracts + VERIFIES the skills section of one arbitrary PDF so a real
 * (uncommitted, possibly PII-bearing) résumé can be triaged WITHOUT being
 * committed as a fixture. This is the execution vehicle for the `probe-skills`
 * skill — sibling of `probe-contact` / `probe-experience` / `probe-roundtrip`;
 * the pattern is identical: run the real parser via runCascade (the pdfjs
 * worker only resolves under the vitest transform — no standalone script), then
 * show the section router's INPUT (the header candidates it saw + the skills
 * region it scanned) next to its OUTPUT (the parsed skills list) so a dropped
 * skills section is localizable to a layer.
 *
 * ── PII guardrail (same rules as the sibling probes) ──
 * 1. The input PDF is local-only. NEVER commit it. `tests/fixtures/pdfs/` is
 *    synthetic-personas-only by policy.
 * 2. The console + JSON output prints skill VALUES so the corruption is visible
 *    → scratch only. The full JSON goes to the gitignored `internal/skills/`
 *    dir. Do not paste raw values into an issue/PR/Slack; cite the corruption
 *    by CATEGORY ("skills count 4 → 0; header unrecognized due to a leading
 *    glyph").
 *
 * ── The "verify" pass ──
 * There is no ground truth for a real résumé, so verification is an independent
 * re-scan of the document's header candidates. The section router
 * (`matchSectionHeader`) is EXACT-match after a trailing-punct strip, so a
 * header carrying a leading decorative glyph (`¥Skills`, #414), an out-of-alias
 * wording, or a two-line wrap (#374) is silently rejected and the whole skills
 * section drops. The oracle:
 *   - parsed skills > 0                        → ok
 *   - 0 parsed, a `skills` region WAS routed   → EXTRACTION-MISS (router found
 *     the section; the extractor dropped its content)
 *   - 0 parsed, NO region, but a header candidate loosely reads as skills that
 *     the strict matcher rejected → HEADER-UNRECOGNIZED (the #414/#374 class —
 *     reports WHY the strict matcher missed it)
 *   - 0 parsed, nothing skills-like anywhere   → NO-SKILLS-SECTION
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import { matchSectionHeader, SECTION_KEYWORDS } from "./regex.ts";
import { SECTION_ANCHORS } from "./sections.config.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const SKILLS_ALIASES = SECTION_KEYWORDS.skills ?? [];
const SKILLS_ANCHORS: ReadonlySet<string> = SECTION_ANCHORS.skills ?? new Set();

/**
 * Loose skills-header oracle. Mirrors the strict normalizer in
 * `matchSectionHeaderDetailed` but ALSO strips a leading run of non-letter /
 * non-number glyphs — the exact gap #414 identified. Returns the reason a
 * strict match would have failed, or null if the line doesn't read as skills.
 */
function looseSkillsReason(raw: string): string | null {
  const trimmedLower = raw.trim().toLowerCase().replace(/[:·•]+$/, "").trim();
  const glyphStripped = trimmedLower.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (glyphStripped.length === 0 || glyphStripped.length > 40) return null;
  if (SKILLS_ALIASES.includes(glyphStripped)) {
    return glyphStripped === trimmedLower
      ? "alias match (would route — not a miss)"
      : `leading-glyph prefix (${JSON.stringify(trimmedLower)} → ${JSON.stringify(glyphStripped)})`;
  }
  const tokens = glyphStripped.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => SKILLS_ANCHORS.has(t)))
    return `contains skills anchor token but wording not in aliases (${JSON.stringify(glyphStripped)})`;
  return null;
}

describe.runIf(process.env.RL_SKILLS_PDF)(
  "skills dev probe (RL_SKILLS_PDF)",
  () => {
    it("extracts + verifies the skills section for RL_SKILLS_PDF", async () => {
      const path = process.env.RL_SKILLS_PDF!;
      const outDir =
        process.env.RL_SKILLS_OUT ?? join(HERE, "../../..", "internal/skills");

      const cascade = await runCascade(new Uint8Array(readFileSync(path)));
      const p = cascade.parsed;

      const score = computeAnonymousAtsScore({
        parsed: { ...p },
        fieldConfidence: cascade.fieldConfidence,
        triggers: cascade.triggers,
        rawText: cascade.rawText,
        sections: cascade.sections,
      });

      // OUTPUT: the parsed skills list.
      const skills = [...(p.skills ?? [])];

      // INPUT (routed): the skills region the extractor scanned, if any.
      const skillsRegion = [...(cascade.sections.byName.get("skills") ?? [])];
      const skillsRegionPresent = skillsRegion.length > 0;

      // Section-detection overview (all regions, line counts only).
      const sectionOverview = [...cascade.sections.byName.entries()].map(
        ([name, lines]) => `${name}(${lines.length})`,
      );

      // Header candidates from the ordered markdown (`#`/`##`/`###` lines). The
      // markdown header heuristic is looser than the router, so a rejected
      // skills header still shows up here — that is exactly what localizes a
      // routing miss.
      const md = cascade.markdown ?? "";
      const mdLines = md.split("\n");
      const headerCandidates = mdLines
        .map((l, i) => ({ text: l.replace(/^#{1,3}\s+/, "").trim(), i, isHeader: /^#{1,3}\s+/.test(l) }))
        .filter((h) => h.isHeader && h.text.length > 0);

      // A skills-like header the strict router did NOT map to skills.
      const missedSkillsHeaders = headerCandidates
        .map((h) => ({ ...h, strict: matchSectionHeader(h.text), reason: looseSkillsReason(h.text) }))
        .filter(
          (h) =>
            h.strict !== "skills" &&
            h.reason !== null &&
            !h.reason.startsWith("alias match"),
        );

      // The markdown block under the first missed header (its dropped content),
      // up to the next markdown header — the skills content that should have
      // been routed. Scrubbed to a line count in the console; full text only in
      // the gitignored JSON.
      let orphanBlock: string[] = [];
      if (missedSkillsHeaders.length > 0) {
        const start = missedSkillsHeaders[0].i + 1;
        for (let i = start; i < mdLines.length; i++) {
          if (/^#{1,3}\s+/.test(mdLines[i])) break;
          if (mdLines[i].trim()) orphanBlock.push(mdLines[i].trim());
        }
      }

      let verdict: string;
      if (skills.length > 0) {
        verdict = `ok (${skills.length} skill entries parsed)`;
      } else if (skillsRegionPresent) {
        verdict = `EXTRACTION-MISS (skills region routed with ${skillsRegion.length} lines but 0 skills parsed)`;
      } else if (missedSkillsHeaders.length > 0) {
        verdict = `HEADER-UNRECOGNIZED (skills-like header rejected by the strict router → ${missedSkillsHeaders[0].reason})`;
      } else {
        verdict = "NO-SKILLS-SECTION (no routed region and no skills-like header candidate)";
      }

      const report = {
        path,
        score: {
          overall: score.overall,
          preLayoutOverall: score.preLayoutOverall,
          layoutTriggers: [...score.layout.triggers],
          layoutMultiplier: score.layout.multiplier,
        },
        sectionOverview,
        skills,
        skillsRegion,
        headerCandidates: headerCandidates.map((h) => ({
          text: h.text,
          strict: matchSectionHeader(h.text),
        })),
        missedSkillsHeaders: missedSkillsHeaders.map((h) => ({
          text: h.text,
          reason: h.reason,
        })),
        orphanBlock,
        verdict,
        triggers: [...cascade.triggers],
      };

      mkdirSync(outDir, { recursive: true });
      const outFile = join(
        outDir,
        `skills-${basename(path).replace(/\.[^.]+$/, "")}.json`,
      );
      writeFileSync(outFile, JSON.stringify(report, null, 2));

      console.log(
        `RL_SKILLS_PDF skills probe for ${path}:\n` +
          `\n  Score: overall ${score.overall} (pre-layout ${score.preLayoutOverall}, ` +
          `layout ×${score.layout.multiplier} [${score.layout.triggers.join(", ") || "none"}])\n` +
          `\n  Sections detected: ${sectionOverview.join("  ")}\n` +
          `\n  Parsed skills (${skills.length}):\n` +
          (skills.length
            ? skills.map((s, i) => `    ${i + 1}. ${JSON.stringify(s)}`).join("\n")
            : "    (none)") +
          `\n\n  Skills region scanned (${skillsRegion.length} lines):\n` +
          (skillsRegion.length
            ? skillsRegion.map((l) => `    | ${l}`).join("\n")
            : "    (empty — no skills region routed)") +
          `\n\n  Skills-like headers the router REJECTED (${missedSkillsHeaders.length}):\n` +
          (missedSkillsHeaders.length
            ? missedSkillsHeaders
                .map((h) => `    | ${JSON.stringify(h.text)} — ${h.reason}`)
                .join("\n")
            : "    (none)") +
          (orphanBlock.length
            ? `\n\n  Dropped skills content under that header (${orphanBlock.length} lines — values in JSON):`
            : "") +
          `\n\n  Verify: ${verdict}` +
          `\n\n  Full JSON → ${outFile}  ⚠️ gitignored; may carry PII, do NOT commit.`,
      );

      // Informational only: never fails the suite.
      expect(true).toBe(true);
    });
  },
);
