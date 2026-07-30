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
 * TWO PLACEMENTS, one component (#597) — and the split is what closed #595, which
 * reported the full-width block rendering two sections away from the fields its
 * pills write into. Adjacency is therefore a requirement here, not a preference:
 * passing `kind` puts ONE group inline under its own chip column, because the
 * suggestion pills belong beside the list they write into, not in a trailing
 * section at the foot of the page the user has to connect back up. Omitting `kind` keeps the original full-width block, which is
 * where the findings that are ABOUT the query as a whole live: the coherence
 * note and the dropped terms. The full-width mode is the only one that spans the
 * grid, so a column instance can never break its parent's layout.
 *
 * DROPPED TERMS (#597) are the chips that narrow nothing — the `noise` verdicts
 * `term-quality.ts` already produces, rendered with their `reason` VERBATIM.
 * There is no second scoring path and no new reason string: the glyph on the
 * chip said this already, but only as a mark and a tooltip, which is not an
 * answer to "why do my results look wrong". Only `noise` is listed, not `weak`:
 * a weak term still participates in local matching, so calling it dropped would
 * be false — and "weak" is the destructive verdict this lane is careful with
 * (`term-quality.ts`, STRONG NEEDS EVIDENCE; WEAK NEEDS STANDING).
 *
 * Renders nothing when it has nothing to say — `missing` empty AND no
 * coherence finding AND no dropped term, which covers the unresolved-role case where
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
import type {
  CoherenceFinding,
  MissingTerm,
  TermVerdict,
} from "../../lib/job-search/term-quality.ts";
import { AddPill } from "./ReconstructedAdd.tsx";

/** The display text for a missing term — the term itself for a title, or the
 *  skill's human label (falling back to the id) for a skill.
 *
 *  The label is the dictionary's `label` verbatim, which is also what a click
 *  appends to `query.skills` — so a pill and the chip it creates read
 *  identically, and both match the chips `deriveSkills` already produced. That
 *  only holds because every authored `label` is title-cased (#607); a lowercase
 *  one would render `+ people management` beside title-cased chips. */
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

/** The one heading over the dropped-term list. Names the consequence the
 *  verdicts' own `reason` strings then explain per term — the reasons stay
 *  verbatim from the lib, so this component still composes no per-term copy. */
const DROPPED_HEADING = "These terms aren't narrowing your search";

/** The copy this component composes itself — the group headings and the
 *  dropped-term heading. Per-term text is NOT here on purpose: `reason` and
 *  `note` come verbatim from `term-quality.ts`, which asserts its own strings.
 *  Exported so the denylist covers these too (`job-search-copy.test.ts`). */
export const TERM_ADVISORY_COPY: readonly string[] = [
  DROPPED_HEADING,
  ...GROUPS.map((group) => group.heading),
];

export function TermQualityAdvisory({
  missing = [],
  coherence,
  dropped = [],
  kind,
  onAdd,
}: {
  missing?: readonly MissingTerm[];
  /** A confident title/skill mismatch (#587), or `undefined` — the normal
   *  state, which renders nothing rather than an all-clear. */
  coherence?: CoherenceFinding;
  /** Verdicts to surface as dropped terms (#597). Only `noise` entries are
   *  rendered — see the docblock; the caller may pass the whole verdict list. */
  dropped?: readonly TermVerdict[];
  /** Set to render ONLY that group, inline under its own chip column (#597).
   *  Omit for the full-width block, the only mode that shows `coherence` and
   *  `dropped`. */
  kind?: MissingTerm["kind"];
  /** Called with the term the user clicked to add; `JobQueryEditor` maps it
   *  through {@link missingTermLabel} before writing it into the query, the
   *  same way this component renders it. */
  onAdd: (term: MissingTerm) => void;
}) {
  if (kind !== undefined) {
    const group = GROUPS.find((g) => g.kind === kind);
    const terms = missing.filter((term) => term.kind === kind);
    if (!group || terms.length === 0) return null;
    return <MissingGroup heading={group.heading} terms={terms} onAdd={onAdd} />;
  }

  const noise = dropped.filter((verdict) => verdict.quality === "noise");
  if (missing.length === 0 && !coherence && noise.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 sm:col-span-2 lg:col-span-3">
      {/* #587. The mark is decorative (it repeats what the sentence says, so
       *  colour and glyph are never the only carriers); the sr-only prefix is
       *  what gives the block an accessible name in the reading order. */}
      {coherence && (
        <p className="flex items-start gap-1.5 text-sm text-feedback-warning-text">
          <span aria-hidden="true">⚠︎</span>
          <span>
            <span className="sr-only">Check these terms: </span>
            {coherence.note}
          </span>
        </p>
      )}
      {/* The terms that reach nothing, said in words rather than only as the
       *  chip's `⚠︎` mark. `reason` is the lib's own string, verbatim. */}
      {noise.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-content-secondary">{DROPPED_HEADING}</span>
          <ul className="flex flex-col gap-0.5">
            {noise.map((verdict) => (
              <li
                key={`${verdict.kind}:${verdict.term}`}
                className="text-sm text-content-secondary"
              >
                <span className="text-content-secondary">{verdict.term}</span>
                {" — "}
                {verdict.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {GROUPS.map(({ kind: groupKind, heading }) => {
        const terms = missing.filter((term) => term.kind === groupKind);
        if (terms.length === 0) return null;
        return (
          <MissingGroup key={groupKind} heading={heading} terms={terms} onAdd={onAdd} />
        );
      })}
    </div>
  );
}

/** One heading + its add-pill row. Shared by both placements so the inline
 *  column and the full-width block cannot render the suggestion differently. */
function MissingGroup({
  heading,
  terms,
  onAdd,
}: {
  heading: string;
  terms: readonly MissingTerm[];
  onAdd: (term: MissingTerm) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-content-secondary">{heading}</span>
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
}
