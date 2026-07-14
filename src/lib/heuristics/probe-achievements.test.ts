// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Achievements-section dev probe — inert in CI, runs ONLY when
 * `RL_ACHIEVEMENTS_PDF=<path>` is set:
 *
 *   RL_ACHIEVEMENTS_PDF=/abs/path/to/resume.pdf npx vitest run \
 *     src/lib/heuristics/probe-achievements.test.ts
 *
 * Extracts + VERIFIES the achievements section of one arbitrary PDF so a real
 * (uncommitted, possibly PII-bearing) résumé can be triaged WITHOUT being
 * committed as a fixture. This is the execution vehicle for the
 * `probe-achievements` skill — sibling of `probe-experience` / `probe-contact` /
 * `probe-roundtrip`; the pattern is identical: run the real parser via
 * runCascade (the pdfjs worker only resolves under the vitest transform — no
 * standalone script), then show the section extractor's INPUT (the achievements
 * region it scanned) next to its OUTPUT (the parsed achievement entries) so a
 * dropped/merged/mis-split achievement is localizable.
 *
 * ── PII guardrail (same rules as the sibling probes) ──
 * 1. The input PDF is local-only. NEVER commit it. `tests/fixtures/pdfs/` is
 *    synthetic-personas-only by policy.
 * 2. The console + JSON output prints achievement VALUES (titles, years) so the
 *    corruption is visible → scratch only. The full JSON goes to the gitignored
 *    `internal/` dir. Do not paste raw values into an issue/PR/Slack; cite the
 *    defect by CATEGORY ("the type label was split at the wrong middot").
 *
 * ── type / description ──
 * The parser stores the type label in its own `type` field, lifted off the
 * header's leading " · " run once at parse (#456); `title` carries only the
 * description. That stored `type` is the run the reconstructed view and the
 * Download PDF render bold (#452), and the field the inline editor commits
 * against (#454). The probe prints both halves as stored — no re-split — so a
 * mis-emphasized header ("the whole prose title bolded", "the type swallowed the
 * description") is visible as a parse defect, not just a styling one.
 *
 * ── The "verify" pass ──
 * There is no ground truth for a real résumé, so verification is a second,
 * independent scan of the region: every line that is NOT bullet-marked is a
 * candidate achievement HEADER, so the count of such lines is a lower-bound
 * oracle for how many entries SHOULD have segmented. The split localizes the
 * failure:
 *   - entries == 0 AND the region is non-empty  → PARSER-MISS (the block is in
 *     the region; entry segmentation dropped it)
 *   - entries  <  header-shaped lines           → UNDER-SEGMENTED (achievements
 *     merged into a neighbor entry)
 *   - entries >=  header-shaped lines           → ok (a wrapped header can
 *     legitimately exceed the oracle)
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import { localizeAchievements } from "./localize/achievements.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe.runIf(process.env.RL_ACHIEVEMENTS_PDF)(
  "achievements dev probe (RL_ACHIEVEMENTS_PDF)",
  () => {
    it("extracts + verifies the achievements section for RL_ACHIEVEMENTS_PDF", async () => {
      const path = process.env.RL_ACHIEVEMENTS_PDF!;
      const outDir =
        process.env.RL_ACHIEVEMENTS_OUT ??
        join(HERE, "../../..", "internal/achievements");

      const cascade = await runCascade(new Uint8Array(readFileSync(path)));
      const p = cascade.canonical.fields;

      const score = computeAnonymousAtsScore({
        parsed: { ...p },
        fieldConfidence: cascade.canonical.fieldConfidence,
        triggers: cascade.triggers,
        rawText: cascade.rawText,
        sections: cascade.canonical.sections,
      });

      const { entries, regionLines, sectionOverview, headerLines, verdict } =
        localizeAchievements(cascade);

      const report = {
        path,
        score: {
          overall: score.overall,
          preLayoutOverall: score.preLayoutOverall,
          layoutTriggers: [...score.layout.triggers],
          layoutMultiplier: score.layout.multiplier,
        },
        sectionOverview,
        achievementsPlacement: p.achievements_placement ?? null,
        entries,
        regionLines,
        headerLines,
        verdict,
        triggers: [...cascade.triggers],
      };

      mkdirSync(outDir, { recursive: true });
      const outFile = join(
        outDir,
        `achievements-${basename(path).replace(/\.[^.]+$/, "")}.json`,
      );
      writeFileSync(outFile, JSON.stringify(report, null, 2));

      console.log(
        `RL_ACHIEVEMENTS_PDF achievements probe for ${path}:\n` +
          `\n  Score: overall ${score.overall} (pre-layout ${score.preLayoutOverall}, ` +
          `layout ×${score.layout.multiplier} [${score.layout.triggers.join(", ") || "none"}])\n` +
          `\n  Sections detected: ${sectionOverview.join("  ")}\n` +
          `\n  Parsed achievements (${entries.length}):\n` +
          (entries.length
            ? entries
                .map(
                  (e, i) =>
                    `    ${i + 1}. type=${JSON.stringify(e.type)}` +
                    `${e.typeIsLabel ? "" : " (no type label — whole header renders bold)"}\n` +
                    `       description=${JSON.stringify(e.description)}\n` +
                    `       year=${e.year ?? "?"}  bullets=${e.bullets}`,
                )
                .join("\n")
            : "    (none)") +
          `\n\n  Achievements region scanned (${regionLines.length} lines, ` +
          `${headerLines.length} header-shaped):\n` +
          (regionLines.length
            ? regionLines.map((l) => `    | ${l}`).join("\n")
            : "    (empty — no achievements region segmented)") +
          `\n\n  Verify: ${verdict}` +
          `\n\n  Full JSON → ${outFile}  ⚠️ gitignored; may carry PII, do NOT commit.`,
      );

      // Informational only: never fails the suite.
      expect(true).toBe(true);
    });
  },
);
