// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * TargetingSection — role targeting, expected skills, and triage findings
 * folded into one collapsed disclosure between the contact block and the
 * résumé document (#825, #953).
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
 *    are detected, or "Targeting — your role and its expected skills" when clean.
 * 2. Addable-skill count badge via `Disclosure`'s `count` prop.
 * 3. The `warn` mark when no role has been picked.
 */

import { Disclosure } from "@design-system";
import { RolesPanel } from "./RolesPanel.tsx";
import {
  SkillTermGuidance,
  assessResumeSkills,
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
}: TargetingSectionProps) {
  const skills = assessResumeSkills(parsed);

  const hasSkillGuidance =
    skills.recognized.length > 0 ||
    skills.unrecognized.length > 0 ||
    skills.missing.length > 0;

  const flaggedBullets = bullets.filter(needsAttention).length;
  const missingContactCount = contactMissing.length;
  const hasBulletGap = flaggedBullets > 0;
  const hasContactGap = missingContactCount > 0;
  const hasTriage = hasBulletGap || hasContactGap;

  // Every child self-hides when it has nothing to say, so the guard has to be
  // about whether ANY of them will render — not about whether bullets exist.
  // A `bullets.length === 0` term used to sit here, which meant a résumé whose
  // bullets all PASS (bullets present, none flagged) with no titles and no
  // skill guidance opened a disclosure onto a literally empty box.
  if (titles.length === 0 && !hasSkillGuidance && !hasTriage) {
    return null;
  }

  const suggestions = skills.missing.length;
  const noRolePicked = !primary || primary.trim() === "";

  const triageHeadline = formatTriageHeadline(
    flaggedBullets,
    missingContactCount,
  );

  const summary = hasTriage ? (
    <span>
      Targeting & improvements
      <span className="ml-1.5 font-normal text-content-secondary">
        · {triageHeadline}
      </span>
    </span>
  ) : (
    "Targeting — your role and its expected skills"
  );

  return (
    <Disclosure
      summary={summary}
      count={suggestions}
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
