// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * HeadlineField — the tagline line under the name (#599): the user's chosen
 * primary role when one is set, otherwise the standalone title the parser
 * lifted from the profile block. Rendered as its own component rather than inline in `ContactCard`
 * because the gated-vs-editable-vs-absent branching is what pushed the card's
 * cognitive complexity past the bar, and in its own file since the `bare` form
 * pushed `ContactCard` past the repo's ~200 LOC budget.
 *
 * Renders nothing when there is no headline AND the card is display-only — a
 * blank editable slot is the affordance that lets a user add one, but on a
 * read-only card it would just be dead space. An editable card with no headline
 * renders it `bare` into `ContactDetails`' add row instead of a line of its own,
 * which would sit blank between the name and the contact line at rest.
 */

import { EditableField } from "@design-system";
import { headlineRoundTripWarning } from "../../lib/edit/headline.ts";

export function HeadlineField({
  shown,
  editable,
  bare = false,
  onCommit,
}: {
  shown: string | undefined;
  editable: boolean;
  bare?: boolean;
  onCommit: (value: string) => void;
}) {
  if (!editable) {
    return shown ? (
      <div className="mt-1 text-sm font-normal text-content-muted">{shown}</div>
    ) : null;
  }
  const field = (
    <EditableField
      value={shown}
      placeholder="headline"
      label="Headline"
      textSize="sm"
      textWeight="normal"
      onCommit={onCommit}
      validate={headlineRoundTripWarning}
    />
  );
  return bare ? (
    field
  ) : (
    <div className="mt-1 text-sm font-normal text-content-muted">{field}</div>
  );
}
