// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ContactWorkAuthorization — the "+ Add work authorization" entry point on the
 * editable contact card (#792).
 *
 * Why this exists at all: `work_authorization` is an OPTIONAL contact row, and
 * `buildContactFields` hides an optional row that was not detected. That is the
 * right policy call — an absent work-authorization statement must never render
 * as a gap, because penalising silence about immigration status is not a
 * defensible thing for this product to do — but it leaves the field unreachable
 * for the very users who need it: someone whose résumé never stated it has no
 * row to click. So the editable card carries a dedicated affordance, rendered
 * only while the value is absent. Once a value exists it renders (and edits)
 * inline on the contact line like every other contact field, and this component
 * steps out of the way.
 *
 * Reuse analysis: no new markup pattern. It composes `InlineBulletAdd` — the
 * shared `AddPill`-collapsed, single-line text-add affordance from
 * `ReconstructedAdd` — rather than re-rolling an input. Deliberately NOT
 * `ProfileLinkAdd`: that is a URL field whose add path rejects anything
 * `classifyProfile` cannot parse, which is how "US Citizen" used to be
 * swallowed (#790). This is free text and accepts the sentence as written.
 */

import { InlineBulletAdd } from "./ReconstructedAdd.tsx";

export function ContactWorkAuthorization({
  onAdd,
}: {
  /** Commit the entered statement, verbatim, onto the `work_authorization`
   *  contact override. */
  onAdd: (value: string) => void;
}) {
  return (
    <div className="mt-2 flex justify-center">
      <InlineBulletAdd
        onAdd={onAdd}
        label="Add work authorization"
        placeholder="e.g. US Citizen (optional)"
      />
    </div>
  );
}
