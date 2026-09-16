// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * QueryStepSection — a titled block inside one step of the `/jobs/` query form
 * (#602).
 *
 * WHY IT EXISTS. Every label on the pre-#602 form — "Titles", "Skills",
 * "Location", "Target level", the advisory headings — was rendered at the same
 * `text-sm text-content-tertiary` as the body copy beneath it. With no weight,
 * size or colour step anywhere, the page had ~40 chips and zero headings: no
 * scanning order, and nothing for a screen reader's heading navigation to land
 * on either. This is the one heading level the form uses, so the step of one
 * block cannot drift from the next.
 *
 * Feature-local rather than a `@design-system` export: it is a heading + hint
 * pair for one form's steps, and the shared layer already owns the generic
 * surface chrome (`Card`). Promote it only when a second lane needs it.
 *
 * Renders a real `<h3>` (the page's `<h1>` is the site header and each step's
 * rail entry is its `<h2>`-equivalent label), so the outline is ordered rather
 * than styled text pretending to be one.
 */

import type { ReactNode } from "react";

/** "Location" + "narrow results" → "Location (narrow results)"; no context, no
 *  suffix, so a name is byte-identical to before when only one surface is up.
 *  The ONE rule for telling two mounted copies of a control apart, used by the
 *  headings here and by every control name in `QueryFilterFields` (#905
 *  review) — two spellings of the suffix would put the heading and the field
 *  under it in different "places". */
export function accessibleName(name: string, context: string | undefined): string {
  return context ? `${name} (${context})` : name;
}

export function QueryStepSection({
  title,
  hint,
  context,
  children,
}: {
  title: string;
  /** One line under the heading saying what this block changes. Omit when the
   *  fields say it themselves — an obvious hint is noise at heading weight. */
  hint?: string;
  /** Where this section sits, for the heading's accessible name only — the
   *  results strip and the form's Narrow step can both be mounted, and a
   *  screen reader navigating by heading then hears "Exclude" twice with
   *  nothing telling them apart (#905 review). Visually hidden: the page
   *  already shows which surface the heading belongs to. */
  context?: string;
  children: ReactNode;
}) {
  // The heading's text IS `accessibleName(title, context)`; only the suffix is
  // hidden from sight.
  const name = accessibleName(title, context);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-base font-semibold text-content-primary">
          {title}
          {name !== title && <span className="sr-only">{name.slice(title.length)}</span>}
        </h3>
        {hint != null && (
          <p className="max-w-prose text-sm text-content-secondary">{hint}</p>
        )}
      </div>
      {children}
    </div>
  );
}
