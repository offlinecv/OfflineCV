// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The two `JobQuery` fields that BOTH query editors render — the query form's
 * Narrow step (`JobQueryEditor`) and the results-side strip
 * (`JobResultRefineStrip`, #809).
 *
 * Extracted in the #905 review for the reason `withExcludeTerm` was extracted
 * one round earlier: once two surfaces write the same field, the rule for
 * writing it needs one definition. The exclude hint is the sharp end of that —
 * it states a real behavioural contract (title only, never the description),
 * so a copy of it that drifts from `filterPostingsByExcludeTerms` is a lie on
 * one of the two screens with nothing to catch it.
 *
 * These render the CONTROL only, never a `QueryStepSection` wrapper or a
 * layout — the two callers legitimately differ there (the form has a section
 * heading, the strip has an inline label beside the field), and hoisting that
 * would force one surface's layout onto the other.
 */

import { EditableField } from "@design-system";
import {
  withExcludeTerm,
  withoutExcludeTerm,
  type JobQuery,
} from "../../lib/job-search/query-builder.ts";
import { ChipListEditor } from "./ChipListEditor.tsx";

/** Whole-query replacement, the contract both editors already use — the panel
 *  owns the state and every control writes through this one setter. */
type QueryChange = (next: (q: JobQuery) => JobQuery) => void;

/** The one statement of what exclusion actually does. Shown by both editors. */
export const EXCLUDE_TERMS_HINT =
  "A posting is dropped when its title contains one of these — its description is not checked.";

export function LocationField({
  query,
  onChange,
}: {
  query: JobQuery;
  onChange: QueryChange;
}) {
  return (
    <EditableField
      value={query.location}
      placeholder="location"
      label="Location"
      onCommit={(v) => onChange((q) => ({ ...q, location: v || undefined }))}
    />
  );
}

export function ExcludeTermsEditor({
  query,
  onChange,
}: {
  query: JobQuery;
  onChange: QueryChange;
}) {
  return (
    <ChipListEditor
      label="Excluded titles"
      labelHidden
      items={query.excludeTerms ?? []}
      onAdd={(term) => onChange((q) => withExcludeTerm(q, term))}
      onRemove={(term) => onChange((q) => withoutExcludeTerm(q, term))}
      placeholder="Add a title to exclude…"
      addAriaLabel="Add exclude term"
    />
  );
}
