// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * role-display — folding an experience role's field overrides into the values
 * the reconstructed résumé renders, and the read-only heading line.
 *
 * Pure and UI-free, the experience twin of `education-display`: the override
 * resolution, clearing, "Present" and label-joining branches are the
 * risk-bearing part of the role header, so they live here and are unit tested
 * directly, leaving `RoleHeader` render-only. `firstUndatedRoleIndex` is read by
 * both the Fix It guidance and `ExperienceSection` (#810), so "the first role
 * with no start date" means one thing in both places.
 */

import type { BulletExperience } from "../score/group-bullets.ts";
import type { ExperienceFieldOverrides } from "../../hooks/useEditableParse.ts";
import { resolveEduValue as resolve } from "./education-display.ts";
import {
  formatExperienceDateRange,
  normalizeExperienceDates,
} from "./experience-dates.ts";

/** The resolved role fields an editable header renders, after overrides. */
export interface RoleDisplay {
  title: string | undefined;
  company: string | undefined;
  location: string | undefined;
  team: string | undefined;
  startDate: string | undefined;
  /** "Present" for an ongoing role, whatever the stored end date says. */
  endDate: string | undefined;
}

/**
 * Fold a role's overrides into its display values ("" = cleared). Dates are
 * read as stored, not normalised: normalisation runs on commit
 * (`setExperienceField`), so the stored pair is already the normalised one and
 * undo/snapshots restore it rather than raw keystrokes.
 */
export function resolveRoleDisplay(
  exp: BulletExperience,
  overrides: ExperienceFieldOverrides | undefined,
): RoleDisplay {
  const ov = overrides ?? {};
  const isCurrent = ov.is_current ?? exp.is_current;
  return {
    title: resolve(exp.title, ov.title),
    company: resolve(exp.company, ov.company),
    location: resolve(exp.location, ov.location),
    team: resolve(exp.team, ov.team),
    startDate: resolve(exp.start_date, ov.start_date),
    endDate: isCurrent ? "Present" : resolve(exp.end_date, ov.end_date),
  };
}

/**
 * The first role, in the order given, that renders with no start date; -1 when
 * every role has one. This is the role Fix It's role-dates step lands on
 * (#810), and it is the ONE definition of it: the guidance orders the step in
 * front of this role's bullets, and `ExperienceSection` puts the step's anchor
 * on this role's header. Two copies of the predicate agreed only by
 * convention, and any drift would put the anchor on one role and the step in
 * front of another (#1004).
 *
 * `overridesAt(i)` supplies role `i`'s overrides; omit it when the roles
 * already have them folded in.
 */
export function firstUndatedRoleIndex(
  roles: readonly BulletExperience[],
  overridesAt: (i: number) => ExperienceFieldOverrides | undefined = () =>
    undefined,
): number {
  return roles.findIndex(
    (exp, i) => resolveRoleDisplay(exp, overridesAt(i)).startDate === undefined,
  );
}

/** Join the present parts with `sep`; `undefined` when none are. */
function join(sep: string, ...parts: (string | undefined)[]): string | undefined {
  return parts.filter(Boolean).join(sep) || undefined;
}

/**
 * The read-only heading: "Title — Company, Location · Team · dates".
 *
 * Location rides inline with the company, comma-joined, and the team trails
 * after a "·" — the Download PDF's "Company, Location · Team" header (#425).
 * Dates go through the #672 rule, so a role whose only date is an end date
 * reads the same here, in the edit card, and in the exported PDF.
 */
export function roleHeadingLabel(exp: BulletExperience): string {
  const org = join(" · ", join(", ", exp.company, exp.location), exp.team);
  const dates = formatExperienceDateRange(normalizeExperienceDates(exp));
  return join(" · ", join(" — ", exp.title, org), dates) ?? "Untitled role";
}
