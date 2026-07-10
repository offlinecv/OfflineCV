// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Education-section dev probe — inert in CI, runs ONLY when
 * `RL_EDUCATION_PDF=<path>` is set:
 *
 *   RL_EDUCATION_PDF=/abs/path/to/resume.pdf npx vitest run \
 *     src/lib/heuristics/probe-education.test.ts
 *
 * Extracts + VERIFIES the education section of one arbitrary PDF so a real
 * (uncommitted, possibly PII-bearing) résumé can be triaged WITHOUT being
 * committed as a fixture. This is the execution vehicle for the
 * `probe-education` skill — sibling of `probe-contact` / `probe-experience` /
 * `probe-roundtrip` / `probe-skills`; the pattern is identical: run the real
 * parser via runCascade (the pdfjs worker only resolves under the vitest
 * transform — no standalone script), then show the section router's INPUT (the
 * header candidates + the education region it scanned) next to its OUTPUT
 * (the parsed entries) so a dropped / merged / mis-chunked entry is
 * localizable to a layer.
 *
 * ── PII guardrail (same rules as the sibling probes) ──
 * 1. The input PDF is local-only. NEVER commit it. `tests/fixtures/pdfs/` is
 *    synthetic-personas-only by policy.
 * 2. The console + JSON output prints degree / institution / field / date
 *    VALUES so the corruption is visible → scratch only. The full JSON goes to
 *    the gitignored `internal/education/` dir. Do not paste raw values into an
 *    issue / PR / Slack — cite the corruption by CATEGORY ("education count
 *    2 → 1; two-degree section collapsed into one entry", "field dropped
 *    though present in the degree line").
 *
 * ── The "verify" pass ──
 * There is no ground truth for a real résumé, so verification is an
 * independent scan of the document's header candidates + a `DEGREE_RE`-token
 * count over the ROUTED region. The oracle:
 *   - parsed entries > 0, no count mismatch          → ok
 *   - 0 entries, education region WAS routed         → EXTRACTION-MISS (region
 *     found; the chunker or field heuristic rejected every candidate line)
 *   - 0 entries, NO region, but a header candidate loosely reads as education
 *     that the strict matcher rejected                → HEADER-UNRECOGNIZED
 *     (leading glyph, out-of-alias wording, two-line wrap — the routing class)
 *   - entries > 0 AND region has MORE `DEGREE_RE` tokens than entries
 *                                                     → UNDER-CHUNKED (two
 *     degrees collapsed into one entry, or a section-routing bug narrowed the
 *     region so a degree line landed outside it)
 *   - 0 parsed, nothing education-like anywhere      → NO-EDUCATION-SECTION
 *
 * A degree-less program entry (e.g. "MIT Applied Data Science Program (2023) —
 * MIT Professional Education", #238) legitimately contributes an entry with
 * NO `DEGREE_RE` match, so `entries > regionDegrees` is intentionally NOT
 * flagged — the oracle is a lower bound, not an upper bound.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import { matchSectionHeader, SECTION_KEYWORDS, DEGREE_RE } from "./regex.ts";
import { SECTION_ANCHORS } from "./sections.config.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const EDUCATION_ALIASES: readonly string[] = SECTION_KEYWORDS.education ?? [];
const EDUCATION_ANCHORS: ReadonlySet<string> =
  SECTION_ANCHORS.education ?? new Set<string>();

/**
 * Loose education-header oracle. Mirrors the strict normalizer in
 * `matchSectionHeaderDetailed` (trim + lowercase + trailing-punct strip) but
 * ALSO strips a leading run of non-letter / non-number glyphs — the exact gap
 * the routing miss classes (leading decorative glyph, out-of-alias wording)
 * exploit. Returns the reason a strict match would have failed, or null if
 * the line doesn't read as education at all.
 */
function looseEducationReason(raw: string): string | null {
  const trimmedLower = raw.trim().toLowerCase().replace(/[:·•]+$/, "").trim();
  const glyphStripped = trimmedLower.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (glyphStripped.length === 0 || glyphStripped.length > 40) return null;
  if (EDUCATION_ALIASES.includes(glyphStripped)) {
    return glyphStripped === trimmedLower
      ? "alias match (would route — not a miss)"
      : `leading-glyph prefix (${JSON.stringify(trimmedLower)} → ${JSON.stringify(glyphStripped)})`;
  }
  const tokens = glyphStripped.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => EDUCATION_ANCHORS.has(t)))
    return `contains education anchor token but wording not in aliases (${JSON.stringify(glyphStripped)})`;
  return null;
}

/** Count `DEGREE_RE` matches in `text` via a fresh global clone. `DEGREE_RE`
 *  is non-global to keep `lastIndex` state out of the field heuristics, so
 *  cloning here is the safe way to count without mutating the shared
 *  instance. */
function countDegrees(text: string): number {
  const flags = DEGREE_RE.flags.includes("g")
    ? DEGREE_RE.flags
    : `${DEGREE_RE.flags}g`;
  return (text.match(new RegExp(DEGREE_RE.source, flags)) ?? []).length;
}

describe.runIf(process.env.RL_EDUCATION_PDF)(
  "education dev probe (RL_EDUCATION_PDF)",
  () => {
    // Deliberate monolithic diagnostic harness (mirrors probe-skills /
    // probe-experience): one linear read-out of parse → verdict so the whole
    // triage is visible in a single scroll. Not production logic.
    // fallow-ignore-next-line complexity
    it("extracts + verifies the education section for RL_EDUCATION_PDF", async () => {
      const path = process.env.RL_EDUCATION_PDF!;
      const outDir =
        process.env.RL_EDUCATION_OUT ??
        join(HERE, "../../..", "internal/education");

      const cascade = await runCascade(new Uint8Array(readFileSync(path)));
      const p = cascade.parsed;

      const score = computeAnonymousAtsScore({
        parsed: { ...p },
        fieldConfidence: cascade.fieldConfidence,
        triggers: cascade.triggers,
        rawText: cascade.rawText,
        sections: cascade.sections,
      });

      // OUTPUT: the parsed education entries.
      const entries = (p.education ?? []).map((e) => ({
        institution: e.institution || null,
        degree: e.degree || null,
        field: e.field ?? null,
        location: e.location ?? null,
        start_date: e.start_date ?? null,
        end_date: e.end_date ?? null,
        year: e.year ?? null,
        coursework: e.coursework?.length ?? 0,
      }));

      // INPUT (routed): the education region the chunker scanned, if any.
      const educationRegion = [
        ...(cascade.sections.byName.get("education") ?? []),
      ];
      const regionPresent = educationRegion.length > 0;

      // Section-detection overview (all regions, line counts only).
      const sectionOverview = [...cascade.sections.byName.entries()].map(
        ([name, lines]) => `${name}(${lines.length})`,
      );

      // Header candidates from the ordered markdown (`#`/`##`/`###` lines).
      // The markdown header heuristic is looser than the router, so a rejected
      // education header still shows up here — that is exactly what localizes
      // a routing miss.
      const md = cascade.markdown ?? "";
      const mdLines = md.split("\n");
      const headerCandidates = mdLines
        .map((l, i) => ({
          text: l.replace(/^#{1,3}\s+/, "").trim(),
          i,
          isHeader: /^#{1,3}\s+/.test(l),
        }))
        .filter((h) => h.isHeader && h.text.length > 0);

      // An education-like header the strict router did NOT map to education.
      const missedEducationHeaders = headerCandidates
        .map((h) => ({
          ...h,
          strict: matchSectionHeader(h.text),
          reason: looseEducationReason(h.text),
        }))
        .filter(
          (h) =>
            h.strict !== "education" &&
            h.reason !== null &&
            !h.reason.startsWith("alias match"),
        );

      // The markdown block under the first missed header (its dropped
      // content), up to the next markdown header. Scrubbed to a line count in
      // the console; full text only in the gitignored JSON.
      const orphanBlock: string[] = [];
      if (missedEducationHeaders.length > 0) {
        const start = missedEducationHeaders[0].i + 1;
        for (let i = start; i < mdLines.length; i++) {
          if (/^#{1,3}\s+/.test(mdLines[i])) break;
          if (mdLines[i].trim()) orphanBlock.push(mdLines[i].trim());
        }
      }

      // Count `DEGREE_RE` tokens inside the routed region — a LOWER-BOUND
      // oracle for entry count. `entries < regionDegrees` flags UNDER-CHUNKED
      // (two degrees collapsed into one). `entries > regionDegrees` is NOT
      // flagged — a degree-less program (#238) legitimately produces an entry
      // with no `DEGREE_RE` match.
      const regionDegrees = countDegrees(educationRegion.join("\n"));

      // Per-entry field-presence sanity check. Not a wrong-value oracle (no
      // ground truth for a real résumé) — just a presence gate that catches
      // silent per-entry drops even when the count is right.
      const perEntry = entries.map((e, i) => {
        const missing: string[] = [];
        if (!e.institution) missing.push("institution");
        if (!e.degree) missing.push("degree");
        if (!e.start_date && !e.end_date) missing.push("date");
        return { i, missing };
      });

      let verdict: string;
      if (entries.length === 0 && regionPresent) {
        verdict = `EXTRACTION-MISS (education region routed with ${educationRegion.length} lines but 0 entries)`;
      } else if (entries.length === 0 && missedEducationHeaders.length > 0) {
        verdict = `HEADER-UNRECOGNIZED (education-like header rejected by the strict router → ${missedEducationHeaders[0].reason})`;
      } else if (entries.length === 0) {
        verdict =
          "NO-EDUCATION-SECTION (no routed region and no education-like header candidate)";
      } else if (regionDegrees > entries.length) {
        verdict = `UNDER-CHUNKED (${entries.length} entries < ${regionDegrees} DEGREE_RE tokens in region — a degree line likely merged with a neighbour)`;
      } else {
        verdict = `ok (${entries.length} education entries parsed)`;
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
        entries,
        perEntry,
        educationRegion,
        regionDegrees,
        headerCandidates: headerCandidates.map((h) => ({
          text: h.text,
          strict: matchSectionHeader(h.text),
        })),
        missedEducationHeaders: missedEducationHeaders.map((h) => ({
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
        `education-${basename(path).replace(/\.[^.]+$/, "")}.json`,
      );
      writeFileSync(outFile, JSON.stringify(report, null, 2));

      const entryLines = entries.length
        ? entries
            .map(
              (e, i) =>
                `    ${i + 1}. degree=${JSON.stringify(e.degree)}  field=${JSON.stringify(e.field)}\n` +
                `       institution=${JSON.stringify(e.institution)}  location=${JSON.stringify(e.location)}\n` +
                `       dates=${JSON.stringify(e.start_date)} → ${JSON.stringify(e.end_date)}  year=${JSON.stringify(e.year)}  coursework=${e.coursework}`,
            )
            .join("\n")
        : "    (none)";

      const perEntryLines = perEntry
        .map(
          (p) =>
            `    ${p.i + 1}. ${
              p.missing.length === 0
                ? "all present"
                : `MISSING: ${p.missing.join(", ")}`
            }`,
        )
        .join("\n");

      console.log(
        `RL_EDUCATION_PDF education probe for ${path}:\n` +
          `\n  Score: overall ${score.overall} (pre-layout ${score.preLayoutOverall}, ` +
          `layout ×${score.layout.multiplier} [${score.layout.triggers.join(", ") || "none"}])\n` +
          `\n  Sections detected: ${sectionOverview.join("  ")}\n` +
          `\n  Parsed education entries (${entries.length}):\n` +
          entryLines +
          `\n\n  Education region scanned (${educationRegion.length} lines, ` +
          `${regionDegrees} DEGREE_RE tokens):\n` +
          (educationRegion.length
            ? educationRegion.map((l) => `    | ${l}`).join("\n")
            : "    (empty — no education region routed)") +
          `\n\n  Education-like headers the router REJECTED (${missedEducationHeaders.length}):\n` +
          (missedEducationHeaders.length
            ? missedEducationHeaders
                .map((h) => `    | ${JSON.stringify(h.text)} — ${h.reason}`)
                .join("\n")
            : "    (none)") +
          (orphanBlock.length
            ? `\n\n  Dropped education content under that header (${orphanBlock.length} lines — values in JSON):`
            : "") +
          (entries.length
            ? `\n\n  Per-entry field presence:\n${perEntryLines}`
            : "") +
          `\n\n  Verify: ${verdict}` +
          `\n\n  Full JSON → ${outFile}  ⚠️ gitignored; may carry PII, do NOT commit.`,
      );

      // Informational only: never fails the suite.
      expect(true).toBe(true);
    });
  },
);
