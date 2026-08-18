// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * KeywordMatch — the deterministic term-coverage view of a JD match.
 *
 * This is the pre-#204 body of `JdMatch.tsx`, moved here VERBATIM when that
 * file became a router on `result.path` (#204). Nothing was "cleaned up" on the
 * way across: same element order, same class strings, same copy, same empty
 * states, same `title` snippet, same `+N more` footnote wording. The keyword
 * path is the default experience for every user who never opts into on-device
 * analysis AND the fallback floor for every user who does, so a cosmetic drift
 * here would be a regression for everyone. `KeywordMatch.parity.test.ts` pins
 * that output against the shipped strings.
 *
 * It keeps the whole card — chrome, header, disclaimer — rather than just the
 * two columns, so a keyword render is byte-identical to the pre-router one
 * instead of being reassembled from a shared shell whose spacing would have to
 * be re-derived. `SemanticMatch` owns the equivalent card for its own arm.
 *
 * Framing is diagnostic ("the JD asks for these; here's what we found"), not
 * prescriptive ("add this to your resume"). The score is shown as N-of-M skill
 * coverage, not as a percentage match label.
 *
 * Two consumers reach this through `JdMatch`: `PasteJdPanel`'s pasted JD and
 * `JobResultCard`'s "View match detail" (whose `RankedJob.jdMatch` is typed
 * `KeywordJdMatch`, so it can only ever land on this arm).
 */

import type { ExtractedTerm } from "../../lib/jd-match/extract-jd-terms.ts";
import type { JdMatchResult } from "../../lib/jd-match";
import { Card } from "@design-system";

/** The keyword arm of the union — same `Extract<…>` idiom `rank.ts` uses for
 *  `KeywordJdMatch`, so the two narrowings cannot drift. */
type KeywordResult = Extract<JdMatchResult, { path: "keyword" }>;

export function KeywordMatch({ result }: { result: KeywordResult }) {
  const { coverage, terms, nounsDropped } = result;
  const total = terms.length;
  const covered = coverage.covered.length;

  return (
    <Card className="flex flex-col gap-4 shadow-xs">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
            JD match
          </h2>
          <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-4xs font-semibold uppercase tracking-wider text-content-secondary">
            alpha
          </span>
        </div>
        <p className="text-base font-semibold text-content-primary">
          Your resume mentions {covered} of {total} terms from this JD.
        </p>
        <p className="text-sm text-content-tertiary">
          Weighted coverage:{" "}
          <span className="font-mono text-content-secondary">
            {coverage.score}/100
          </span>{" "}
          — skill {coverage.weights.skill.toFixed(1)}, phrase{" "}
          {coverage.weights.noun.toFixed(1)}.
        </p>
        <p className="max-w-prose text-sm text-content-tertiary">
          Diagnostic, not a verdict. We look for skills and phrases by name —
          we don't read context. Your JD text stays in this browser tab.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <TermColumn
          heading={`Covered (${coverage.covered.length})`}
          tone="covered"
          terms={coverage.covered}
          emptyCopy="None of the JD terms we extracted show up in the resume text."
        />
        <TermColumn
          heading={`Missing (${coverage.missing.length})`}
          tone="missing"
          terms={coverage.missing}
          emptyCopy="Every term we extracted shows up somewhere in the resume."
        />
      </div>

      {nounsDropped > 0 && (
        <p className="text-2xs text-content-muted">
          +{nounsDropped} more capitalized phrase{nounsDropped === 1 ? "" : "s"}{" "}
          in this JD weren't surfaced — the noun-phrase pass ranks hits by how
          often they recur (weighting the requirements section) and keeps the
          top ones to keep the panel readable.
        </p>
      )}
    </Card>
  );
}

function TermColumn({
  heading,
  tone,
  terms,
  emptyCopy,
}: {
  heading: string;
  tone: "covered" | "missing";
  terms: readonly ExtractedTerm[];
  emptyCopy: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
        {heading}
      </h3>
      {terms.length === 0 ? (
        <p className="text-sm text-content-tertiary">{emptyCopy}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {terms.map((term) => (
            <TermRow key={`${term.source}:${term.id}`} term={term} tone={tone} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TermRow({
  term,
  tone,
}: {
  term: ExtractedTerm;
  tone: "covered" | "missing";
}) {
  const marker = tone === "covered" ? "✓" : "•";
  const markerCls =
    tone === "covered"
      ? "text-feedback-success-text"
      : "text-content-muted";
  const sourceLabel = term.source === "skill" ? "skill" : "phrase";
  return (
    <li
      className="flex items-baseline gap-2 rounded border border-border-light px-2 py-1.5"
      title={term.snippet}
    >
      <span className={`text-sm font-semibold ${markerCls}`}>{marker}</span>
      <span className="text-sm text-content-primary">{term.display}</span>
      <span className="ml-auto font-mono text-3xs uppercase tracking-wider text-content-muted">
        {sourceLabel}
      </span>
    </li>
  );
}
