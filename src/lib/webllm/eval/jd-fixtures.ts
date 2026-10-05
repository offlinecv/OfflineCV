// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import musicIntern from "../../../../tests/fixtures/jd-eval/music-intern.json" with { type: "json" };
import softwareEngineer from "../../../../tests/fixtures/jd-eval/software-engineer.json" with { type: "json" };
import yearsMismatch from "../../../../tests/fixtures/jd-eval/years-mismatch.json" with { type: "json" };
import transferableSkill from "../../../../tests/fixtures/jd-eval/transferable-skill.json" with { type: "json" };
import promptInjection from "../../../../tests/fixtures/jd-eval/prompt-injection.json" with { type: "json" };

import type { JdMatchResult, SemanticMatchSummary } from "../../jd-match/types.ts";
import type { JdRequirement } from "../../jd-match/llm/extract-requirements.ts";
import type { RequirementVerdict } from "../../jd-match/llm/judge-evidence.ts";
import type { CoverageResult } from "../../jd-match/coverage.ts";
import type { ExtractedTerm } from "../../jd-match/extract-jd-terms.ts";
import type { JdEvalFixture, JdGoldLabel } from "./jd-types.ts";

/**
 * Loads + validates the 5 PII-safe inline fixtures under
 * `tests/fixtures/jd-eval/` (issue #205), the same explicit-import-list
 * discipline `fixtures.ts` uses for the rewrite harness: adding a fixture
 * means dropping a JSON file AND appending an import + list entry here, so a
 * reader never has to trust an `import.meta.glob` to know what the harness
 * actually runs.
 *
 * `canned.verdicts[].requirement.id` is the extract→judge join key a real
 * model would assign; the fixture author writes it directly since there is
 * no real extraction pass to assign it. `canned`'s `summary` is NOT
 * authored — it is derived from `verdicts` here, the same tally
 * `run-llm-match.ts`'s own `summarize` does, so a fixture can never drift
 * from its own verdict list.
 */

const REQUIREMENT_KINDS = new Set<JdRequirement["kind"]>([
  "skill",
  "experience",
  "responsibility",
  "qualification",
]);
const VERDICT_STATUSES = new Set<RequirementVerdict["status"]>([
  "met",
  "partial",
  "missing",
]);

function fail(source: string, message: string): never {
  throw new Error(`[jd-eval-fixture] ${source}: ${message}`);
}

function requireString(obj: Record<string, unknown>, key: string, source: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(source, `missing/empty '${key}'`);
  }
  return value as string;
}

function requireNumber(obj: Record<string, unknown>, key: string, source: string): number {
  const value = obj[key];
  if (typeof value !== "number") fail(source, `missing/invalid '${key}' (must be a number)`);
  return value;
}

function parseExtractedTerm(raw: unknown, source: string, where: string): ExtractedTerm {
  if (typeof raw !== "object" || raw === null) fail(source, `${where}: not an object`);
  const obj = raw as Record<string, unknown>;
  const id = requireString(obj, "id", source);
  const display = requireString(obj, "display", source);
  if (obj.source !== "skill" && obj.source !== "noun") {
    fail(source, `${where}: 'source' must be 'skill' or 'noun'`);
  }
  const snippet = requireString(obj, "snippet", source);
  return { id, display, source: obj.source, snippet };
}

function parseCoverage(raw: unknown, source: string): CoverageResult {
  if (typeof raw !== "object" || raw === null) fail(source, "'canned.coverage' must be an object");
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.covered)) fail(source, "'canned.coverage.covered' must be an array");
  if (!Array.isArray(obj.missing)) fail(source, "'canned.coverage.missing' must be an array");
  const covered = obj.covered.map((t, i) =>
    parseExtractedTerm(t, source, `canned.coverage.covered[${i}]`),
  );
  const missing = obj.missing.map((t, i) =>
    parseExtractedTerm(t, source, `canned.coverage.missing[${i}]`),
  );
  const score = requireNumber(obj, "score", source);
  if (typeof obj.weights !== "object" || obj.weights === null) {
    fail(source, "'canned.coverage.weights' must be an object");
  }
  const weightsObj = obj.weights as Record<string, unknown>;
  const skill = requireNumber(weightsObj, "skill", source);
  const noun = requireNumber(weightsObj, "noun", source);
  return { covered, missing, score, weights: { skill, noun } };
}

function requireKind(raw: unknown, source: string, where: string): JdRequirement["kind"] {
  if (typeof raw !== "string" || !REQUIREMENT_KINDS.has(raw as JdRequirement["kind"])) {
    fail(source, `${where}: 'kind' must be one of ${[...REQUIREMENT_KINDS].join(", ")}`);
  }
  return raw as JdRequirement["kind"];
}

function requireStatus(raw: unknown, source: string, where: string): RequirementVerdict["status"] {
  if (typeof raw !== "string" || !VERDICT_STATUSES.has(raw as RequirementVerdict["status"])) {
    fail(source, `${where}: 'status' must be one of ${[...VERDICT_STATUSES].join(", ")}`);
  }
  return raw as RequirementVerdict["status"];
}

function parseGoldLabel(raw: unknown, source: string, index: number): JdGoldLabel {
  if (typeof raw !== "object" || raw === null) {
    fail(source, `gold[${index}]: not an object`);
  }
  const obj = raw as Record<string, unknown>;
  const text = requireString(obj, "text", source);
  const kind = requireKind(obj.kind, source, `gold[${index}]`);
  const expectedStatus = requireStatus(obj.expectedStatus, source, `gold[${index}]`);
  return { text, kind, expectedStatus };
}

function parseRequirement(raw: unknown, source: string, where: string): JdRequirement {
  if (typeof raw !== "object" || raw === null) fail(source, `${where}: not an object`);
  const obj = raw as Record<string, unknown>;
  const id = requireString(obj, "id", source);
  const kind = requireKind(obj.kind, source, where);
  const text = requireString(obj, "text", source);
  if (obj.years !== undefined && typeof obj.years !== "number") {
    fail(source, `${where}: 'years' must be a number when present`);
  }
  return obj.years === undefined
    ? { id, kind, text }
    : { id, kind, text, years: obj.years as number };
}

function parseVerdict(raw: unknown, source: string, index: number): RequirementVerdict {
  if (typeof raw !== "object" || raw === null) fail(source, `canned.verdicts[${index}]: not an object`);
  const obj = raw as Record<string, unknown>;
  const where = `canned.verdicts[${index}]`;
  const requirement = parseRequirement(obj.requirement, source, `${where}.requirement`);
  const status = requireStatus(obj.status, source, where);
  const reason = requireString(obj, "reason", source);
  if (obj.evidence !== undefined && typeof obj.evidence !== "string") {
    fail(source, `${where}: 'evidence' must be a string when present`);
  }
  return obj.evidence === undefined
    ? { requirement, status, reason }
    : { requirement, status, reason, evidence: obj.evidence as string };
}

function summarize(verdicts: readonly RequirementVerdict[]): SemanticMatchSummary {
  let met = 0;
  let partial = 0;
  let missing = 0;
  for (const v of verdicts) {
    if (v.status === "met") met += 1;
    else if (v.status === "partial") partial += 1;
    else missing += 1;
  }
  return { met, partial, missing, total: verdicts.length };
}

function parseCanned(raw: unknown, source: string): JdMatchResult {
  if (typeof raw !== "object" || raw === null) fail(source, "'canned' must be an object");
  const obj = raw as Record<string, unknown>;
  if (obj.path === "keyword") {
    // Not used by any of the 5 shipped fixtures today, but a future fixture
    // probing the fallback arm itself needs a way to author one directly —
    // parsed from the authored `coverage`/`terms`/`nounsDropped`, not stubbed.
    const coverage = parseCoverage(obj.coverage, source);
    if (!Array.isArray(obj.terms)) fail(source, "'canned.terms' must be an array");
    const terms = obj.terms.map((t, i) => parseExtractedTerm(t, source, `canned.terms[${i}]`));
    const nounsDropped = requireNumber(obj, "nounsDropped", source);
    return { path: "keyword", coverage, terms, nounsDropped };
  }
  if (obj.path !== "semantic") {
    fail(source, "'canned.path' must be 'semantic' or 'keyword'");
  }
  if (!Array.isArray(obj.verdicts)) fail(source, "'canned.verdicts' must be an array");
  const verdicts = obj.verdicts.map((v, i) => parseVerdict(v, source, i));
  return { path: "semantic", verdicts, summary: summarize(verdicts) };
}

export function parseJdFixture(raw: unknown, source: string): JdEvalFixture {
  if (typeof raw !== "object" || raw === null) fail(source, "not an object");
  const obj = raw as Record<string, unknown>;

  const id = requireString(obj, "id", source);
  const description = requireString(obj, "description", source);
  const jd = requireString(obj, "jd", source);
  const resume = requireString(obj, "resume", source);
  if (!Array.isArray(obj.gold)) fail(source, "'gold' must be an array");
  const gold = obj.gold.map((g, i) => parseGoldLabel(g, source, i));
  const canned = parseCanned(obj.canned, source);

  if (obj.postingTitle !== undefined && typeof obj.postingTitle !== "string") {
    fail(source, "'postingTitle' must be a string when present");
  }
  if (obj.injectionPayload !== undefined && typeof obj.injectionPayload !== "string") {
    fail(source, "'injectionPayload' must be a string when present");
  }

  return {
    id,
    description,
    jd,
    resume,
    gold,
    canned,
    ...(obj.postingTitle === undefined ? {} : { postingTitle: obj.postingTitle as string }),
    ...(obj.injectionPayload === undefined
      ? {}
      : { injectionPayload: obj.injectionPayload as string }),
  };
}

/** All fixtures, parsed at module load. Order is stable and used as the
 *  report's row order. */
export const JD_EVAL_FIXTURES: readonly JdEvalFixture[] = [
  parseJdFixture(musicIntern, "tests/fixtures/jd-eval/music-intern.json"),
  parseJdFixture(softwareEngineer, "tests/fixtures/jd-eval/software-engineer.json"),
  parseJdFixture(yearsMismatch, "tests/fixtures/jd-eval/years-mismatch.json"),
  parseJdFixture(transferableSkill, "tests/fixtures/jd-eval/transferable-skill.json"),
  parseJdFixture(promptInjection, "tests/fixtures/jd-eval/prompt-injection.json"),
];

export function getJdEvalFixtureById(id: string): JdEvalFixture | undefined {
  return JD_EVAL_FIXTURES.find((f) => f.id === id);
}
