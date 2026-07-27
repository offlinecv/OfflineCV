// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * RolesPanel — "which role are you targeting?" (#599). Renders the candidate's
 * derived role titles (most-recent-first) as `ChipListEditor` chips; clicking a
 * non-primary title promotes it, setting the `headline` override.
 *
 * WHY IT SITS WHERE IT SITS. This is the third beat of the page's decision zone
 * — what needs fixing (AttentionStrip), who you are (ContactCard), what you're
 * aiming at (here) — and it is immediately followed by `SkillTermGuidance`,
 * whose suggestions are a FUNCTION of the promoted title: that component runs
 * `buildJobQuery` → `deriveTitles`, whose `titles[0]` is this ★. Change the
 * star, the suggestions below change. Adjacency is what makes that causal;
 * separating them (the guidance used to render below the Skills section) left
 * the output four sections away from its own input.
 *
 * TWO CONSEQUENCES, NOT ONE — both are stated in the help copy because both are
 * true and neither is guessable: the promoted title is drawn under the name on
 * the downloaded PDF (`render-ats-pdf.ts` guards on `model.contact.headline`),
 * AND it is `titles[0]`, which `providers/keywords.ts` sends verbatim as the
 * feeds' `search=` param — the one audited resume-derived egress. Every other
 * title filters locally in `matchesQuery` and never leaves.
 *
 * The copy leads with the egress, and states it UNCONDITIONALLY (#605 review).
 * A `titles[0]` is sent whether or not the user picks anything — with no pick
 * it is the most-recent experience title — so copy reading "the picked title is
 * the only one sent" implies no pick means nothing is sent. Picking changes
 * WHICH title goes, not whether one does; only the PDF consequence is gated on
 * picking.
 *
 * NO DEFAULT ★ (#605 review). `primaryIndex` is undefined until a headline
 * actually exists — the parser's or the user's. Defaulting to index 0 starred
 * `titles[0]` on every résumé under copy saying it prints, while the export
 * drew nothing: only 8 of 54 corpus fixtures parse a headline at all.
 *
 * A headline that is not one of the chips is a real state, not a bug: the chip
 * list comes from `deriveTitles`, which splits a stacked tagline and dedups
 * against experience titles, so a user-typed headline ("Chief Widget Officer")
 * prints without matching any chip. That case gets its own line rather than
 * the "nothing prints" one, which would be a false claim.
 */

import { Card } from "@design-system";
import { ChipListEditor } from "./ChipListEditor.tsx";

interface RolesPanelProps {
  /** Distinct role titles, most-recent-first, from `deriveTitles`. */
  titles: string[];
  /** The currently chosen primary — the `headline` override, or undefined. */
  primary?: string;
  /** Commit a new primary (or "" to clear back to the parser's default). */
  onPrimaryChange: (value: string) => void;
}

export function RolesPanel({
  titles,
  primary,
  onPrimaryChange,
}: RolesPanelProps) {
  if (titles.length === 0) return null;

  const effectivePrimary = primary && primary.trim() ? primary.trim() : undefined;
  const matchedIndex =
    effectivePrimary === undefined ? -1 : titles.indexOf(effectivePrimary);
  const primaryIndex = matchedIndex >= 0 ? matchedIndex : undefined;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-content-primary">
          Which role are you targeting?
        </h2>
        <p className="max-w-prose text-sm text-content-tertiary">
          A single title is sent to the job feeds when you search. The rest stay
          on your device and just widen the matching. Pick one of your titles to
          make it that one — and to print it under your name on the PDF you
          download.
        </p>
      </div>

      <ChipListEditor
        label="Your role titles"
        labelHidden
        items={titles}
        primaryIndex={primaryIndex}
        onPromote={onPrimaryChange}
        primaryNoun="title"
      />

      {primaryIndex === undefined && (
        <p className="text-sm text-content-tertiary">
          {effectivePrimary === undefined ? (
            <>Nothing picked yet, so no role prints under your name.</>
          ) : (
            <>
              <span className="font-medium text-content-secondary">
                {effectivePrimary}
              </span>{" "}
              prints under your name right now. Pick a title above to replace
              it, or edit it directly in the card above.
            </>
          )}
        </p>
      )}
    </Card>
  );
}
