// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SkillTermGuidance — surfaces the term-quality classifier's verdict on the
 * résumé's OWN skills, in the résumé review lane (#586). `TermQualityAdvisory`
 * (#585) does the equivalent job on `/jobs/`, but that surface can only edit
 * the search *query* — it has no DropZone and no editor. This one sits beside
 * `SkillsSection` on `/`, where `onAddSkill` writes through the existing
 * inline-edit path (`useEditableParse`), so a suggestion here can actually
 * land in the document.
 *
 * SAME CLASSIFIER, NO SECOND JUDGEMENT. Builds a `JobQuery` from the current
 * parse with `buildJobQuery` and reads it through `assessQueryTerms` — the
 * same function `/jobs/` calls. This component adds no rule of its own; it
 * only decides what to show and how to phrase the surrounding copy.
 *
 * COPY IS DELIBERATELY NOT `/jobs/`'S COPY. `TermQualityAdvisory` frames
 * everything as "your query" (heading: "Commonly expected for this role, not
 * in your query") because that surface edits a search. Here the framing is
 * always "your résumé" / "in your résumé" — the document, not a query — per
 * the issue's instruction that an identically-reading sentence belongs on
 * only one surface. `TermVerdict.reason` is the one exception: it is
 * written once in `term-quality.ts` and rendered verbatim on both surfaces on
 * purpose, so the same skill can never be explained two different ways.
 *
 * "NOISE" SKILLS ARE DELIBERATELY OMITTED. A "noise" verdict's reason talks
 * about search admission ("Too common as a search term to narrow your
 * results") — a query concept with nothing to say about a résumé. Only
 * "strong" (recognized) and "weak" (not recognized by matchers, but not
 * struck as worthless — term-quality.ts's central rule) skill verdicts, plus
 * `missing` skills, render here. Both are `[]`/absent whenever no role
 * resolved (term-quality.ts rule 1), which is what makes this component
 * return `null` for an unresolvable résumé too — no separate check is needed
 * for that case.
 *
 * NEVER AUTO-EDITS. `onAddSkill` fires only from a user click on an `AddPill`
 * (the same primitive `TermQualityAdvisory` reuses) — this component reads
 * the parse, it never writes to it on its own.
 *
 * Reuse Gate (PR body): no existing résumé-review surface fit. `CritiquePanel`
 * is WebLLM-gated content critique (prose/bullet quality), not vocabulary
 * matching, and lives in a different tab entirely. The skills-ordering
 * critique issue (#544) is unimplemented — there is no surface to extend.
 * `TermQualityAdvisory` itself can't be reused as-is: it writes into a
 * `JobQuery`, not the résumé model, and its copy is query-framed throughout.
 * So this is a new, narrowly-scoped sibling, not a parallel copy of either.
 */

import { assessQueryTerms } from "../../lib/job-search/term-quality.ts";
import { buildJobQuery, type ResumeQueryInput } from "../../lib/job-search/query-builder.ts";
import { missingTermLabel } from "./TermQualityAdvisory.tsx";
import { AddPill } from "./ReconstructedAdd.tsx";

export function SkillTermGuidance({
  parsed,
  onAddSkill,
}: {
  /** The current parse — same shape `FindJobsPanel` feeds `buildJobQuery`. */
  parsed: ResumeQueryInput;
  /** The existing inline-edit path (`useEditableParse.addSkill`) — the ONLY
   *  way a suggestion here reaches the résumé. */
  onAddSkill: (skill: string) => void;
}) {
  const query = buildJobQuery(parsed);
  const assessment = assessQueryTerms(query);

  const skillVerdicts = assessment.verdicts.filter((v) => v.kind === "skill");
  const recognized = skillVerdicts.filter((v) => v.quality === "strong");
  const unrecognized = skillVerdicts.filter((v) => v.quality === "weak");
  const missingSkills = assessment.missing.filter((m) => m.kind === "skill");

  if (recognized.length === 0 && unrecognized.length === 0 && missingSkills.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-border-light bg-surface-subtle p-3">
      <p className="flex items-start gap-1.5 text-sm font-semibold text-content-secondary">
        <span aria-hidden="true">⚠︎</span>
        <span>
          <span className="sr-only">Term guidance: </span>
          Terms worth adding
        </span>
      </p>

      {missingSkills.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-content-tertiary">
            Roles like yours are usually described with terms not in your résumé
          </span>
          <div className="flex flex-wrap gap-1.5">
            {missingSkills.map((term) => (
              <AddPill
                key={term.term}
                label={missingTermLabel(term)}
                onClick={() => onAddSkill(missingTermLabel(term))}
              />
            ))}
          </div>
        </div>
      )}

      {recognized.length > 0 && (
        <p className="text-sm text-content-tertiary">
          <span className="font-medium text-content-secondary">
            Recognized in your résumé:
          </span>{" "}
          {recognized.map((v) => v.term).join(", ")}
        </p>
      )}

      {unrecognized.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-content-tertiary">
            <span className="font-medium text-content-secondary">
              Not recognized by matchers:
            </span>{" "}
            {unrecognized.map((v) => v.term).join(", ")}
          </p>
          {/* `reason` rendered verbatim, per term-quality.ts's contract — the
           *  same explanation `/jobs/` would show for the same skill. */}
          <ul className="flex flex-col gap-0.5 pl-4 text-sm text-content-tertiary">
            {unrecognized.map((v) => (
              <li key={v.term} className="list-disc">
                <span className="font-medium">{v.term}</span> — {v.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
