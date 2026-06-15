// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * UpdateBanner — non-blocking notice that a newer build is deployed.
 *
 * Presentational only; the detection lives in useUpdateChecker. Rendered at the
 * top of the app when a new version is available. We notify rather than reload
 * silently because the dropped PDF + parsed result are in-memory only.
 *
 * Domain-agnostic app chrome → shared tier. Composed from the Button primitive
 * and feedback-info semantic tokens; no raw <button> or hardcoded colors.
 */

import { Button } from "../ui/Button.tsx";

interface UpdateBannerProps {
  onReload: () => void;
  onDismiss: () => void;
}

export function UpdateBanner({ onReload, onDismiss }: UpdateBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-between gap-3 rounded-md border border-feedback-info-border bg-feedback-info-bg px-4 py-2.5 text-sm text-feedback-info-text"
    >
      <span>
        A new version of resumelint is available. Reload to get the latest.
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="primary" size="sm" onClick={onReload}>
          Reload
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="Dismiss update notice"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
