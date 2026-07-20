// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
import { computeAnonymousAtsScore } from "../score/score.ts";
import { localizeSkills } from "./localize/skills.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe.runIf(process.env.RL_SKILLS_PDF)(
  "skills dev probe (RL_SKILLS_PDF)",
  () => {
    // Deliberate monolithic diagnostic harness (mirrors probe-contact /
    // probe-experience): one linear read-out of parse → verdict so the whole
    // triage is visible in a single scroll. Not production logic.
    // fallow-ignore-next-line complexity
    it("extracts + verifies the skills section for RL_SKILLS_PDF", async () => {
      const path = process.env.RL_SKILLS_PDF!;
      const outDir =
        process.env.RL_SKILLS_OUT ?? join(HERE, "../../..", "internal/skills");

      const cascade = await runCascade(new Uint8Array(readFileSync(path)));
      const p = cascade.canonical.fields;

      const score = computeAnonymousAtsScore({
        parsed: { ...p },
        fieldConfidence: cascade.canonical.fieldConfidence,
        triggers: cascade.triggers,
        rawText: cascade.rawText,
        sections: cascade.canonical.sections,
      });

      const {
        skills,
        skillsRegion,
        sectionOverview,
        headerCandidates,
        missedSkillsHeaders,
        orphanBlock,
        verdict,
      } = localizeSkills(cascade);

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
        headerCandidates,
        missedSkillsHeaders,
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
