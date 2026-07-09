// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ResumeLibrary — the saved-resumes picker on the landing view (#322). Lists
 * saved resumes, surfaces the storage-persistence state + eviction transparency
 * copy with a one-click export as the backup path, and shows approximate space
 * used. All local: resume bytes never leave the browser. Row rendering + the
 * delete confirm live in ResumeLibraryEntry; storage access is the
 * `useResumeLibrary` hook. Renders nothing when the library is empty.
 */

import { Card, Button, StatusBadge } from "@design-system";
import { formatBytes } from "../../lib/format-bytes.ts";
import { EVICTION_NOTICE } from "../../lib/storage/index.ts";
import type { ResumeLibrary as Library } from "../../hooks/useResumeLibrary.ts";
import { ResumeLibraryEntry } from "./ResumeLibraryEntry.tsx";

interface ResumeLibraryProps {
  library: Library;
  onLoad: (id: string) => void;
}

export function ResumeLibrary({ library, onLoad }: ResumeLibraryProps) {
  const { entries, ready, persisted, usageBytes, rename, remove, exportBackup } =
    library;

  // Nothing to show until at least one resume is saved.
  if (!ready || entries.length === 0) return null;

  return (
    <Card className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-content-primary">
            Saved resumes
          </h2>
          <span className="text-xs text-content-muted">
            {entries.length}
            {usageBytes !== null && <> · {formatBytes(usageBytes)} used</>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge tone={persisted ? "ok" : "warning"}>
            {persisted ? "Persistent" : "Best-effort"}
          </StatusBadge>
          <Button variant="ghost" size="sm" onClick={() => void exportBackup()}>
            Export backup
          </Button>
        </div>
      </header>

      <p className="text-xs text-content-tertiary">
        Saved only in this browser — no account, no sync.{" "}
        {!persisted && EVICTION_NOTICE}
      </p>

      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <ResumeLibraryEntry
            key={entry.id}
            entry={entry}
            onLoad={onLoad}
            onRename={(id, filename) => void rename(id, filename)}
            onDelete={(id) => void remove(id)}
          />
        ))}
      </ul>
    </Card>
  );
}
