// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { Button, StatusBadge } from "@design-system";

// Helper to decide whether to show the "Edited" badge and "Reset to parsed"
// button. Extracted to keep ParsedHeader's cyclomatic count low.
function isEdited(isLlmRecovered: boolean, hasEdits: boolean): boolean {
  return !isLlmRecovered && hasEdits;
}

// "1 page" vs "N pages" — extracted so ParsedHeader avoids an inline ternary.
function pageCountLabel(pages: number): string {
  return pages === 1 ? "page" : "pages";
}

interface ParsedHeaderProps {
  isLlmRecovered: boolean;
  hasEdits: boolean;
  pages: number;
  elapsedMs: number;
  onResetAll: () => void;
  onReset: () => void;
}

export function ParsedHeader({
  isLlmRecovered,
  hasEdits,
  pages,
  elapsedMs,
  onResetAll,
  onReset,
}: ParsedHeaderProps) {
  return (
    <header className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <StatusBadge tone="ok">Parsed</StatusBadge>
        {isLlmRecovered && (
          <StatusBadge tone="info">Recovered with on-device AI</StatusBadge>
        )}
        {isEdited(isLlmRecovered, hasEdits) && (
          <StatusBadge tone="warning">Edited</StatusBadge>
        )}
        <span className="text-xs text-content-muted">
          {pages} {pageCountLabel(pages)} &middot;{" "}
          {elapsedMs} ms
        </span>
      </div>
      <div className="flex items-center gap-3">
        {isEdited(isLlmRecovered, hasEdits) && (
          <Button variant="link" onClick={onResetAll}>
            Reset to parsed
          </Button>
        )}
        <Button variant="link" onClick={onReset}>
          Try another file
        </Button>
      </div>
    </header>
  );
}
