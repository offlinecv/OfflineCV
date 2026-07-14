// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * The corpus-match engine (issue #469, step 3).
 *
 * Answers the one question the six read-only parser probes cannot:
 *
 *   > This real résumé exposes defect class C. **Does any fixture in
 *   > `tests/fixtures/pdfs/` already reproduce C?**
 *
 * `COVERED` means STOP: go fix the parser against the existing fixture and never
 * open the real résumé again. `NO FIXTURE COVERS THIS` is the only answer that
 * justifies minting a new synthetic fixture.
 *
 * Pure, lib-layer, NO I/O — same discipline as `repro-artifact.ts`. It reads only
 * `ReproArtifact` + `DerivedSignals`, both PII-free by construction (numbers,
 * booleans, fixed enums; no free-form `string` slot), so nothing this file
 * touches can carry a résumé value. See `defect-classes.ts`'s header.
 *
 * ── The four semantics that make this correct rather than merely plausible ──
 *
 * **1. Coverage is `exhibits()`, NOT artifact similarity.**
 * A fixture covers class C iff `defectSpec(C).exhibits(fixtureArtifact,
 * fixtureDerived)` is true. Full stop. It is NOT "the fixture's artifact looks
 * like the résumé's artifact". Those come apart constantly, and conflating them
 * is the failure mode that makes the whole tool worse than useless:
 *
 *   - Divergence on an axis OUTSIDE `spec.loadBearingAxes` (a different
 *     `pageCount`, an extra layout trigger, a shorter `experience` section) is
 *     INFORMATIONAL and must NEVER disqualify a cover. A one-page LaTeX fixture
 *     is a perfectly good reproducer for a defect a three-page Word résumé
 *     exposed, provided it exhibits the same class. Ranking a candidate by
 *     whole-artifact distance would silently reject it.
 *   - Conversely, near-identical artifacts do NOT imply coverage. See (2).
 *
 * Because `exhibits()` is a pure function of the load-bearing axes, this also
 * means: if a fixture's load-bearing axis VALUES all equal the résumé's, and the
 * résumé exhibits C, the fixture necessarily exhibits C too. That identity is
 * why `nearMisses` (below) is a meaningful "why not" and not a rationalization.
 *
 * **2. Structurally-identical fixtures are separated by `derived` alone.**
 * `skills-header-unrecognized` and `skills-no-section` are BYTE-IDENTICAL in
 * `ReproArtifact` (0 skills parsed, no routed `skills` section — a rejected
 * header leaves no structural trace). The same holds for the education pair, and
 * for ALL SIX round-trip classes, whose entire domain is "the value changed while
 * the structure did not". So the engine may never shortcut a comparison to "same
 * artifact ⇒ same defect": it must run `exhibits()` over BOTH inputs, every time.
 * `fixture-match.test.ts` pins exactly that with two fixtures whose
 * `ReproArtifact`s are deep-equal and whose verdicts differ.
 *
 * **3. `nearMisses` is the "why not", and only exists when there is no cover.**
 * Computed only for classes with `coveredBy.length === 0` — when a cover exists
 * the near-miss is noise, and the caller's next action ("go use that fixture") is
 * already decided. Candidates are every corpus fixture (none of which covers, by
 * construction), ranked by how few of the CLASS's load-bearing axes diverge from
 * the résumé. Non-load-bearing divergence is not counted and not reported: it
 * cannot be the reason the fixture fails to reproduce, so printing it would bury
 * the signal.
 *
 *   Ranking (total and deterministic — no `Math.random`, no `Date`, no locale):
 *     a. fewer diverged load-bearing axes first;
 *     b. ties broken by fixture path, ascending by UTF-16 code unit (`<`, not
 *        `localeCompare`, whose order is locale-dependent);
 *     c. remaining ties (duplicate paths) broken by corpus index, ascending.
 *   Corpus ARRIVAL order therefore cannot change the output — only its content.
 *
 *   An empty `divergedAxes` on a near-miss is a real signal, not a bug: it means
 *   the fixture matches the résumé on every load-bearing axis yet does not
 *   exhibit the class. Given (1), that can only be (a) the caller passed a class
 *   the RÉSUMÉ does not exhibit either, or (b) `exhibits()` reads an axis its
 *   spec forgot to declare load-bearing — a table bug. Both are worth surfacing;
 *   neither is worth silently hiding.
 *
 *   The list is capped at `NEAR_MISS_LIMIT`. The cap is VISIBLE, never a silent
 *   truncation: `nearMissCandidateCount` always reports how many candidates were
 *   ranked, so a printer can say "showing 3 of 41".
 *
 * **4. Array axes compare ORDER-INSENSITIVELY; absent ≡ zero for sections.**
 * `triggers` and `disagreements` are SETS in meaning — the parser happens to emit
 * them in a stable order today, but nothing in the type says so, and a reordering
 * refactor must not spuriously light up a diverged axis. So both are canonicalized
 * (each element to a stable string, then sorted) before comparison. Cardinality is
 * preserved (a sorted multiset, not a deduped set), so a doubled trigger still
 * reads as different. `sections.X` compares LINE COUNTS via `sectionLineCount`,
 * which returns 0 for a section the router never cut — deliberately conflating
 * "absent" with "present but empty", exactly as every probe's `region.length > 0`
 * test does.
 */

import type { SectionName } from "./sections.config.ts";
import type { ReproArtifact, ReproParsedCounts } from "./repro-artifact.ts";
import type {
  AxisPath,
  DefectClass,
  DerivedSignalKey,
  DerivedSignals,
} from "./defect-classes.ts";
import {
  DEFECT_CLASSES,
  DERIVED_SIGNAL_KEYS,
  defectSpec,
  sectionLineCount,
} from "./defect-classes.ts";

/**
 * How many near-misses to emit per uncovered class. Small on purpose: the report
 * is read by a human deciding "do I mint a fixture?", and the 4th-closest
 * near-miss has never changed that answer. The cap is never silent —
 * `FixtureCoverage.nearMissCandidateCount` reports the full candidate count.
 */
export const NEAR_MISS_LIMIT = 3;

/** One corpus fixture, as the caller must hand it in: its repo-relative path
 *  plus the two PII-free halves of its parse. */
export interface CorpusEntry {
  /** e.g. `"tests/fixtures/pdfs/word/skills-glyph-header.pdf"`. Used verbatim in
   *  the output and as the deterministic tie-break key. */
  path: string;
  artifact: ReproArtifact;
  derived: DerivedSignals;
}

/** A fixture that does NOT reproduce the class, and the load-bearing axes on
 *  which it diverges from the résumé — the "why not" signal. */
export interface NearMiss {
  fixture: string;
  /** In the class's declared `loadBearingAxes` order. Empty ⇒ see semantics (3). */
  divergedAxes: AxisPath[];
}

/** The corpus's verdict on one defect class. */
export interface FixtureCoverage {
  class: DefectClass;
  /**
   * Fixture paths whose (artifact, derived) `exhibits()` this class,
   * de-duplicated. Non-empty ⇒ COVERED ⇒ do not mint a fixture.
   *
   * ORDER IS PRESENTATION ONLY. Membership is `exhibits()` and nothing else
   * (semantics (1)) — every entry here is an equally valid reproducer. But a
   * printer that shows one cover must pick one, and "alphabetically first" is an
   * arbitrary pick out of 34. So the list is ordered by WHOLE-ARTIFACT
   * divergence from the résumé, closest first: the fixture that most resembles
   * the real document is the one a maintainer most wants to open. Ties keep
   * corpus order. Reordering this list can never change a COVERED/NOT-COVERED
   * verdict, and no consumer may treat position as evidence.
   */
  coveredBy: string[];
  /** Only populated when `coveredBy` is empty. Ranked closest-first, capped at
   *  `NEAR_MISS_LIMIT`. */
  nearMisses: NearMiss[];
  /** How many candidates were ranked to produce `nearMisses` — i.e. the corpus
   *  size when uncovered, and 0 when covered. Makes the cap visible: a printer
   *  showing `nearMisses.length` of `nearMissCandidateCount` never truncates
   *  silently. */
  nearMissCandidateCount: number;
}

/**
 * For each requested defect class, which corpus fixtures already reproduce it —
 * and, when none does, which come closest and why they miss.
 *
 * Pure. Output is one entry per DISTINCT requested class, in `DEFECT_CLASSES`
 * order (never the caller's argument order), so two callers that found the same
 * defects print the same report. A duplicate in `defects` yields one entry.
 *
 * `real` / `realDerived` are used ONLY as the divergence reference for
 * `nearMisses`; coverage itself is decided entirely on the fixture's own parse
 * (semantics (1)). Passing a class the résumé does not itself exhibit is
 * therefore not an error — it is answered honestly, and shows up as a near-miss
 * with an empty `divergedAxes`.
 */
export function matchCorpus(
  real: ReproArtifact,
  realDerived: DerivedSignals,
  defects: readonly DefectClass[],
  corpus: readonly CorpusEntry[],
): FixtureCoverage[] {
  const requested = new Set(defects);

  // Memoized ONCE per call, before any sort: `wholeArtifactDivergence` walks
  // every axis of both parses, and it is class-independent (it is the
  // presentation tiebreak, never a coverage input). Computing it inside a sort
  // comparator would re-walk every axis O(n log n) times per class.
  const divergenceByIndex = corpus.map((f) =>
    wholeArtifactDivergence(real, realDerived, f),
  );

  return DEFECT_CLASSES.filter((c) => requested.has(c)).map((cls) => {
    const spec = defectSpec(cls);

    // Membership: `exhibits()`, full stop. Order: closest-first by whole-artifact
    // divergence (presentation only — see `FixtureCoverage.coveredBy`), corpus
    // index breaking ties so arrival order is the only remaining input.
    const coveredBy = dedupe(
      corpus
        .map((f, index) => ({ f, index }))
        .filter(({ f }) => spec.exhibits(f.artifact, f.derived))
        .sort(
          (x, y) =>
            divergenceByIndex[x.index] - divergenceByIndex[y.index] ||
            x.index - y.index,
        )
        .map(({ f }) => f.path),
    );

    if (coveredBy.length > 0) {
      return { class: cls, coveredBy, nearMisses: [], nearMissCandidateCount: 0 };
    }

    // No cover ⇒ every fixture is a candidate. Rank by load-bearing divergence.
    const ranked = corpus
      .map((f, index) => ({
        index,
        fixture: f.path,
        divergedAxes: divergedAxes(
          real,
          realDerived,
          f.artifact,
          f.derived,
          spec.loadBearingAxes,
        ),
      }))
      .sort(
        (x, y) =>
          x.divergedAxes.length - y.divergedAxes.length ||
          compareStrings(x.fixture, y.fixture) ||
          x.index - y.index,
      );

    return {
      class: cls,
      coveredBy,
      nearMisses: ranked
        .slice(0, NEAR_MISS_LIMIT)
        .map(({ fixture, divergedAxes: axes }) => ({ fixture, divergedAxes: axes })),
      nearMissCandidateCount: ranked.length,
    };
  });
}

/**
 * How many axes — of EVERY axis both parses carry, not just one class's
 * load-bearing ones — differ between the résumé and a fixture.
 *
 * PRESENTATION ONLY. This is the "which cover most resembles the real document"
 * tiebreak for `coveredBy`, and it must never touch coverage semantics
 * (semantics (1): a cover is `exhibits()`, never distance). Deliberately a flat
 * count, not a weighted distance: the density axes (`pageCount`,
 * `rawCharCount`, `extractedCharCount`) almost always differ and so contribute a
 * near-constant offset, leaving the STRUCTURAL and DERIVED axes — the ones that
 * actually say "this fixture is shaped like your résumé" — to do the ranking.
 *
 * The section axes are the UNION of both parses' routed sections, so a section
 * one has and the other lacks counts as a divergence (`sectionLineCount` reports
 * 0 for the absent side).
 */
function wholeArtifactDivergence(
  real: ReproArtifact,
  realDerived: DerivedSignals,
  f: CorpusEntry,
): number {
  const sections = new Set<SectionName | "profile">([
    ...real.sections.map((s) => s.name),
    ...f.artifact.sections.map((s) => s.name),
  ]);

  const axes: AxisPath[] = [
    "triggers",
    "sectionSource",
    "pageCount",
    "rawCharCount",
    "extractedCharCount",
    "linkAnnotationCount",
    "disagreements",
    ...[...sections].map((s): AxisPath => `sections.${s}`),
    ...(Object.keys(real.parsedCounts) as (keyof ReproParsedCounts)[]).map(
      (k): AxisPath => `parsedCounts.${k}`,
    ),
    ...DERIVED_SIGNAL_KEYS.map((k): AxisPath => `derived.${k}`),
  ];

  return divergedAxes(real, realDerived, f.artifact, f.derived, axes).length;
}

/**
 * The subset of `axes` whose VALUE differs between the two parses, in the given
 * axis order. Exported because the near-miss printer and any future
 * fixture-selection tooling need exactly this, and re-deriving it is how the two
 * drift apart.
 */
export function divergedAxes(
  a: ReproArtifact,
  aDerived: DerivedSignals,
  b: ReproArtifact,
  bDerived: DerivedSignals,
  axes: readonly AxisPath[],
): AxisPath[] {
  return axes.filter(
    (axis) => axisKey(axis, a, aDerived) !== axisKey(axis, b, bDerived),
  );
}

/**
 * The value at one `AxisPath`, canonicalized to a string so any two axis values
 * are comparable with `!==` — including the array axes, which are compared as
 * ORDER-INSENSITIVE multisets (semantics (4)).
 *
 * Total over `AxisPath`: the scalar axes are matched literally, the three
 * template-literal families by their `head.tail` split. The final `throw` is
 * unreachable through the type, and is here to fail loudly rather than silently
 * report "equal" if a future axis family is added to the union without a branch.
 */
function axisKey(path: AxisPath, a: ReproArtifact, d: DerivedSignals): string {
  switch (path) {
    case "triggers":
      // Sorted multiset: a reordering of the layout probes is not a divergence.
      return canonicalList([...a.triggers]);
    case "disagreements":
      return canonicalList(
        a.disagreements.map((x) => `${x.kind} ${x.field} ${x.likelyCause ?? ""}`),
      );
    case "sectionSource":
      return a.sectionSource;
    case "pageCount":
      return String(a.pageCount);
    case "rawCharCount":
      return String(a.rawCharCount);
    case "extractedCharCount":
      return String(a.extractedCharCount);
    case "linkAnnotationCount":
      return String(a.linkAnnotationCount);
    default:
      break;
  }

  const dot = path.indexOf(".");
  const head = path.slice(0, dot);
  const tail = path.slice(dot + 1);

  switch (head) {
    case "sections":
      // 0 for a section the router never cut — "absent" ≡ "present but empty".
      return String(sectionLineCount(a, tail as SectionName | "profile"));
    case "parsedCounts":
      return String(a.parsedCounts[tail as keyof ReproParsedCounts]);
    case "derived":
      return String(d[tail as DerivedSignalKey]);
    default:
      throw new Error(`fixture-match: unhandled axis path "${path}"`);
  }
}

/** A stable, unambiguous key for a list compared as an order-insensitive
 *  multiset. `JSON.stringify` of the SORTED copy — sorting a copy so the caller's
 *  array is never mutated, and JSON so no element can forge the separator. */
function canonicalList(xs: string[]): string {
  return JSON.stringify([...xs].sort(compareStrings));
}

/** Ascending by UTF-16 code unit. Explicit rather than `localeCompare`, whose
 *  ordering depends on the host's locale — determinism is a hard requirement. */
function compareStrings(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** First occurrence wins; input order preserved. */
function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
