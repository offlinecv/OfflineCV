// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ResumeLibraryImportDialog — the "Import backup" trigger + merge/replace
 * confirm for restoring an `offlinecv-backup.json` file (#573). Lives beside
 * "Export backup" in ResumeLibrary, split into its own file to keep that
 * component under the ~200 LOC budget (CLAUDE.md).
 *
 * Picking a file always opens the confirm dialog — nothing imports on
 * `onChange` alone, since `replace` mode is destructive. Merge is the
 * default; replace must be chosen explicitly, and its label states how many
 * saved resumes it will delete (see the parent's `entryCount`). The dialog
 * stays open on failure (mirrors ReportDownloadControl) so the error stays
 * visible next to the retry affordance; it closes only on success, and the
 * outcome — success or error — is reported to the parent via `onResult` so it
 * can render the confirmation in place (no toast primitive in this repo).
 */

import { useId, useRef, useState } from "react";
import { Button, Dialog } from "@design-system";
import type { ResumeLibrary } from "../../hooks/useResumeLibrary.ts";
import type { SkippedJob } from "../../lib/storage/index.ts";

export type ImportResult =
  | { kind: "success"; resumes: number; jobs: number; skippedJobs: SkippedJob[] }
  | { kind: "error"; message: string };

interface ResumeLibraryImportDialogProps {
  importBackup: ResumeLibrary["importBackup"];
  /** Saved-resume count, for the replace-mode destructive copy. */
  entryCount: number;
  onResult: (result: ImportResult) => void;
}

type ImportMode = "merge" | "replace";

export function ResumeLibraryImportDialog({
  importBackup,
  entryCount,
  onResult,
}: ResumeLibraryImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [importing, setImporting] = useState(false);
  const modeName = useId();

  function handleFileChosen(picked: File | null) {
    // Reset immediately so picking the SAME file again next time still fires
    // `onChange` — the browser otherwise treats an unchanged value as a no-op.
    if (inputRef.current) inputRef.current.value = "";
    if (!picked) return;
    setFile(picked);
    setMode("merge");
  }

  function handleCancel() {
    setFile(null);
  }

  async function handleConfirm() {
    if (!file) return;
    setImporting(true);
    try {
      const counts = await importBackup(file, mode);
      onResult({ kind: "success", ...counts });
      setFile(null);
    } catch (err) {
      onResult({
        kind: "error",
        message: err instanceof Error ? err.message : "Import failed.",
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => inputRef.current?.click()}
      >
        Import backup
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
      />

      <Dialog
        open={file !== null}
        onClose={handleCancel}
        title="Restore from backup"
        className="max-w-sm"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-content-secondary">
            <span className="font-medium text-content-primary">
              {file?.name}
            </span>{" "}
            will restore saved resumes and tracked jobs into this browser.
          </p>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold uppercase tracking-wider text-content-muted">
              How to restore
            </legend>
            <label className="flex min-h-9 cursor-pointer items-start gap-2 text-sm text-content-secondary">
              <input
                type="radio"
                name={modeName}
                value="merge"
                checked={mode === "merge"}
                disabled={importing}
                onChange={() => setMode("merge")}
                className="mt-0.5 h-4 w-4 accent-accent-primary"
              />
              <span>
                <span className="font-medium text-content-primary">Merge</span>{" "}
                — add records from this file; everything already saved stays.
              </span>
            </label>
            <label className="flex min-h-9 cursor-pointer items-start gap-2 text-sm text-content-secondary">
              <input
                type="radio"
                name={modeName}
                value="replace"
                checked={mode === "replace"}
                disabled={importing}
                onChange={() => setMode("replace")}
                className="mt-0.5 h-4 w-4 accent-accent-primary"
              />
              <span>
                <span className="font-medium text-content-primary">
                  Replace
                </span>{" "}
                — delete {entryCount} saved{" "}
                {entryCount === 1 ? "resume" : "resumes"} and all tracked jobs,
                then restore only what's in this file. Can&apos;t be undone.
              </span>
            </label>
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={handleCancel} disabled={importing}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleConfirm()}
              disabled={importing}
            >
              {importing ? "Restoring…" : "Restore"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
