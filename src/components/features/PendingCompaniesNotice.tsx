// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * PendingCompaniesNotice — "you selected companies these results don't include".
 *
 * Removing a company target updates the results live (`useJobSearch` filters the
 * snapshot), but ADDING one can't: the last fetch has none of that board's
 * postings. Two ways to resolve that gap, and this is the honest one — say the
 * results are behind the selection and offer the fetch — rather than either
 * silently refetching on a checkbox click (the panel promises keywords leave only
 * on a Search click) or leaving the user to guess why the new company produced
 * nothing.
 *
 * Names the companies instead of counting them: "Ramp, Vanta" tells the user
 * whether the pending set is the one they just clicked, which "+2 companies"
 * doesn't. The list is bounded by the company picker itself (14, `COMPANY_LIMIT`).
 *
 * Rendered only over an existing result set — before the first search EVERY
 * selected company is unsearched, which is not news.
 */

import { Button, StatusBadge } from "@design-system";
import type { CompanyEntry } from "../../lib/job-search/company-registry.ts";

export function PendingCompaniesNotice({
  companies,
  onSearch,
  isUpdating,
}: {
  companies: readonly CompanyEntry[];
  onSearch: () => void;
  /** True while the incremental fetch runs — the results below stay visible. */
  isUpdating: boolean;
}) {
  if (companies.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border-light bg-surface-subtle px-3 py-2">
      <StatusBadge tone="info">not searched yet</StatusBadge>
      <p className="min-w-0 text-sm text-content-secondary">
        These results don&apos;t include{" "}
        {companies.map((entry) => entry.name).join(", ")}.
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto"
        onClick={onSearch}
        disabled={isUpdating}
      >
        {isUpdating ? "Adding…" : "Add to results"}
      </Button>
    </div>
  );
}
