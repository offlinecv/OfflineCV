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

export function QueryStepSection({
  title,
  hint,
  children,
}: {
  title: string;
  /** One line under the heading saying what this block changes. Omit when the
   *  fields say it themselves — an obvious hint is noise at heading weight. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-base font-semibold text-content-primary">{title}</h3>
        {hint != null && (
          <p className="max-w-prose text-sm text-content-secondary">{hint}</p>
        )}
      </div>
      {children}
    </div>
  );
}
