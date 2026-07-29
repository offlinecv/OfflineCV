// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Per-fixture GROUND TRUTH and the precision/recall scoreboard over it (#654).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THE GAP THIS CLOSES — read before adding a truth file.                   │
 * │                                                                          │
 * │ Every existing corpus gate measures a RELATION, never a fact.             │
 * │ `corpus.test.ts` measures CHANGE: the snapshot is counts, presence flags  │
 * │ and dimension numbers, "deliberately lossy … never raw text or field      │
 * │ values", so a fixture whose company is parsed as its city passes forever  │
 * │ as long as it keeps being parsed that way. `corpus-roundtrip.test.ts`     │
 * │ measures SELF-CONSISTENCY: parse1 ≡ parse3 — our renderer against our own │
 * │ parser, with no outside opinion in the loop, so a wrong parse that        │
 * │ re-parses to the same wrong value is a PASS. Nothing anywhere holds a     │
 * │ statement of what the PDF actually says.                                  │
 * │                                                                          │
 * │ Consequence, measured: a stably wrong parse is invisible, and 15 of the   │
 * │ 21 defect classes had zero corpus evidence. "Which parser investment pays │
 * │ most" was archaeology instead of a number.                                │
 * │                                                                          │
 * │ A `<name>.truth.json` is that outside opinion: what a human reads off the │
 * │ page. It is authored by READING THE PDF — never by running the parser and │
 * │ recording its output, which is a snapshot with extra steps and bakes in   │
 * │ exactly the wrong parses this file exists to find. Where the parser        │
 * │ disagrees with the truth, THAT DISAGREEMENT IS THE DELIVERABLE: record it │
 * │ as a `knownWrong` entry naming the issue that owns it. Never reconcile it │
 * │ by editing the truth.                                                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * PII: a truth file holds the fixture's literal name / email / phone / employers.
 * That is safe ONLY because every fixture persona is synthetic by policy — and
 * because it is now enforced rather than assumed: `check-fixture-pii.mjs` sweeps
 * `*.truth.json` alongside the PDFs, so the sidecar cannot become the one place a
 * real address hides. This is a deliberate departure from the corpus snapshot's
 * "never field values" rule, and it is the whole point — the snapshot is lossy
 * BECAUSE it is machine-generated from the parse, whereas a truth file is
 * hand-written and reviewed.
 *
 * Test-only (`__test-utils__/`): read by `corpus.test.ts`'s existing walk, so the
 * truth pass costs no second parse of all 57 PDFs. Never imported by production.
 */

import { readFileSync } from "node:fs";

/** Bump when the on-disk truth shape changes so stale files fail loudly. */
const TRUTH_SCHEMA_VERSION = 1;

/**
 * The scoreboard's field axes.
 *
 * Scalar contact fields are one-or-zero. The list fields are compared as
 * MULTISETS, not positionally: a parser that drops role 1 would otherwise be
 * scored wrong on every remaining role too, turning one defect into N and making
 * the number useless for ranking. Multiset matching reports exactly what it is —
 * how many of the true values came back, and how many returned values were real.
 */
export const TRUTH_FIELDS = [
  "name",
  "email",
  "phone",
  "location",
  "experience.title",
  "experience.company",
  "experience.dates",
  "education.degree",
  "education.institution",
  "skills",
] as const;

export type TruthField = (typeof TRUTH_FIELDS)[number];

/**
 * A field the parser is KNOWN to get wrong on this fixture.
 *
 * `open` / `accepted` mean exactly what they mean on the corpus gates'
 * known-failure baselines, and are swept by the same CI script — a truth field
 * the parser gets wrong is an exemption in the same sense, and rots the same way
 * when its issue closes.
 *
 * `unfiled` is the third state, and it exists because this file's FIRST run
 * found eleven disagreements across fifteen fixtures, most of which no open
 * issue described. The alternatives were both dishonest: invent an issue number,
 * or mark a live defect `accepted` so the script goes quiet. So an `unfiled`
 * entry carries `issue: null`, states the wrong parse in its `note`, is printed
 * on every CI run rather than swallowed, and is capped — `corpus.test.ts` pins a
 * ceiling on how many may exist, so undescribed debt cannot grow silently while
 * still not blocking the measurement that discovered it. File the issue, then
 * flip the entry to `open`.
 */
export interface KnownWrongField {
  issue: number | null;
  status: "open" | "accepted" | "unfiled";
  note: string;
}

/** One role as a human reads it off the page. `dates` is the range verbatim. */
export interface TruthRole {
  title?: string;
  company?: string;
  dates?: string;
}

export interface TruthDegree {
  degree?: string;
  institution?: string;
}

/** The on-disk `<name>.truth.json`. */
export interface FixtureTruth {
  schemaVersion: number;
  /** How this file was authored — prose, and required. A truth file whose
   *  provenance is "ran the parser" is not ground truth; making the claim
   *  explicit is what lets a reviewer catch that. */
  provenance: string;
  contact: {
    full_name?: string;
    email?: string;
    phone?: string;
    location?: string;
  };
  experience: TruthRole[];
  education: TruthDegree[];
  skills: string[];
  /**
   * Fields deliberately NOT annotated on this fixture, skipped by the scorer.
   *
   * An explicit list rather than a `null`/absent convention, because the two
   * things it separates are easy to conflate and expensive to get wrong: a
   * `skills: []` means THE PAGE HAS NO SKILLS (so anything the parser returns is
   * a fabrication and precision must drop), while an un-annotated field means
   * NOBODY HAS READ IT YET (so any score would be fiction). Silently treating
   * the second as the first is precisely the "auto-seeded truth" failure the
   * whole file exists to avoid — it manufactures numbers out of an absence.
   *
   * Every entry needs a reason in `provenance`. Prefer annotating over listing.
   */
  unannotated?: TruthField[];
  knownWrong?: Partial<Record<TruthField, KnownWrongField>>;
}

/** Per-field tallies. `expected` = values on the page, `predicted` = values the
 *  parser returned, `matched` = the multiset intersection. */
export interface FieldScore {
  expected: number;
  predicted: number;
  matched: number;
}

/** `null` for a field this fixture does not annotate — see `unannotated`. */
export type TruthScores = Record<TruthField, FieldScore | null>;

/** The parse side of the comparison, in the shape the scorer needs. Taking a
 *  narrow struct rather than a `CascadeResult` keeps this module free of the
 *  parser's types, so it can be unit-tested on literals. */
export interface ParsedForTruth {
  full_name?: string;
  email?: string;
  phone?: string;
  location?: string;
  experience: readonly { title?: string; company?: string; start_date?: string; end_date?: string; is_current?: boolean }[];
  education: readonly { degree?: string; field?: string; institution?: string }[];
  skills: readonly string[];
}

// ── Comparison ───────────────────────────────────────────────────────────────

/**
 * Fold a value to the form the comparison judges.
 *
 * Case, surrounding whitespace, internal whitespace runs, dash VARIANT and
 * trailing sentence punctuation are NOT what this file is measuring — a parser
 * that returns "Globex Systems LLC" where the page says "Globex Systems LLC." or
 * "2022 - Present" where the page draws "2022 – Present" has not made a mistake
 * worth a red build. (Dash fidelity across the export IS a real concern, and it
 * already has a gate: `corpus-roundtrip.test.ts` compares values exactly, which
 * is how #326's `→` → `->` substitution stays visible.)
 *
 * Anything beyond that — a dropped word, a swapped field, a truncated tail —
 * survives normalization and counts, which is the point.
 */
function normalizeTruthValue(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Field-specific folds, layered on top of {@link normalizeTruthValue}.
 *
 * Each one removes a difference that is a RESTATEMENT of the same fact, never a
 * difference in the fact — the same line `normalizeTruthValue` draws for case and
 * whitespace, drawn once more where a field has its own vocabulary. Without them
 * the scoreboard's loudest signal would be our own modelling choices (the parser
 * splits `degree` from `field`; the truth file records the line as drawn), and a
 * measurement whose top findings are artifacts of the measurement is worse than
 * none.
 *
 * Everything NOT listed here is compared as written, deliberately. A dropped
 * street number, a glued-on location, a stray separator and a lost token all
 * survive these folds and count.
 */
const FIELD_NORMALIZERS: Partial<Record<TruthField, (v: string) => string>> = {
  // Digits only: `973-555-0123` and `(973) 555-0123` are the same number, and
  // the parser normalizes presentation on purpose. A CHANGED digit still fails.
  phone: (v) => {
    const digits = v.replace(/\D/g, "");
    return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  },
  // "Present" / "Current" / "Now" / "Ongoing" are one fact drawn four ways; the
  // parser carries it as an `is_current` flag with no memory of the wording.
  "experience.dates": (v) =>
    normalizeTruthValue(v).replace(/\b(present|current|now|ongoing)\b/g, "present"),
  // The connective in "B.S. in Computer Science": the parser stores `degree` and
  // `field` separately and cannot know whether the page wrote one.
  "education.degree": (v) =>
    normalizeTruthValue(v).replace(/\bin\b/g, " ").replace(/\s+/g, " ").trim(),
};

/** Multiset intersection size, so a duplicated value cannot be matched twice. */
function multisetMatched(
  expected: readonly string[],
  predicted: readonly string[],
  normalize: (v: string) => string,
): number {
  const pool = new Map<string, number>();
  for (const value of predicted.map(normalize)) {
    if (!value) continue;
    pool.set(value, (pool.get(value) ?? 0) + 1);
  }
  let matched = 0;
  for (const value of expected.map(normalize)) {
    const left = pool.get(value) ?? 0;
    if (left > 0) {
      pool.set(value, left - 1);
      matched++;
    }
  }
  return matched;
}

function scoreField(
  field: TruthField,
  expected: readonly (string | undefined)[],
  predicted: readonly (string | undefined)[],
): FieldScore {
  const e = expected.filter((v): v is string => !!v && v.trim().length > 0);
  const p = predicted.filter((v): v is string => !!v && v.trim().length > 0);
  const normalize = FIELD_NORMALIZERS[field] ?? normalizeTruthValue;
  return {
    expected: e.length,
    predicted: p.length,
    matched: multisetMatched(e, p, normalize),
  };
}

/**
 * The parsed date range, composed back into the one string a truth file states.
 *
 * The truth file records what the page draws ("Mar 2021 - Present"); the parser
 * returns the halves plus an `is_current` flag. Composing here — rather than
 * asking a human to split the range the way this parser happens to — keeps the
 * truth file a statement about the PDF instead of a statement about our model.
 */
function composeParsedDates(role: ParsedForTruth["experience"][number]): string | undefined {
  const start = role.start_date?.trim();
  const end = role.end_date?.trim() || (role.is_current ? "Present" : "");
  if (!start && !end) return undefined;
  return end ? `${start ?? ""} - ${end}` : start;
}

/** The degree as a truth file states it ("B.S. in Computer Science"); the parser
 *  splits it into `degree` + `field`. Same reasoning as `composeParsedDates`. */
function composeParsedDegree(entry: ParsedForTruth["education"][number]): string | undefined {
  const degree = entry.degree?.trim();
  const field = entry.field?.trim();
  if (!degree) return field || undefined;
  // Joined with a plain space, not " in ": the page may or may not carry the
  // connective and the parser has no record of which. `FIELD_NORMALIZERS` folds
  // it away on both sides, so this composition never has to guess.
  return field ? `${degree} ${field}` : degree;
}

/** Score one parse against one truth file, per field. */
export function scoreAgainstTruth(
  truth: FixtureTruth,
  parsed: ParsedForTruth,
): TruthScores {
  const skipped = new Set(truth.unannotated ?? []);
  const all: Record<TruthField, FieldScore> = {
    name: scoreField("name", [truth.contact.full_name], [parsed.full_name]),
    email: scoreField("email", [truth.contact.email], [parsed.email]),
    phone: scoreField("phone", [truth.contact.phone], [parsed.phone]),
    location: scoreField("location", [truth.contact.location], [parsed.location]),
    "experience.title": scoreField("experience.title", 
      truth.experience.map((r) => r.title),
      parsed.experience.map((r) => r.title),
    ),
    "experience.company": scoreField("experience.company", 
      truth.experience.map((r) => r.company),
      parsed.experience.map((r) => r.company),
    ),
    "experience.dates": scoreField("experience.dates", 
      truth.experience.map((r) => r.dates),
      parsed.experience.map(composeParsedDates),
    ),
    "education.degree": scoreField("education.degree", 
      truth.education.map((d) => d.degree),
      parsed.education.map(composeParsedDegree),
    ),
    "education.institution": scoreField("education.institution", 
      truth.education.map((d) => d.institution),
      parsed.education.map((d) => d.institution),
    ),
    skills: scoreField("skills", truth.skills, parsed.skills),
  };
  return Object.fromEntries(
    TRUTH_FIELDS.map((f) => [f, skipped.has(f) ? null : all[f]]),
  ) as TruthScores;
}

/** True when the parser reproduced this field exactly — no miss, no fabrication.
 *  A field neither side carries is vacuously exact (0/0/0). */
export function isExact(s: FieldScore): boolean {
  return s.matched === s.expected && s.matched === s.predicted;
}

// ── Loading ──────────────────────────────────────────────────────────────────

/** The truth sidecar beside a fixture PDF, or `null` when it carries none. */
function truthPathFor(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, ".truth.json");
}

/**
 * Read and validate one fixture's truth file. Returns `null` when the fixture is
 * not annotated — the corpus is annotated INCREMENTALLY, so an un-annotated
 * fixture is a known gap the scoreboard reports, not an error. What is an error
 * is a truth file that is present but malformed.
 */
export function readTruth(pdfPath: string): FixtureTruth | null {
  let raw: string;
  try {
    raw = readFileSync(truthPathFor(pdfPath), "utf8");
  } catch {
    return null;
  }
  const truth = JSON.parse(raw) as FixtureTruth;
  const bad = (msg: string): never => {
    throw new Error(`[truth] ${truthPathFor(pdfPath)}: ${msg}`);
  };
  if (truth.schemaVersion !== TRUTH_SCHEMA_VERSION)
    bad(`schemaVersion ${truth.schemaVersion} ≠ ${TRUTH_SCHEMA_VERSION}`);
  if (!truth.provenance || truth.provenance.trim().length === 0)
    bad("`provenance` is required — say how this file was authored");
  validateTruthMembers(truth, bad);
  validateTruthFieldKeys(truth, bad);
  validateKnownWrongEntries(truth, bad);
  return truth;
}

/** Anything `bad()`-shaped: reports and never returns. */
type Reject = (msg: string) => never;

/**
 * The four members `scoreAgainstTruth` dereferences unconditionally.
 *
 * Without this, a file that simply omits `skills` — no `unannotated` entry, just
 * missing — passes validation and then dies inside the scorer with
 * `Cannot read properties of undefined (reading 'filter')`, instead of the
 * `[truth] <path>: …` message this validator exists to produce. A missing
 * required member is squarely the "present but malformed" case the docblock
 * above names, and these files are hand-authored, so it is the likely typo.
 *
 * `contact` is an object; the other three are arrays, and an object where an
 * array belongs fails the scorer the same way a missing one does.
 */
function validateTruthMembers(truth: FixtureTruth, bad: Reject): void {
  if (!truth.contact || typeof truth.contact !== "object")
    bad("`contact` is required (an object, `{}` if the page carries none)");
  for (const member of ["experience", "education", "skills"] as const) {
    if (!Array.isArray(truth[member]))
      bad(`\`${member}\` is required and must be an array ([] if the page has none)`);
  }
}

/** `knownWrong` / `unannotated` name real fields, disjointly, and not all of them. */
function validateTruthFieldKeys(truth: FixtureTruth, bad: Reject): void {
  for (const key of [
    ...Object.keys(truth.knownWrong ?? {}),
    ...(truth.unannotated ?? []),
  ]) {
    if (!(TRUTH_FIELDS as readonly string[]).includes(key))
      bad(`names unknown field "${key}"`);
  }
  // A field cannot be both un-annotated and known-wrong: there is no truth to be
  // wrong ABOUT. Catching it here keeps a copy-paste from quietly disabling a
  // ratchet entry that looks, in the diff, like it is still there.
  for (const key of truth.unannotated ?? []) {
    if (truth.knownWrong?.[key])
      bad(`"${key}" is both unannotated and knownWrong — pick one`);
  }
  // …and a file cannot list EVERY field as un-annotated. The corpus gate's
  // annotated-fixture floor counts FILES, so a truth file gutted to all-
  // `unannotated` would keep the floor satisfied while measuring nothing — the
  // same one-line escape as deleting the file, only harder to see in a diff.
  //
  // Compare the DISTINCT count. A raw `.length >= TRUTH_FIELDS.length` counts
  // repeats, so a list like `["email", "email", …]` reaches the threshold while
  // leaving most fields annotated — the guard would reject a file that measures
  // plenty. `Set.size` asks the question the message actually claims ("every
  // field is listed"), and still catches the real gutting: a file that lists
  // each field once has a distinct count of exactly `TRUTH_FIELDS.length`.
  if (new Set(truth.unannotated ?? []).size >= TRUTH_FIELDS.length)
    bad(
      "every field is listed as `unannotated` — this file measures nothing. " +
        "Delete it, or annotate at least one field.",
    );
}

/** Each `knownWrong` entry carries a reason and a well-formed issue citation. */
function validateKnownWrongEntries(truth: FixtureTruth, bad: Reject): void {
  for (const [field, entry] of Object.entries(truth.knownWrong ?? {})) {
    if (!entry.note?.trim()) bad(`knownWrong.${field}: \`note\` is required`);
    if (entry.status === "unfiled") {
      if (entry.issue !== null)
        bad(`knownWrong.${field}: an "unfiled" entry must carry \`issue: null\``);
    } else if (!Number.isInteger(entry.issue) || (entry.issue ?? 0) <= 0) {
      bad(`knownWrong.${field}: \`issue\` must be a positive integer`);
    }
  }
}

/** Every `unfiled` disagreement in one truth file — the debt the ceiling counts. */
export function unfiledFields(truth: FixtureTruth): TruthField[] {
  return Object.entries(truth.knownWrong ?? {})
    .filter(([, entry]) => entry.status === "unfiled")
    .map(([field]) => field as TruthField);
}

// ── Scoreboard ───────────────────────────────────────────────────────────────

/** Running totals, summed over fixtures. */
export type TruthTotals = Record<TruthField, FieldScore>;

export function emptyTotals(): TruthTotals {
  return Object.fromEntries(
    TRUTH_FIELDS.map((f) => [f, { expected: 0, predicted: 0, matched: 0 }]),
  ) as TruthTotals;
}

export function addTo(totals: TruthTotals, scores: TruthScores): void {
  for (const field of TRUTH_FIELDS) {
    const s = scores[field];
    if (!s) continue;
    totals[field].expected += s.expected;
    totals[field].predicted += s.predicted;
    totals[field].matched += s.matched;
  }
}

/** `matched / predicted` — of what the parser returned, how much was real.
 *  Undefined (printed as `—`) when it returned nothing: a ratio over zero is not
 *  1.0, it is unmeasured, and printing 1.0 there is how a scoreboard starts
 *  lying. */
export function precision(s: FieldScore): number | undefined {
  return s.predicted === 0 ? undefined : s.matched / s.predicted;
}

/** `matched / expected` — of what the page says, how much came back. */
export function recall(s: FieldScore): number | undefined {
  return s.expected === 0 ? undefined : s.matched / s.expected;
}

function pct(value: number | undefined): string {
  return value === undefined ? "    —" : `${(value * 100).toFixed(1).padStart(5)}%`;
}

/**
 * The printed scoreboard. Grouped by generator category (the fixture root's
 * subdirectory) plus an ALL row, because "which exporter do we parse worst" is
 * the question the number exists to answer.
 */
export function formatScoreboard(
  byCategory: ReadonlyMap<string, TruthTotals>,
  coverage: { annotated: number; total: number },
): string {
  const lines: string[] = [
    "",
    `── ground-truth scoreboard (#654) — ${coverage.annotated}/${coverage.total} fixtures annotated ──`,
    `${"field".padEnd(24)}${"prec".padStart(6)}${"rec".padStart(7)}   expected/predicted/matched`,
  ];
  for (const [category, totals] of byCategory) {
    lines.push(`  ${category}`);
    for (const field of TRUTH_FIELDS) {
      const s = totals[field];
      if (s.expected === 0 && s.predicted === 0) continue;
      lines.push(
        `    ${field.padEnd(22)}${pct(precision(s))}${pct(recall(s))}   ` +
          `${s.expected}/${s.predicted}/${s.matched}`,
      );
    }
  }
  return lines.join("\n");
}
