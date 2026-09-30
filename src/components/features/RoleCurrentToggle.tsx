// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * RoleCurrentToggle — the "Current role" checkbox on an experience role's
 * date rail (#686).
 *
 * `RoleHeader.tsx` and `ReconstructedRole.tsx` are both already past the
 * ~200-LOC guideline (known debt); this sits in its own sibling file rather
 * than growing either. Owns nothing but the `Checkbox` primitive itself and
 * the disabled reasoning — the commit goes straight back through
 * `RoleHeader`'s existing `onFieldChange("is_current", …)` seam, and the pair
 * rule that decides what ticking/unticking actually MEANS lives in
 * `lib/edit/experience-dates.ts`, not here.
 *
 * Edit chrome (`styles/edit-chrome.css`): the box is a pure editing
 * affordance — it never itself appears in the exported PDF, only the
 * "Present" text it produces does — so it rests hidden at rest like the
 * role's other controls (Rewrite trigger, Remove) and reveals on hover/focus
 * of the role's `edit-scope`, or always on a coarse pointer.
 */

import { Checkbox } from "@design-system";

export interface RoleCurrentToggleProps {
  checked: boolean;
  /** No start date to anchor "ongoing" against — `normalizeExperienceDates`
   *  drops an unanchored `is_current` anyway, so the box is disabled rather
   *  than left to produce a claim the pair rule immediately discards. */
  disabled: boolean;
  onChange: (checked: boolean) => void;
}

export function RoleCurrentToggle({
  checked,
  disabled,
  onChange,
}: RoleCurrentToggleProps) {
  return (
    <Checkbox
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      label="Current role"
      hint='Draws "Present" instead of an end date'
      className="edit-chrome"
    />
  );
}
