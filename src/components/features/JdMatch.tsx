// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * JdMatch — diagnostic JD-coverage panel.
 *
 * Renders the covered/missing lists from `computeCoverage` against the
 * extracted JD terms. Framing is diagnostic ("the JD asks for these; here's
 * what we found"), not prescriptive ("add this to your resume"). The score
 * is shown as N-of-M skill coverage, not as a percentage match label.
 */

import type { ExtractedTerm } from "../../lib/jd-match/extract-jd-terms.ts";
import type { CoverageResult } from "../../lib/jd-match/coverage.ts";

interface JdMatchProps {
  coverage: CoverageResult;
  terms: readonly ExtractedTerm[];
  /** How many noun-pass terms the extractor silenced past its cap. When > 0,
   *  the UI surfaces a footnote so the user knows the panel isn't exhaustive. */
  nounsDropped?: number;
}

export function JdMatch({ coverage, terms, nounsDropped = 0 }: JdMatchProps) {
  const total = terms.length;
  const covered = coverage.covered.length;

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border-light bg-surface-card p-5 shadow-sm">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            JD match
          </h2>
          <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-content-secondary">
            alpha
          </span>
        </div>
        <p className="text-base font-semibold text-content-primary">
          Your resume mentions {covered} of {total} terms from this JD.
        </p>
        <p className="text-xs text-content-tertiary">
          Weighted coverage:{" "}
          <span className="font-mono text-content-secondary">
            {coverage.score}/100
          </span>{" "}
          — skill {coverage.weights.skill.toFixed(1)}, phrase{" "}
          {coverage.weights.noun.toFixed(1)}.
        </p>
        <p className="max-w-prose text-xs text-content-tertiary">
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
        <p className="text-[11px] text-content-muted">
          +{nounsDropped} more capitalized phrase{nounsDropped === 1 ? "" : "s"}{" "}
          in this JD weren't surfaced — the noun-phrase pass keeps the first
          ones it finds and drops the rest to keep the panel readable.
        </p>
      )}
    </section>
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
      <h3 className="text-xs font-semibold uppercase tracking-wider text-content-muted">
        {heading}
      </h3>
      {terms.length === 0 ? (
        <p className="text-xs text-content-tertiary">{emptyCopy}</p>
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
      <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-content-muted">
        {sourceLabel}
      </span>
    </li>
  );
}
