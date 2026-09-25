// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * AuthoringResume — the from-scratch authoring lane's result surface: the
 * score readout and targeting that dock together, then the résumé.
 *
 * Reuse analysis: this is not a new surface. It is the block `App` rendered
 * inline for `state.phase === "authoring"`, lifted out unchanged so it can own
 * hooks. It needs them because it now mounts Fix It the same way `/` does
 * (#913): `useScoreFixIt` for the items and the mode, `FixItScope` for the
 * providers and the dock. Without them a flagged bullet here showed no marker
 * at all — the inline chips were gone and the tint reads a context this lane
 * never provided. `Result` is the only other mount, and it cannot be reused
 * here: it is built around a parsed file (recovery offer, local AI feedback,
 * the evidence section), none of which a résumé typed from scratch has.
 *
 * It diverges from `/` in the ways that follow from that:
 *  - no recovery offer (this lane never parsed a file, so nothing can be
 *    degenerate);
 *  - no `LocalAiFeedbackSection` (no `useResumeAnalysisLlm` controller is
 *    created on this branch);
 *  - no score `Card` around the readout: this lane never had one.
 *
 * `score: null` is the #313 reveal gate — the readout's slot stays empty until
 * contact and one role are filled in, with no placeholder, as it always has
 * here, and Fix It has nothing to step through until then either. The
 * targeting surface is visible throughout, which is the point: it is what
 * tells an author what to fill in next. `parseKey` moves only on a genuinely
 * new session (`authoring:<generation>`), which is the one moment the reveal
 * should fire again; keying on the score would re-expand on every field typed
 * in.
 */

import { Button, Card } from "@design-system";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { EditableParse } from "../../hooks/useEditableParse.ts";
import { useScoreFixIt } from "../../hooks/useFixItMode.ts";
import { isScoreRevealed } from "../../lib/contact.ts";
import { ScoreDetails } from "./ScoreDetails.tsx";
import { ResumeTargeting } from "./ResumeTargeting.tsx";
import { ReconstructedResume } from "./ReconstructedResume.tsx";
import { FixItScope } from "./FixItScope.tsx";

export function AuthoringResume({
  result,
  score,
  edit,
  parseKey,
  onBack,
}: {
  /** The edit-folded authored résumé (`displayResult`). */
  result: CascadeResult;
  /** The score graded from it (`edited.score`). */
  score: AnonymousAtsScore;
  edit: EditableParse;
  parseKey: unknown;
  onBack: () => void;
}) {
  const revealed = isScoreRevealed(result.canonical, edit.contactOverrides);
  const { items, fixIt } = useScoreFixIt(
    revealed ? score : null,
    result.canonical.fields,
    parseKey,
  );

  return (
    // The bottom padding is the room Fix It's dock covers, the same as on `/`
    // (#1002), so the last step can scroll clear of it.
    <div className="flex flex-col gap-4 pb-[var(--fixit-dock-clearance,0px)]">
      <div className="flex items-center justify-between">
        <Button variant="link" size="sm" onClick={onBack}>
          ← Back
        </Button>
      </div>
      {/* The same collapse group `/` builds (#955): the readout, and under it
          the targeting/triage surface, docking together. */}
      <ScoreDetails
        score={revealed ? score : null}
        resetKey={parseKey}
        guidanceCount={items.length}
        onEnterFixIt={fixIt.start}
      >
        <ResumeTargeting
          result={result}
          score={score}
          edit={edit}
          guidance={items}
        />
      </ScoreDetails>
      <FixItScope fixIt={fixIt} items={items}>
        {/* The same `Card` `ResultDetail` wraps the résumé in on `/`. #955
            took the chrome off `ContactCard` because that wrapper already
            drew it; without this one, a from-scratch résumé's contact block
            would be bare text on the page background. */}
        <Card className="shadow-xs">
          <ReconstructedResume result={result} score={score} edit={edit} />
        </Card>
      </FixItScope>
    </div>
  );
}
