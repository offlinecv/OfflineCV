// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * TermQualityAdvisory — the "here's what's missing" half of the term-quality
 * surface (#585). `JobQueryEditor` marks the chips that already exist; this
 * renders `QueryTermAssessment.missing` (`term-quality.ts`) as an add-able
 * row beneath the relevant chip list.
 *
 * Deliberately its own component, not inline in `JobQueryEditor` (already
 * near the ~200 LOC gate) or a fourth panel: this is the one place a grouped
 * term advisory lives, so #587's title/skill coherence note renders INSIDE it
 * rather than as a second advisory surface next to it.
 *
 * GROUPED BY KIND (see {@link GROUPS}), because the two kinds write to two
 * different fields of the query and a flat row said nothing about which.
 *
 * Renders nothing when it has nothing to say — `missing` empty AND no
 * coherence finding, which covers the unresolved-role case where
 * `assessQueryTerms` returns `[]`/`undefined` by contract. No empty-state box,
 * no "we couldn't identify your role" nag, and no "your résumé looks
 * consistent" all-clear (term-quality docblock, rule 1). The two conditions
 * are INDEPENDENT: a mismatched résumé routinely has no missing terms, and the
 * note must survive that.
 *
 * The coherence note is a block, not a pill, so it competes with nothing for
 * the missing-term caps (3 titles / 5 skills, `term-quality.ts`) — those keep
 * the advisory short on their own.
 *
 * `note` is rendered VERBATIM from the lib. The sentence is written once in
 * `term-quality.ts` so `/jobs/` and the résumé lane cannot describe the same
 * finding differently; this component never composes copy of its own.
 *
 * Reuse Gate: each suggestion is the existing `AddPill` "+ <label>"
 * progressive-disclosure pill (`ReconstructedAdd.tsx`) — the shared piece
 * this exact shape already has — not a new pill component.
 *
 * `MissingTerm.term` for `kind: "skill"` is a canonical jd-match id (e.g.
 * `ci-cd`), not a display label (`term-quality.ts` module docblock).
 * {@link missingTermLabel} is the one place that mapping happens, so the
 * text a user clicks and the text `JobQueryEditor` appends to `query.skills`
 * (which expects the same canonical labels `buildJobQuery` already produces)
 * can never drift apart — both read through this same helper.
 */

import { getSkillIndex } from "../../lib/jd-match/skills.ts";
import type { CoherenceFinding, MissingTerm } from "../../lib/job-search/term-quality.ts";
import { AddPill } from "./ReconstructedAdd.tsx";

/** The display text for a missing term — the term itself for a title, or the
 *  skill's human label (falling back to the id) for a skill. */
export function missingTermLabel(term: MissingTerm): string {
  if (term.kind === "title") return term.term;
  return getSkillIndex().idToLabel.get(term.term) ?? term.term;
}

/**
 * One group per `MissingTerm.kind`, in render order. The grouping is not
 * cosmetic: a click on "+ software engineering manager" writes into
 * `query.titles` and a click on "+ people management" writes into
 * `query.skills`, and in one flat row those two pills were indistinguishable —
 * a user could not tell what a click would do. The heading names the
 * destination first, then the consequence.
 *
 * Query-framed throughout ("your search"), like the rest of `/jobs/`. The `/`
 * lane's `SkillTermGuidance` deliberately says "your résumé" for the same
 * classifier output — same judgement, two different things a click can change,
 * so the copy may not be shared (see that component).
 */
const GROUPS: readonly { kind: MissingTerm["kind"]; heading: string }[] = [
  { kind: "title", heading: "Add to your titles — employers post these for this role" },
  { kind: "skill", heading: "Add to your skills — this role is usually hired on these" },
];

export function TermQualityAdvisory({
  missing,
  coherence,
  onAdd,
}: {
  missing: readonly MissingTerm[];
  /** A confident title/skill mismatch (#587), or `undefined` — the normal
   *  state, which renders nothing rather than an all-clear. */
  coherence?: CoherenceFinding;
  /** Called with the term the user clicked to add; `JobQueryEditor` maps it
   *  through {@link missingTermLabel} before writing it into the query, the
   *  same way this component renders it. */
  onAdd: (term: MissingTerm) => void;
}) {
  if (missing.length === 0 && !coherence) return null;

  return (
    <div className="flex flex-col gap-3 sm:col-span-2 lg:col-span-3">
      {/* #587. The mark is decorative (it repeats what the sentence says, so
       *  colour and glyph are never the only carriers); the sr-only prefix is
       *  what gives the block an accessible name in the reading order. */}
      {coherence && (
        <p className="flex items-start gap-1.5 text-xs text-feedback-warning-text">
          <span aria-hidden="true">⚠︎</span>
          <span>
            <span className="sr-only">Check these terms: </span>
            {coherence.note}
          </span>
        </p>
      )}
      {GROUPS.map(({ kind, heading }) => {
        const terms = missing.filter((term) => term.kind === kind);
        if (terms.length === 0) return null;
        return (
          <div key={kind} className="flex flex-col gap-1.5">
            <span className="text-xs text-content-tertiary">{heading}</span>
            <div className="flex flex-wrap gap-1.5">
              {terms.map((term) => (
                <AddPill
                  key={term.term}
                  label={missingTermLabel(term)}
                  onClick={() => onAdd(term)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
