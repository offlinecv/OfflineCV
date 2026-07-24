// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * RoleFamilyChips — removable chips for the résumé-derived role families
 * (#568), narrowing which of the classified `ROLE_FAMILIES`
 * (`role-keywords.ts`) the search keeps — so a fullstack résumé that also
 * matched `data` can drop `data` and keep only `fullstack`. Extracted out of
 * `FindJobsPanel` (already at the ~200 LOC gate) rather than grown inline.
 *
 * Reuses the `Chip` primitive's removable variant directly (not
 * `ChipListEditor`) because families are a FIXED, enum-only vocabulary —
 * there is no free-text add the way there is for titles/skills, so there's no
 * add-input to share.
 *
 * NEVER FAIL CLOSED (#568's own acceptance criterion): removing every chip
 * does not filter the search at all — `roleFilterForFamilies([])` is the same
 * permissive "all" filter `roleFilterForResume` already returns for an
 * unclassified résumé — so the row degrades to "no role narrowing" rather
 * than an empty panel, and says so.
 */

import { Chip } from "@design-system";
import type { RoleFamily } from "../../lib/job-search/role-keywords.ts";

interface RoleFamilyChipsProps {
  families: readonly RoleFamily[];
  onRemove: (family: RoleFamily) => void;
}

export function RoleFamilyChips({ families, onRemove }: RoleFamilyChipsProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-content-tertiary">Role</span>
      {families.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {families.map((family) => (
            <Chip
              key={family}
              onRemove={() => onRemove(family)}
              removeLabel={`Remove ${family}`}
            >
              {family}
            </Chip>
          ))}
        </div>
      ) : (
        <p className="text-xs text-content-tertiary">
          No role narrowing — searching every role.
        </p>
      )}
    </div>
  );
}
