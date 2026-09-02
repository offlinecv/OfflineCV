// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobResultRefineStrip — the narrowing controls, rendered WITH the results
 * instead of only inside the folded query form (#809).
 *
 * WHY IT EXISTS. Three respondents in the Aug 2026 round reported the same
 * thing: the search returns postings they did not ask for and nothing they can
 * reach makes it stop. The controls that would have stopped it already
 * existed — role chips, exclude terms and target level all live in
 * `JobQueryEditor`'s steps — but the moment Search is clicked `FindJobsPanel`
 * folds the whole form to a one-line summary, so at the exact moment a user has
 * a result set to react to, every narrowing lever is behind an "Edit search"
 * button, inside a four-step walk, on a step they have to pick. Nobody found
 * them. This strip puts the three highest-value levers one interaction from the
 * results view, which is the #809 acceptance criterion stated literally.
 *
 * NOT A SECOND SURFACE. It edits the SAME `JobQuery` the form does, through the
 * same `onChange`, and renders the SAME controls the form does — `LevelSelect`
 * and, since the #905 review, `LocationField`/`ExcludeTermsEditor` out of
 * `QueryFilterFields.tsx`, so the exclude hint has one definition rather than a
 * copy per surface. A chip removed here is gone from the form's Narrow step
 * too, because there is one query. Every edit re-ranks
 * through `refineSearchResult` via `useJobSearch`'s live-re-rank effect, so
 * nothing here fetches and nothing here egresses: `providers/keywords.ts` stays
 * the sole resume-derived egress helper, untouched by this file.
 *
 * WHY THESE THREE. Level answers the fresher case (#809 case 3) — a candidate
 * with no prior title has nothing for `SENIORITY_PATTERNS` to derive from, and
 * in the form the level control is hidden behind an `AddPill` that only appears
 * once a level WAS derived, i.e. never for them. Here it is always visible.
 * Local-only answers the near-locality case (case 2). Exclude answers the
 * off-role case (case 1) with the bluntest instrument the lane has. Comp floor
 * and the company boards are deliberately absent: the floor is soft by design
 * (#564) so it belongs with the query, and adding a board needs a fetch, which
 * this strip must never trigger.
 */

import { Card, Checkbox } from "@design-system";
import type { JobQuery } from "../../lib/job-search/query-builder.ts";
import { LevelSelect } from "./LevelSelect.tsx";
import {
  EXCLUDE_TERMS_HINT,
  ExcludeTermsEditor,
  LocationField,
} from "./QueryFilterFields.tsx";
import { QueryStepSection } from "./QueryStepSection.tsx";

/** The toggle's label, which must name the place it filters on so the user can
 *  check it against what they typed. Kept beside the strip's other copy for the
 *  same reason `query-steps.ts` centralises its own: consequence only. */
function localOnlyLabel(location: string | undefined): string {
  return location ? `Only jobs near ${location}` : "Only jobs near me";
}

const LOCAL_ONLY_HINT =
  "Remote postings always stay — this hides the ones tied to somewhere else.";

const NO_LOCATION_HINT =
  "Add a location above to turn this on.";

export function JobResultRefineStrip({
  query,
  onChange,
}: {
  query: JobQuery;
  /** Same whole-query replacement contract as `JobQueryEditor` — the panel owns
   *  the state, and both editors write through this one setter. */
  onChange: (next: (q: JobQuery) => JobQuery) => void;
}) {
  const hasLocation = (query.location ?? "").trim().length > 0;

  return (
    <Card className="flex flex-col gap-4">
      <QueryStepSection
        title="Narrow these results"
        hint="Changes apply straight away, without searching again."
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-content-secondary">Location</span>
          <LocationField query={query} onChange={onChange} />
        </div>
        {/* Disabled rather than hidden while no location is set: a control that
         *  vanishes teaches nothing, and the hint names the field to fill in.
         *  `locationOnly` is left as-is when disabled — a user who clears their
         *  location and retypes it gets their toggle back rather than a silent
         *  reset. `refineSearchResult` ignores the flag without a location, so
         *  the retained state cannot filter anything in the meantime. */}
        <Checkbox
          checked={query.locationOnly === true}
          onChange={(checked) =>
            onChange((q) => ({ ...q, locationOnly: checked || undefined }))
          }
          label={localOnlyLabel(query.location)}
          hint={hasLocation ? LOCAL_ONLY_HINT : NO_LOCATION_HINT}
          disabled={!hasLocation}
        />
      </QueryStepSection>

      {/* Always shown, unlike the form's `AddPill`-gated copy — see the
       *  docblock: the gate's condition is exactly the fresher it excludes. */}
      <QueryStepSection
        title="Level"
        hint="Postings far from this level rank lower. Nothing is hidden by level."
      >
        <LevelSelect
          value={query.seniority}
          onChange={(seniority) => onChange((q) => ({ ...q, seniority }))}
        />
      </QueryStepSection>

      <QueryStepSection title="Exclude" hint={EXCLUDE_TERMS_HINT}>
        <ExcludeTermsEditor query={query} onChange={onChange} />
      </QueryStepSection>
    </Card>
  );
}
