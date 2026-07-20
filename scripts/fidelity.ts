// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Parser-fidelity diagnostic (`npm run fidelity <pdf|dir>`).
 *
 * Runs the REAL pipeline end-to-end — `runCascade` → `computeAnonymousAtsScore`
 * → the reconstruction's bullet grouping — and reports what the *reconstructed
 * résumé* would show, not just what the parser struct holds. The distinction
 * matters: bugs like #224 (achievements duplicated into the "Other bullets"
 * group) are invisible to a parser-struct dump because they live in the
 * reconstruction layer (`ReconstructedResume.buildEntryGroups`). This tool
 * mirrors that grouping so those leaks surface.
 *
 * Diagnostic only — no taxonomy classification, no fixture minting. It reads a
 * path you hand it and prints to the terminal; it writes nothing and hardcodes
 * no corpus path, so pointing it at real (PII) résumés is safe — the discovery
 * loop + synthetic-fixture minting live in the maintainer's untracked wrapper.
 *
 * Usage:
 *   npm run fidelity path/to/resume.pdf
 *   npm run fidelity path/to/dir            # every *.pdf under dir
 *   npm run fidelity path/to/resume.pdf --strict   # exit 1 if a duplication leak is found
 */

import { promises as fsp, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { runCascade } from "../src/lib/heuristics/cascade.ts";
import { computeAnonymousAtsScore } from "../src/lib/score/score.ts";
import {
  groupBulletsByExperience,
  suppressTitleOwnedBullets,
} from "../src/lib/score/group-bullets.ts";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const target = args.find((a) => !a.startsWith("--"));

if (!target) {
  console.error("usage: npm run fidelity <pdf|dir> [--strict]");
  process.exit(2);
}

function walkPdfs(p: string): string[] {
  const st = statSync(p);
  if (st.isFile()) return p.toLowerCase().endsWith(".pdf") ? [p] : [];
  const out: string[] = [];
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const child = join(p, e.name);
    if (e.isDirectory()) out.push(...walkPdfs(child));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) out.push(child);
  }
  return out.sort();
}

/** Normalize for overlap comparison: lowercase, collapse non-alphanumerics. */
const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Mirrors ReconstructedResume.toBulletExperience — keep in sync. */
type BulletExp = { title?: string; description?: string };
const toBulletExp = (
  es: ReadonlyArray<{ title?: string; name?: string; description?: string }>,
): BulletExp[] => es.map((e) => ({ title: e.title ?? e.name, description: e.description }));

interface Finding {
  leakCount: number;
  dupCount: number;
}

async function diagnose(pdfPath: string): Promise<Finding> {
  const bytes = await fsp.readFile(pdfPath);
  const c = await runCascade(new Uint8Array(bytes));
  const p = c.parsed;
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
    fieldConfidence: c.fieldConfidence,
    triggers: c.triggers,
    rawText: c.rawText,
    sections: c.sections,
  });

  const experiences = p.experience ?? [];
  const projects = p.projects ?? [];
  const achievements = p.heuristic_achievements ?? [];
  // Same combined index space + grouping the reconstruction uses.
  const combined: BulletExp[] = [
    ...experiences,
    ...toBulletExp(projects),
    ...toBulletExp(achievements),
  ];
  const grouped = groupBulletsByExperience([...(score.bullets ?? [])], combined);
  const other = grouped.find((g) => g.experienceIndex === null);
  // Mirror ReconstructedResume.buildEntryGroups: title-only entries' own source
  // lines are suppressed from "Other" so the diagnostic reflects what the
  // reconstruction actually renders (#224).
  const otherBullets = suppressTitleOwnedBullets(other?.bullets ?? [], combined);

  // Rendered entry headers — what each section visibly shows.
  const renderedTitles = [
    ...experiences.map((e) => e.title ?? ""),
    ...projects.map((e) => e.name ?? ""),
    ...achievements.map((e) => e.title ?? ""),
  ].filter(Boolean);

  // Duplication: an "Other bullet" whose text is contained in a rendered title
  // (or vice-versa) is content shown twice — the #224 class.
  const dups = otherBullets.filter((b) => {
    const nb = norm(b.text);
    return renderedTitles.some((t) => {
      const nt = norm(t);
      return nt.length > 0 && (nt.includes(nb) || nb.includes(nt));
    });
  });

  // Title-only entries (no description) can't attract their bullets via the
  // description-match → leak risk even when no dup is detected this run.
  const titleOnly = [
    ...projects.filter((e) => !e.description?.trim()).map((e) => `project: ${e.name}`),
    ...achievements.filter((e) => !e.description?.trim()).map((e) => `achievement: ${e.title}`),
  ];

  const line = (s = "") => console.log(s);
  line(`\n══════ ${pdfPath} ══════`);
  line(`fields: name=${!!p.full_name} email=${!!p.email} phone=${!!p.phone} loc=${!!p.location} linkedin=${!!p.linkedin_url} website=${!!p.website_url}`);
  line(`counts: exp=${experiences.length} edu=${(p.education ?? []).length} proj=${projects.length} ach=${achievements.length} skills=${p.skills?.length ?? 0}`);
  line(`bullets: pool=${score.bullets?.length ?? 0}  attributed=${(score.bullets?.length ?? 0) - otherBullets.length}  OTHER=${otherBullets.length}`);
  line(`score: ${score.overall}/100  triggers=[${c.triggers.join(",")}]`);

  if (otherBullets.length) {
    line(`\n  "Other bullets" (${otherBullets.length}) — bullets matched to NO entry:`);
    for (const b of otherBullets) {
      const isDup = dups.includes(b);
      line(`    ${isDup ? "⚠ DUP " : "      "}• ${b.text.slice(0, 120)}`);
    }
  }
  if (dups.length) {
    line(`\n  ⚠ DUPLICATION: ${dups.length} bullet(s) ALSO render under a section header (content shown twice — #224 class).`);
  }
  if (titleOnly.length) {
    line(`\n  ⚠ title-only entries (empty description → leak risk):`);
    for (const t of titleOnly) line(`      ${t.slice(0, 120)}`);
  }

  return { leakCount: otherBullets.length, dupCount: dups.length };
}

const pdfs = walkPdfs(target);
if (pdfs.length === 0) {
  console.error(`no PDFs found at ${target}`);
  process.exit(2);
}

let totalDup = 0;
for (const pdf of pdfs) {
  const f = await diagnose(pdf);
  totalDup += f.dupCount;
}

console.log(
  `\n────── ${pdfs.length} résumé(s) scanned · ${totalDup} duplication finding(s) ──────`,
);
if (strict && totalDup > 0) process.exit(1);
