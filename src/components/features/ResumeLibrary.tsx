// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ResumeLibrary — the saved-resumes picker on the landing view (#322). Lists
 * saved resumes, surfaces the storage-persistence state + eviction transparency
 * copy with one-click export/import as the backup path, and shows approximate
 * space used. All local: resume bytes never leave the browser. Row rendering +
 * the delete confirm live in ResumeLibraryEntry; the merge/replace import
 * confirm lives in ResumeLibraryImportDialog; storage access is the
 * `useResumeLibrary` hook.
 *
 * Renders a minimal card even when the library is empty (#573): a fresh
 * browser, a new profile, a new device, or a post-eviction visit are ALL
 * empty-library states — the moment a user needs Import, and the moment an
 * early `return null` would hide the only control that helps.
 */

import { useState } from "react";
import { Card, Button, StatusBadge, InlineResult, ErrorState } from "@design-system";
import { formatBytes } from "../../lib/format-bytes.ts";
import { EVICTION_NOTICE } from "../../lib/storage/index.ts";
import type { ResumeLibrary as Library } from "../../hooks/useResumeLibrary.ts";
import { ResumeLibraryEntry } from "./ResumeLibraryEntry.tsx";
import {
  ResumeLibraryImportDialog,
  type ImportResult,
} from "./ResumeLibraryImportDialog.tsx";

/** Skipped-job reasons listed inline before the rest collapse into a count —
 *  enough to diagnose a systematic problem, short enough that a wholly corrupt
 *  file doesn't render a hundred-line status region. */
const MAX_LISTED_SKIPS = 3;

interface ResumeLibraryProps {
  library: Library;
  onLoad: (id: string) => void;
}

export function ResumeLibrary({ library, onLoad }: ResumeLibraryProps) {
  const {
    entries,
    ready,
    persisted,
    usageBytes,
    rename,
    remove,
    exportBackup,
    importBackup,
  } = library;
  const [importStatus, setImportStatus] = useState<ImportResult | null>(null);

  function handleImportResult(result: ImportResult) {
    setImportStatus(result);
  }

  // Nothing to show until the initial load resolves.
  if (!ready) return null;

  const importStatusRegion = importStatus && (
    <div aria-live="polite">
      {importStatus.kind === "success" ? (
        // A restore that skipped a record is not a plain success: the file held
        // jobs the capture contract refused (#693), and a count that only ever
        // grew would let them vanish without a trace. The tone follows the
        // skips, and the reasons are named so the user can fix the file.
        <InlineResult
          tone={importStatus.skippedJobs.length > 0 ? "warning" : "success"}
        >
          Restored {importStatus.resumes}{" "}
          {importStatus.resumes === 1 ? "resume" : "resumes"} and{" "}
          {importStatus.jobs} {importStatus.jobs === 1 ? "job" : "jobs"}.
          {importStatus.skippedJobs.length > 0 && (
            <>
              {" "}
              Skipped {importStatus.skippedJobs.length}{" "}
              {importStatus.skippedJobs.length === 1 ? "job" : "jobs"} this
              version can&apos;t read:
              <ul className="mt-1 list-disc pl-5">
                {importStatus.skippedJobs.slice(0, MAX_LISTED_SKIPS).map((job, i) => (
                  <li key={job.id ?? i}>
                    {job.title ?? job.id ?? "Untitled job"} — {job.reason}
                  </li>
                ))}
              </ul>
              {importStatus.skippedJobs.length > MAX_LISTED_SKIPS && (
                <>and {importStatus.skippedJobs.length - MAX_LISTED_SKIPS} more.</>
              )}
            </>
          )}
        </InlineResult>
      ) : (
        <ErrorState>{importStatus.message}</ErrorState>
      )}
    </div>
  );

  if (entries.length === 0) {
    return (
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-content-primary">
            Saved resumes
          </h2>
          <ResumeLibraryImportDialog
            importBackup={importBackup}
            entryCount={0}
            onResult={handleImportResult}
          />
        </div>
        <p className="text-sm text-content-tertiary">
          Saved only in this browser — no account, no sync. Restore a
          previously exported backup to bring your saved resumes back.
        </p>
        {importStatusRegion}
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-content-primary">
            Saved resumes
          </h2>
          <span className="text-sm text-content-muted">
            {entries.length}
            {usageBytes !== null && <> · {formatBytes(usageBytes)} used</>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge tone={persisted ? "ok" : "warning"}>
            {persisted ? "Persistent" : "Best-effort"}
          </StatusBadge>
          <ResumeLibraryImportDialog
            importBackup={importBackup}
            entryCount={entries.length}
            onResult={handleImportResult}
          />
          <Button variant="ghost" size="sm" onClick={() => void exportBackup()}>
            Export backup
          </Button>
        </div>
      </header>

      <p className="text-sm text-content-tertiary">
        Saved only in this browser — no account, no sync.{" "}
        {!persisted && EVICTION_NOTICE}
      </p>

      {importStatusRegion}

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
