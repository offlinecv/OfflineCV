// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Experience-section dev probe — inert in CI, runs ONLY when
 * `RL_EXPERIENCE_PDF=<path>` is set:
 *
 *   RL_EXPERIENCE_PDF=/abs/path/to/resume.pdf npx vitest run \
 *     src/lib/heuristics/probe-experience.test.ts
 *
 * Extracts + VERIFIES the experience section of one arbitrary PDF so a real
 * (uncommitted, possibly PII-bearing) résumé can be triaged WITHOUT being
 * committed as a fixture. This is the execution vehicle for the
 * `probe-experience` skill — sibling of `probe-contact` / `probe-roundtrip`;
 * the pattern is: run the real parser via runCascade (the pdfjs worker only
 * resolves under the vitest transform — no standalone script), then show the
 * section extractor's INPUT (the experience region it scanned) next to its
 * OUTPUT (the parsed role entries) so a dropped/merged role is localizable.
 *
 * ── PII guardrail (same rules as probe-contact) ──
 * 1. The input PDF is local-only. NEVER commit it. `tests/fixtures/pdfs/` is
 *    synthetic-personas-only by policy.
 * 2. The console + JSON output prints role field VALUES (titles/companies/…)
 *    so the corruption is visible → scratch only. The full JSON goes to the
 *    gitignored `internal/` dir. Do not paste raw values into an
 *    issue/PR/Slack; cite the corruption by CATEGORY ("second role's header
 *    demoted to a bullet under the first role").
 *
 * ── The "verify" pass ──
 * There is no ground truth for a real résumé, so verification is a second,
 * independent scan with the date-range regex. Date ranges are the strongest
 * role-header signal, so the count of distinct date-range lines inside the
 * experience region is a lower-bound oracle for how many roles SHOULD have
 * segmented. The split localizes the failure:
 *   - entries == 0 AND region has date-range lines → PARSER bug (roles are in
 *     the region; entry segmentation dropped them)
 *   - entries  <  date-range lines                → UNDER-SEGMENTED (a role
 *     was likely merged into its neighbor — #341/#239 failure class)
 *   - entries >=  date-range lines                → ok (dateless roles can
 *     legitimately exceed the oracle)
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import { DATE_RANGE_RE } from "./regex.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe.runIf(process.env.RL_EXPERIENCE_PDF)(
  "experience dev probe (RL_EXPERIENCE_PDF)",
  () => {
    it("extracts + verifies the experience section for RL_EXPERIENCE_PDF", async () => {
      const path = process.env.RL_EXPERIENCE_PDF!;
      const outDir =
        process.env.RL_EXPERIENCE_OUT ??
        join(HERE, "../../..", "internal/experience");

      const cascade = await runCascade(new Uint8Array(readFileSync(path)));
      const p = cascade.parsed;

      const score = computeAnonymousAtsScore({
        parsed: {
          full_name: p.full_name,
          email: p.email,
          phone: p.phone,
          location: p.location,
          linkedin_url: p.linkedin_url,
          summary: p.summary,
          skills: p.skills,
          experience: p.experience,
          education: p.education,
        },
        fieldConfidence: cascade.fieldConfidence,
        triggers: cascade.triggers,
        rawText: cascade.rawText,
        sections: cascade.sections,
      });

      // OUTPUT: the parsed role entries.
      const entries = (p.experience ?? []).map((e) => ({
        title: e.title || null,
        company: e.company || null,
        location: e.location ?? null,
        start_date: e.start_date ?? null,
        end_date: e.end_date ?? (e.is_current ? "Present" : null),
        bullets: e.description
          ? e.description.split("\n").filter((l) => l.trim()).length
          : 0,
      }));

      // INPUT: the experience region the entry segmenter scanned.
      const regionLines = [
        ...(cascade.sections.byName.get("experience") ?? []),
      ];

      // Section-detection overview (all regions, line counts only).
      const sectionOverview = [...cascade.sections.byName.entries()].map(
        ([name, lines]) => `${name}(${lines.length})`,
      );

      // VERIFY: date-range lines inside the region are a lower-bound oracle
      // for the role count. DATE_RANGE_RE is non-global; test per line.
      const dateRangeLines = regionLines.filter((l) => DATE_RANGE_RE.test(l));
      let verdict: string;
      if (entries.length === 0 && dateRangeLines.length > 0)
        verdict = `PARSER-MISS (0 entries; region has ${dateRangeLines.length} date-range lines)`;
      else if (entries.length < dateRangeLines.length)
        verdict = `UNDER-SEGMENTED (${entries.length} entries < ${dateRangeLines.length} date-range lines — a role likely merged into a neighbor)`;
      else verdict = "ok";

      const report = {
        path,
        score: {
          overall: score.overall,
          preLayoutOverall: score.preLayoutOverall,
          layoutTriggers: [...score.layout.triggers],
          layoutMultiplier: score.layout.multiplier,
        },
        sectionOverview,
        entries,
        regionLines,
        dateRangeLines,
        verdict,
        triggers: [...cascade.triggers],
      };

      mkdirSync(outDir, { recursive: true });
      const outFile = join(
        outDir,
        `experience-${basename(path).replace(/\.[^.]+$/, "")}.json`,
      );
      writeFileSync(outFile, JSON.stringify(report, null, 2));

      console.log(
        `RL_EXPERIENCE_PDF experience probe for ${path}:\n` +
          `\n  Score: overall ${score.overall} (pre-layout ${score.preLayoutOverall}, ` +
          `layout ×${score.layout.multiplier} [${score.layout.triggers.join(", ") || "none"}])\n` +
          `\n  Sections detected: ${sectionOverview.join("  ")}\n` +
          `\n  Parsed experience entries (${entries.length}):\n` +
          (entries.length
            ? entries
                .map(
                  (e, i) =>
                    `    ${i + 1}. ${JSON.stringify(e.title)} @ ${JSON.stringify(
                      e.company,
                    )}  ${e.start_date ?? "?"} – ${e.end_date ?? "?"}  ` +
                    `loc=${JSON.stringify(e.location)}  bullets=${e.bullets}`,
                )
                .join("\n")
            : "    (none)") +
          `\n\n  Experience region scanned (${regionLines.length} lines, ` +
          `${dateRangeLines.length} with date ranges):\n` +
          (regionLines.length
            ? regionLines.map((l) => `    | ${l}`).join("\n")
            : "    (empty — no experience region segmented)") +
          `\n\n  Verify: ${verdict}` +
          `\n\n  Full JSON → ${outFile}  ⚠️ gitignored; may carry PII, do NOT commit.`,
      );

      // Informational only: never fails the suite.
      expect(true).toBe(true);
    });
  },
);
