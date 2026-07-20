// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ResumeLibraryEntry — one saved-resume row in the library (#322): editable
 * filename, saved-time + score-at-save metadata, and load / delete actions.
 * Delete is confirm-gated (a load-bearing, data-losing action). Composed from
 * design-system primitives per the 3-tier rules; the list container and its
 * storage wiring live in ResumeLibrary.tsx.
 */

import { useState } from "react";
import { Button, EditableField, Dialog } from "@design-system";
import { timeAgo } from "../../lib/date-utils.ts";
import type { ResumeLibraryEntry as Entry } from "../../lib/resume-library.ts";

interface ResumeLibraryEntryProps {
  entry: Entry;
  onLoad: (id: string) => void;
  onRename: (id: string, filename: string) => void;
  onDelete: (id: string) => void;
}

export function ResumeLibraryEntry({
  entry,
  onLoad,
  onRename,
  onDelete,
}: ResumeLibraryEntryProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border-light bg-surface-subtle px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <EditableField
          value={entry.filename}
          placeholder="Untitled resume"
          emptyAffordance="plain"
          label="Resume name"
          onCommit={(next) => {
            const trimmed = next.trim();
            if (trimmed && trimmed !== entry.filename) onRename(entry.id, trimmed);
          }}
        />
        <p className="mt-0.5 flex items-center gap-2 text-xs text-content-muted">
          <span className="uppercase tracking-wider">{entry.sourceKind}</span>
          <span aria-hidden>·</span>
          <span>score {entry.scoreOverall}</span>
          <span aria-hidden>·</span>
          <span>saved {timeAgo(new Date(entry.savedAt).toISOString())}</span>
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => onLoad(entry.id)}>
          Load
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmingDelete(true)}
        >
          Delete
        </Button>
      </div>

      <Dialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete this saved resume?"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-content-secondary">
            <span className="font-medium text-content-primary">
              {entry.filename}
            </span>{" "}
            will be removed from this browser. This can&apos;t be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onDelete(entry.id);
                setConfirmingDelete(false);
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </li>
  );
}
