// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * TargetingSection — role targeting, expected skills, and triage findings
 * folded into one collapsed disclosure (#825, #953), mounted INSIDE THE SCORE
 * CARD since #955 — in `ScoreDetails`' details region, first, above the
 * recovery offer and the local-AI feedback, docking away with the score
 * readout.
 *
 * It sat between the contact block and the résumé document until #955, inside
 * `ReconstructedResume`. The card boundary was the problem: the score card
 * read `93/100 · STRONG` while this one read `10 bullets need attention` —
 * two verdicts on the same résumé with no stated relationship. In one card
 * the score and the reason it is not 100 are a single statement, and the
 * journey rail's `Fix it` stage has one place to land. Nothing in this file
 * changed for the move; its props are derived by `ResumeTargeting` now, by the
 * same helpers `ReconstructedResume` used — one seam, because the from-scratch
 * authoring lane renders no score card and has to mount this section itself.
 * One consequence outside it: the triage row's contact jump link points DOWN
 * from here — see `TargetingTriageRow`.
 *
 * `RolesPanel` ("Which role are you targeting?"), `SkillTermGuidance`
 * ("Skills this role usually asks for"), and the triage signals (bullets
 * needing attention, missing contact fields) are the key improvement guides
 * for the resume.
 *
 * In #953, the attention strip was merged into this disclosure. Moving triage
 * findings here eliminates the banner above the contact card, so the
 * candidate's name sits immediately beneath the score bar without losing
 * visibility into what needs fixing.
 *
 * The summary row displays:
 * 1. "Targeting & improvements" with bullet/contact triage callouts when issues
 *    are detected; "Targeting — your role and its expected skills" plus an
 *    explicit all-clear line naming the bullet count when there are bullets,
 *    none is flagged and no contact field is missing (#957 — the confirmation
 *    `AttentionStrip` used to carry, dropped silently when #953 moved triage
 *    content in here); or the plain label alone when there is nothing to
 *    report either way. With nothing to open onto, the all-clear renders as a
 *    standalone `InlineResult` strip instead of a disclosure.
 * 2. Addable-skill count badge via `Disclosure`'s `count` prop.
 * 3. The `warn` mark when no role has been picked.
 */

import { Disclosure, InlineResult } from "@design-system";
import { RolesPanel } from "./RolesPanel.tsx";
import {
  SkillTermGuidance,
  assessResumeSkills,
  showsSkillsOrder,
} from "./SkillTermGuidance.tsx";
import {
  TargetingTriageRow,
  formatTriageHeadline,
} from "./TargetingTriageRow.tsx";
import type { ResumeQueryInput } from "../../lib/job-search/query-builder.ts";
import type { SkillsReorderController } from "../../hooks/useSkillsReorder.ts";
import type { BulletObservation } from "../../lib/score/score.ts";
import { needsAttention } from "../../lib/score/group-bullets.ts";
import type { ContactDisplayField } from "../../lib/contact.ts";

interface TargetingSectionProps {
  /** Distinct role titles, most-recent-first, from `deriveTitles`. */
  titles: string[];
  /** The currently chosen primary — the `headline` override, or undefined. */
  primary?: string;
  /** Commit a new primary (or "" to clear back to the parser's default). */
  onPrimaryChange: (value: string) => void;
  /** The current parse — same shape `FindJobsPanel` feeds `buildJobQuery`. */
  parsed: ResumeQueryInput;
  /** `useEditableParse.addSkill` — the only way a suggestion reaches the résumé. */
  onAddSkill: (skill: string) => void;
  /** Skills-ordering coaching (#544) — forwarded straight to
   *  `SkillTermGuidance`, which hosts the row. */
  skillsOrder?: SkillsReorderController;
  /** Graded bullets across the entire résumé. */
  bullets?: readonly BulletObservation[];
  /** Missing contact fields from contactCompleteness. */
  contactMissing?: ContactDisplayField[];
  /** Forwarded to `Disclosure`. The caller decides, because only the caller
   *  knows whether an ancestor already draws a border: `Result` mounts this
   *  inside the score `Card` and passes `"plain"`; the authoring lane has no
   *  card around it and keeps the default `"card"` (#680 item 8). */
  variant?: "card" | "plain";
}

export function TargetingSection({
  titles,
  primary,
  onPrimaryChange,
  parsed,
  onAddSkill,
  skillsOrder,
  bullets = [],
  contactMissing = [],
  variant = "card",
}: TargetingSectionProps) {
  const skills = assessResumeSkills(parsed);

  const showSkillsOrder = showsSkillsOrder(skillsOrder);

  const hasSkillGuidance =
    skills.recognized.length > 0 ||
    skills.unrecognized.length > 0 ||
    skills.missing.length > 0 ||
    showSkillsOrder;

  const flaggedBullets = bullets.filter(needsAttention).length;
  const missingContactCount = contactMissing.length;
  const hasBulletGap = flaggedBullets > 0;
  const hasContactGap = missingContactCount > 0;
  const hasTriage = hasBulletGap || hasContactGap;

  // Every child self-hides when it has nothing to say, so the guard has to be
  // about whether ANY of them will render — not about whether bullets exist.
  // A guard keyed on bullets would open a disclosure onto a literally empty
  // box for a résumé whose bullets all PASS (bullets present, none flagged)
  // with no titles and no skill guidance.
  //
  // `hasBody` is that question asked directly, one term per child, instead of
  // inferred: `TargetingTriageRow` is gated on `hasTriage` below,
  // `titles.length > 0` is exactly `RolesPanel`'s non-null condition, and
  // `hasSkillGuidance` covers both `SkillTermGuidance`'s vocabulary matching
  // and its skills-ordering coaching (#972). Deriving the guard from the
  // children at all is the point: a fourth child must still be added to this
  // disjunction by hand, but each term restates a child's own null condition,
  // so a stale one is visible rather than inferred.
  const hasBody = hasTriage || titles.length > 0 || hasSkillGuidance;

  const suggestions = skills.missing.length;
  const noRolePicked = !primary || primary.trim() === "";

  const triageHeadline = formatTriageHeadline(
    flaggedBullets,
    missingContactCount,
  );

  // Mirrors the old `AttentionStrip`'s all-clear line, which fired only when
  // BOTH the bullet and contact checks were clean — a résumé with a contact
  // gap but no flagged bullets stays silent about bullets here too, same as
  // it always has (`TargetingTriageRow`'s bullet segment already self-hides
  // in that case).
  // One definition, two render paths (summary chip and standalone strip), so
  // the copy cannot drift — the treatment does differ: a chrome-less span on
  // the summary row, a bordered `InlineResult` standalone. Singular takes
  // "passes": `TargetingTriageRow`'s own docblock documents this same English
  // trap one function over ("1 bullet NEEDS attention" vs "2 bullets NEED"),
  // and the pre-#956 `AttentionStrip` string this restores got it wrong.
  const allClearLine =
    bullets.length === 1
      ? "All 1 bullet passes every check"
      : `All ${bullets.length} bullets pass every check`;

  const allBulletsClear = !hasTriage && bullets.length > 0;

  // Nothing to say at all, and nothing to open onto.
  if (!hasBody && !allBulletsClear) return null;

  // Something to say, but no body behind it: the all-clear line is the whole
  // message, so it renders as a standalone `InlineResult` strip rather than as
  // a `Disclosure` whose triangle opens onto ~24px of blank card. #956's rule
  // — "a disclosure with nothing to say is worse than no disclosure" — is
  // about the BODY, so the fix is to drop the disclosure, not the confirmation
  // (#957 AC2).
  if (!hasBody) {
    return (
      <InlineResult tone="success" className="text-sm text-feedback-success-text">
        {allClearLine}
      </InlineResult>
    );
  }

  const summary = hasTriage ? (
    <span>
      Targeting & improvements
      <span className="ml-1.5 font-normal text-content-secondary">
        · {triageHeadline}
      </span>
    </span>
  ) : allBulletsClear ? (
    <span>
      Targeting — your role and its expected skills
      <span className="ml-1.5 font-normal text-feedback-success-text">
        · {allClearLine}
      </span>
    </span>
  ) : (
    "Targeting — your role and its expected skills"
  );

  return (
    <Disclosure
      summary={summary}
      count={suggestions}
      variant={variant}
      // Gated on there being a picker to act on. `RolesPanel` returns null
      // without titles, so a résumé with no derivable titles but flagged
      // bullets opens onto the triage row alone — and an ungated mark would
      // then point at a control that is not in the disclosure (#956 review).
      // The old `titles.length === 0` guard above made this unreachable.
      warn={titles.length > 0 && noRolePicked}
      warnLabel="no role picked, so none prints on your PDF"
    >
      <div className="flex flex-col gap-6">
        {hasTriage && (
          <TargetingTriageRow
            bullets={bullets}
            contactMissing={contactMissing}
            hasBulletGap={hasBulletGap}
            hasContactGap={hasContactGap}
          />
        )}
        <RolesPanel
          titles={titles}
          primary={primary}
          onPrimaryChange={onPrimaryChange}
        />
        <SkillTermGuidance
          parsed={parsed}
          onAddSkill={onAddSkill}
          skillsOrder={skillsOrder}
        />
      </div>
    </Disclosure>
  );
}
