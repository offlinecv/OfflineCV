// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The fixture-derivation tool (`npm run fixture-derive`, issue #39).
 *
 * Closes the loop the six read-only probes + the #469 corpus-match engine opened:
 * a REAL résumé exposes a parse defect → does a synthetic fixture already
 * reproduce it? → if not, mint one → PROVE the equivalence and record it in the
 * ledger. Two modes over ONE parse+sweep engine:
 *
 *   --match  (no --fixture): "does a fixture already cover this?" Parse the real
 *            résumé, sweep it, and for each requested class run `matchCorpus` over
 *            the baked corpus. COVERED ⇒ STOP and exit NON-ZERO naming the
 *            fixture — refusing to mint a duplicate is the whole point.
 *
 *   verify+write (--fixture ...): re-parse BOTH the real résumé and the candidate
 *            fixture live, and assert `defectSpec(class).exhibits(fixtureArtifact,
 *            fixtureDerived)`. A fixture that parses CORRECTLY while the real one
 *            fails is worse than no fixture, so a false verdict is a loud FAIL
 *            that writes NOTHING. On PASS: append a PII-free row to
 *            `internal/fixtures/registry.jsonl`, record the handle→path map in the
 *            gitignored `sources.local.json`, and print a repro-test scaffold.
 *
 * PII DISCIPLINE (the point of the whole issue): the committed row carries only
 * an opaque `handle`, a `sha256`, and two `ReproArtifact`s (PII-free BY TYPE —
 * numbers/booleans/enums, no free-form string). NEVER a path, filename, or name.
 * The real path lives ONLY in the gitignored `sources.local.json`. Nothing here
 * prints or persists a résumé field VALUE.
 *
 * Runs under vite-node (`runCascade` needs no pdfjs `?url` setup here). The
 * round-trip hop's Poppins font fetch fails under vite-node and falls back to
 * Helvetica with a stderr warning — expected and harmless; the render succeeds.
 *
 * Usage:
 *   npm run fixture-derive -- --real "<abs path>" [--probe <id> | --class <C>]
 *   npm run fixture-derive -- --real "<abs>" --fixture <repo-rel.pdf> \
 *     --issue <N> --class <C> --probe <P> [--handle src-NN] \
 *     [--generator word|latex|google-docs|unknown] [--provenance "..."] \
 *     [--derivation "..."]
 */

import { promises as fsp, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";

import { runCascade } from "../src/lib/heuristics/cascade.ts";
import type { CascadeResult } from "../src/lib/heuristics/types.ts";
import { runRoundtripHop } from "../src/lib/heuristics/roundtrip-hop.ts";
import {
  sweepParse,
  isParseUnreadable,
  type ResumeSweep,
} from "../src/lib/heuristics/sweep.ts";
import {
  buildReproArtifact,
  type ReproArtifact,
} from "../src/lib/heuristics/repro-artifact.ts";
import {
  DEFECT_CLASSES,
  PROBE_IDS,
  defectSpec,
  defectClassesForProbe,
  isAdvisory,
  type DefectClass,
  type ProbeId,
  type AxisPath,
} from "../src/lib/heuristics/defect-classes.ts";
import { matchCorpus, divergedAxes } from "../src/lib/heuristics/fixture-match.ts";
import {
  loadCorpus,
  REPO_ROOT,
} from "../src/lib/heuristics/__test-utils__/corpus-snapshots.ts";

const GENERATORS = ["word", "latex", "google-docs", "unknown"] as const;
type Generator = (typeof GENERATORS)[number];

const REGISTRY_PATH = join(REPO_ROOT, "internal/fixtures/registry.jsonl");
const SOURCES_PATH = join(REPO_ROOT, "internal/fixtures/sources.local.json");

// ── arg parsing ──────────────────────────────────────────────────────────────

/** `--key value` pairs; bare `--flag` becomes `"true"`. */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function die(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}

/** pdfjs (pulled in by `runCascade`) needs `Promise.withResolvers`, which lands
 *  in Node 22. The repo's `.nvmrc` pins Node 20, where it is absent — so without
 *  this guard a maintainer on the pinned version gets an opaque
 *  `Promise.withResolvers is not a function` from deep inside pdfjs. Fail fast
 *  with the fix instead. */
function requireNode22(): void {
  if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== "function") {
    die(
      `fixture-derive needs Node 22+ (pdfjs uses Promise.withResolvers); ` +
        `running Node ${process.version}. Run under Node 22, e.g. \`nvm use 22\`.`,
      1,
    );
  }
}

function asDefectClass(v: string): DefectClass {
  if (!(DEFECT_CLASSES as readonly string[]).includes(v)) {
    die(`unknown --class "${v}". One of:\n  ${DEFECT_CLASSES.join("\n  ")}`);
  }
  return v as DefectClass;
}

function asProbe(v: string): ProbeId {
  if (!(PROBE_IDS as readonly string[]).includes(v)) {
    die(`unknown --probe "${v}". One of: ${PROBE_IDS.join(", ")}`);
  }
  return v as ProbeId;
}

// ── shared engine ────────────────────────────────────────────────────────────

interface Analysis {
  cascade: CascadeResult;
  sweep: ResumeSweep;
  artifact: ReproArtifact;
}

/** Parse → round-trip hop → sweep → repro artifact. The one place a PDF becomes
 *  a (sweep, artifact) pair, so both modes read a résumé and a fixture the SAME
 *  way `corpus.test.ts`'s bake does. */
async function analyze(pdfPath: string): Promise<Analysis> {
  const bytes = await fsp.readFile(pdfPath);
  const cascade = await runCascade(new Uint8Array(bytes));
  const hop = await runRoundtripHop(cascade);
  const sweep = sweepParse(cascade, hop);
  const artifact = buildReproArtifact(cascade);
  return { cascade, sweep, artifact };
}

function bailIfUnreadable(a: Analysis, label: string): void {
  if (isParseUnreadable(a.sweep.derived, a.artifact.extractedCharCount)) {
    die(
      `⛔ ${label} parse is UNREADABLE (scanned or zero extracted characters). ` +
        `No defect claim over this parse can be trusted; fix extraction first.`,
      2,
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── --match mode ─────────────────────────────────────────────────────────────

/**
 * Which classes to ask the corpus about:
 *   --class C  → exactly C.
 *   --probe P  → P's classes the résumé EXHIBITS and that are non-advisory.
 *   neither    → ALL exhibited non-advisory classes (the sweep's `defects`,
 *                which already excludes withheld).
 */
function requestedClasses(
  sweep: ResumeSweep,
  cls: DefectClass | undefined,
  probe: ProbeId | undefined,
): DefectClass[] {
  if (cls) return [cls];
  const exhibited = new Set(sweep.defects.filter((c) => !isAdvisory(c)));
  if (probe) {
    return defectClassesForProbe(probe).filter((c) => exhibited.has(c));
  }
  return [...exhibited];
}

async function runMatch(args: Record<string, string>): Promise<never> {
  const real = args.real;
  if (!real) die("--match mode requires --real <abs path to real résumé pdf>");
  if (!isAbsolute(real)) die(`--real must be an ABSOLUTE path (got "${real}")`);
  if (!existsSync(real)) die(`--real not found: ${real}`);

  const cls = args.class ? asDefectClass(args.class) : undefined;
  const probe = args.probe ? asProbe(args.probe) : undefined;

  const analysis = await analyze(real);
  bailIfUnreadable(analysis, "real résumé");

  const requested = requestedClasses(analysis.sweep, cls, probe);
  console.log(
    `\nreal résumé exhibits (non-advisory): ` +
      `${analysis.sweep.defects.filter((c) => !isAdvisory(c)).join(", ") || "(none)"}`,
  );
  if (analysis.sweep.withheld.length > 0) {
    console.log(`withheld (oracle unavailable): ${analysis.sweep.withheld.join(", ")}`);
  }

  // An explicit --class the real résumé does NOT itself exhibit: the corpus can
  // still be asked "does a fixture cover it?", but a resulting "safe to mint"
  // would be misleading — you'd mint a fixture for a defect this résumé never
  // exposed, undercutting the derived-from-a-real-defect premise. Warn loudly.
  if (cls && !new Set(analysis.sweep.defects.filter((c) => !isAdvisory(c))).has(cls)) {
    console.warn(
      `\n⚠️  --class ${cls} is NOT exhibited by this real résumé ` +
        `(it exhibits: ${analysis.sweep.defects.filter((c) => !isAdvisory(c)).join(", ") || "none"}).\n` +
        `    Any "safe to mint" below is an OVERRIDE, not evidence this résumé exposes ${cls}.`,
    );
  }

  if (requested.length === 0) {
    console.log(
      `\nNo non-advisory defect class to match against the corpus. Nothing to do.`,
    );
    process.exit(0);
  }

  const corpus = loadCorpus();
  const coverage = matchCorpus(
    analysis.artifact,
    analysis.sweep.derived,
    requested,
    corpus,
  );

  console.log(`\n══════ corpus coverage (${corpus.length} fixtures) ══════`);
  const coveredClasses: DefectClass[] = [];
  for (const c of coverage) {
    if (c.coveredBy.length > 0) {
      coveredClasses.push(c.class);
      console.log(`\n  ✔ COVERED — ${c.class}`);
      console.log(`      by: ${c.coveredBy.join("\n          ")}`);
    } else {
      console.log(`\n  ✘ NO FIXTURE COVERS THIS — ${c.class}`);
      console.log(
        `      (${c.nearMisses.length} of ${c.nearMissCandidateCount} near-misses)`,
      );
      for (const nm of c.nearMisses) {
        const axes = nm.divergedAxes.length ? nm.divergedAxes.join(", ") : "(none)";
        console.log(`        · ${nm.fixture}\n            diverged: ${axes}`);
      }
    }
  }

  if (coveredClasses.length > 0) {
    console.error(
      `\n⛔ ${coveredClasses.length} requested class(es) already COVERED — ` +
        `do NOT mint a duplicate. Go fix the parser against the fixture(s) above.\n` +
        `   ${coveredClasses.join(", ")}`,
    );
    process.exit(1);
  }

  console.log(
    `\n✔ No requested class is covered — an uncovered class is the only thing ` +
      `that justifies minting a new synthetic fixture.`,
  );
  process.exit(0);
}

// ── verify + write mode ──────────────────────────────────────────────────────

interface RegistryRow {
  id: string;
  source: {
    handle: string;
    sha256: string;
    generator: Generator;
    provenance: string;
  };
  fixture: string;
  derivation: string;
  defects: {
    issue: number;
    class: DefectClass;
    probe: ProbeId;
    regressionTest: string;
    status: "open" | "fixed";
  }[];
  signature: {
    real: ReproArtifact;
    fixture: ReproArtifact;
    matchedAxes: AxisPath[];
  };
  verifiedRepro: string;
}

function nextLedgerId(): string {
  let max = 0;
  if (existsSync(REGISTRY_PATH)) {
    for (const line of readFileSync(REGISTRY_PATH, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const m = /"id"\s*:\s*"rl-(\d+)"/.exec(t);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return `rl-${String(max + 1).padStart(4, "0")}`;
}

async function mergeSources(
  handle: string,
  stem: string,
  realPath: string,
): Promise<void> {
  interface SourcesFile {
    _comment?: unknown;
    sources: Record<string, { stem: string; path: string | null }>;
  }
  let file: SourcesFile = { sources: {} };
  if (existsSync(SOURCES_PATH)) {
    file = JSON.parse(readFileSync(SOURCES_PATH, "utf8")) as SourcesFile;
    if (!file.sources) file.sources = {};
  }
  // Preserve an existing stem if present (it may be the pre-ledger filename);
  // otherwise record the current file's stem. Always fill in the real path.
  const existing = file.sources[handle];
  file.sources[handle] = { stem: existing?.stem ?? stem, path: realPath };
  await fsp.writeFile(SOURCES_PATH, JSON.stringify(file, null, 2) + "\n");
}

async function runWrite(args: Record<string, string>): Promise<never> {
  const real = args.real;
  const fixtureRel = args.fixture;
  if (!real) die("write mode requires --real <abs path>");
  if (!isAbsolute(real)) die(`--real must be an ABSOLUTE path (got "${real}")`);
  if (!existsSync(real)) die(`--real not found: ${real}`);
  if (!args.issue) die("write mode requires --issue <N>");
  if (!args.class) die("write mode requires --class <DefectClass>");
  if (!args.probe) die("write mode requires --probe <ProbeId>");

  const issue = parseInt(args.issue, 10);
  if (!Number.isInteger(issue)) die(`--issue must be an integer (got "${args.issue}")`);
  const cls = asDefectClass(args.class);
  const probe = asProbe(args.probe);
  const handle = args.handle ?? "src-01";
  const generator = ((): Generator => {
    const g = args.generator ?? "unknown";
    if (!(GENERATORS as readonly string[]).includes(g)) {
      die(`--generator must be one of: ${GENERATORS.join(", ")}`);
    }
    return g as Generator;
  })();
  const provenance = args.provenance ?? "";
  const regressionTest =
    args["regression-test"] ??
    `src/lib/heuristics/${basename(fixtureRel ?? "fixture", ".pdf")}.repro.test.ts`;

  const fixturePath = isAbsolute(fixtureRel)
    ? fixtureRel
    : join(REPO_ROOT, fixtureRel);
  if (!existsSync(fixturePath)) die(`--fixture not found: ${fixturePath}`);

  // Parse BOTH live — never trust a stale snapshot for the verification.
  const realA = await analyze(real);
  const fixA = await analyze(fixturePath);
  bailIfUnreadable(realA, "real résumé");
  bailIfUnreadable(fixA, "fixture");

  const spec = defectSpec(cls);

  // ── THE VERIFICATION. A fixture that does NOT exhibit the class is worse than
  // no fixture; refuse to write anything.
  const fixtureExhibits = spec.exhibits(fixA.artifact, fixA.sweep.derived);
  if (!fixtureExhibits) {
    console.error(
      `\n⛔ FAIL — the fixture does NOT exhibit "${cls}".\n` +
        `   ${fixtureRel}\n` +
        `   A fixture that parses correctly while the real résumé fails cannot ` +
        `pin the defect. Writing NOTHING (no registry row, no sources entry).\n` +
        `   Load-bearing axes for this class: ${spec.loadBearingAxes.join(", ")}`,
    );
    process.exit(1);
  }

  const realExhibits = spec.exhibits(realA.artifact, realA.sweep.derived);
  if (!realExhibits) {
    console.warn(
      `\n⚠ WARNING — the REAL résumé does not itself exhibit "${cls}" ` +
        `(the fixture does). Recording anyway, but double-check the class is right.`,
    );
  }

  // matchedAxes: the class's load-bearing axes that DIVERGE between real and
  // fixture, intersected with the load-bearing set. For a covered/dedup row the
  // pair agrees on every load-bearing axis (that agreement IS why the fixture
  // covers the class the real exhibits), so this intersection is empty — which
  // says nothing useful. So we record the load-bearing axes THEMSELVES: the axes
  // on which the fixture reproduces the defect. The divergence set is logged
  // (empty, for a dedup row) for transparency.
  const diverged = divergedAxes(
    realA.artifact,
    realA.sweep.derived,
    fixA.artifact,
    fixA.sweep.derived,
    spec.loadBearingAxes,
  );
  const matchedAxes: AxisPath[] = [...spec.loadBearingAxes];

  const realBytes = new Uint8Array(await fsp.readFile(real));
  const stem = basename(real, ".pdf");
  const id = nextLedgerId();

  const derivation =
    args.derivation ??
    (realExhibits
      ? `existing corpus fixture already covers ${cls} (dedup row); real résumé ` +
        `${handle} exhibits the same class and the fixture reproduces it — no new ` +
        `fixture minted`
      : `fixture reproduces ${cls}`);

  const row: RegistryRow = {
    id,
    source: { handle, sha256: sha256(realBytes), generator, provenance },
    fixture: fixtureRel,
    derivation,
    defects: [{ issue, class: cls, probe, regressionTest, status: "open" }],
    signature: {
      real: realA.artifact,
      fixture: fixA.artifact,
      matchedAxes,
    },
    verifiedRepro: new Date().toISOString().slice(0, 10),
  };

  await fsp.mkdir(join(REPO_ROOT, "internal/fixtures"), { recursive: true });
  await fsp.appendFile(REGISTRY_PATH, JSON.stringify(row) + "\n");
  await mergeSources(handle, stem, real);

  console.log(`\n✔ VERIFIED — ${fixtureRel} exhibits "${cls}".`);
  console.log(`  ledger row ${id} appended to internal/fixtures/registry.jsonl`);
  console.log(`  sources.local.json: ${handle} → path recorded (gitignored)`);
  console.log(
    `  matchedAxes (load-bearing): ${matchedAxes.join(", ")}\n` +
      `  divergence on load-bearing axes (real vs fixture): ` +
      `${diverged.length ? diverged.join(", ") : "(none — agrees on all load-bearing axes)"}`,
  );
  console.log(`  regressionTest recorded: ${regressionTest}`);

  console.log(`\n── repro-test scaffold (only if you MINTED a new fixture) ──`);
  console.log(reproTestScaffold(fixtureRel, issue, cls, probe));
  process.exit(0);
}

function reproTestScaffold(
  fixtureRel: string,
  issue: number,
  cls: DefectClass,
  probe: ProbeId,
): string {
  const stem = basename(fixtureRel, ".pdf");
  return `// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Repro regression for #${issue} — ${cls} (${probe}).
 * Persona is synthetic per the fixtures PII policy. Ledger: internal/fixtures/registry.jsonl.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "${fixtureRel}",
);

describe("#${issue} — ${cls}", () => {
  it("pins the corrected field values (fill in the exact assertions)", async () => {
    const c = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    expect(c.canonical.fields).toBeTruthy();
  });
});
// Also write ${stem}.origin.json next to the fixture:
//   { "derivedFrom": "real-resume", "ledgerId": "<rl-id>",
//     "reproduces": [${issue}], "defectClass": "${cls}", "probe": "${probe}" }`;
}

// ── entry ────────────────────────────────────────────────────────────────────

requireNode22();

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(
    `fixture-derive — issue #39\n\n` +
      `  --match:  --real <abs> [--probe <id> | --class <C>]\n` +
      `  write:    --real <abs> --fixture <repo-rel.pdf> --issue <N> --class <C> ` +
      `--probe <P>\n            [--handle src-NN] [--generator ${GENERATORS.join("|")}] ` +
      `[--provenance "..."] [--derivation "..."] [--regression-test <path>]`,
  );
  process.exit(0);
}

if (args.fixture) {
  await runWrite(args);
} else {
  await runMatch(args);
}
