// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Contact-section dev probe — inert in CI, runs ONLY when `RL_CONTACT_PDF=<path>`
 * is set:
 *
 *   RL_CONTACT_PDF=/abs/path/to/resume.pdf npx vitest run \
 *     src/lib/heuristics/probe-contact.test.ts
 *
 * Extracts + VERIFIES the contact section of one arbitrary PDF so a real
 * (uncommitted, possibly PII-bearing) résumé can be triaged WITHOUT being
 * committed as a fixture. This is the execution vehicle for the `probe-contact`
 * skill — sibling of `probe-roundtrip`;
 * the pattern is: run the real parser via runCascade (the pdfjs worker only
 * resolves under the vitest transform — no standalone script), then show the
 * section extractor's INPUT (the profile region it scanned) next to its OUTPUT
 * (the parsed contact fields) so a dropped field is localizable.
 *
 * ── PII guardrail (same rules as roundtrip-probe) ──
 * 1. The input PDF is local-only. NEVER commit it. `tests/fixtures/pdfs/` is
 *    synthetic-personas-only by policy.
 * 2. The console + JSON output prints contact field VALUES (email/phone/…) so
 *    the corruption is visible → scratch only. The full JSON goes to the
 *    gitignored `internal/` dir. Do not paste raw values into an issue/PR/Slack;
 *    cite the corruption by CATEGORY ("phone dropped though present in rawText").
 *
 * ── The "verify" pass ──
 * There is no ground truth for a real résumé, so verification is a second,
 * independent scan of the WHOLE rawText with the same contact regexes. For every
 * field the structured extractor left empty, we report whether a candidate for
 * it nonetheless exists in rawText. That split localizes the failure:
 *   - field empty AND no rawText candidate  → genuinely absent in the PDF
 *   - field empty BUT rawText candidate     → PARSER bug (regex saw it, section
 *                                              routing / region filter dropped it)
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import { CONTACT_FIELDS, localizeContact } from "./localize/contact.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe.runIf(process.env.RL_CONTACT_PDF)(
  "contact dev probe (RL_CONTACT_PDF)",
  () => {
    it("extracts + verifies the contact section for RL_CONTACT_PDF", async () => {
      const path = process.env.RL_CONTACT_PDF!;
      const outDir =
        process.env.RL_CONTACT_OUT ?? join(HERE, "../../..", "internal/contact");

      const cascade = await runCascade(new Uint8Array(readFileSync(path)));
      const { extracted, profileLines, verify } = localizeContact(cascade);

      const report = {
        path,
        extracted,
        profileLines,
        verify,
        annotations: cascade.linkAnnotations.length,
      };

      mkdirSync(outDir, { recursive: true });
      const outFile = join(
        outDir,
        `contact-${basename(path).replace(/\.[^.]+$/, "")}.json`,
      );
      writeFileSync(outFile, JSON.stringify(report, null, 2));

      console.log(
        `RL_CONTACT_PDF contact probe for ${path}:\n` +
          `\n  Extracted fields (value @ confidence):\n` +
          CONTACT_FIELDS.map(
            (k) =>
              `    ${k.padEnd(14)} ${JSON.stringify(
                extracted[k].value,
              )} @ ${extracted[k].confidence}`,
          ).join("\n") +
          `\n\n  Profile region scanned (${profileLines.length} lines):\n` +
          (profileLines.length
            ? profileLines.map((l) => `    | ${l}`).join("\n")
            : "    (empty — contact line did NOT segment into the profile band)") +
          `\n\n  Verify (independent rawText re-scan):\n` +
          verify
            .map(
              (v) =>
                `    ${v.field.padEnd(9)} ${v.verdict}` +
                (v.verdict.startsWith("PARSER")
                  ? `  [rawText has ${JSON.stringify(v.rawText_candidate)}]`
                  : ""),
            )
            .join("\n") +
          `\n\n  Full JSON → ${outFile}  ⚠️ gitignored; carries PII, do NOT commit.`,
      );

      // Informational only: never fails the suite.
      expect(true).toBe(true);
    });
  },
);
