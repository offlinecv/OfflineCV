// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ExternalBoardLinks — the "Search external boards" row of the job-search
 * workbench. Inert: each link is an ordinary `<a target="_blank">`, so the
 * navigation is the user's own and nothing here fetches. Only the query
 * keywords ride in the URL, never the résumé text.
 *
 * Split out of `FindJobsPanel` in the `/jobs/` move so the workbench file stays
 * a layout shell (same reason `JobResultCard` and `LevelSelect` were split).
 *
 * Not a `<Button>`: these are real cross-origin navigations, so an anchor is the
 * correct element — the design system's Button primitive renders a `<button>`
 * and would need a link-as-button escape hatch for no benefit.
 */

import type { JobBoardLink } from "../../lib/job-search/deep-links.ts";

export function ExternalBoardLinks({ links }: { links: readonly JobBoardLink[] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-content-tertiary">
        Search external boards
      </span>
      <div className="flex flex-wrap gap-2">
        {links.map((link) => (
          <a
            key={link.label}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-subtle focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
          >
            {link.label}
            <span aria-hidden="true">↗</span>
          </a>
        ))}
      </div>
      <p className="text-xs text-content-tertiary">
        Only your search keywords are sent, and only when you click a link above.
      </p>
    </div>
  );
}
