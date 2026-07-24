// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * SaveResumeBar — the "save this resume to your library" affordance shown under
 * a parsed result (#322). Saves the current (edited) parse + source bytes to
 * local storage so it can be reloaded later without re-uploading. A second save
 * updates the same record rather than minting a duplicate. Quiet, secondary
 * styling — the page's primary action stays the parse/score, not this.
 */

import { useState } from "react";
import { Button } from "@design-system";
import type { CascadeResult } from "../../lib/heuristics/types.ts";
import type { AnonymousAtsScore } from "../../lib/score/score.ts";
import type { ResumeLibrary } from "../../hooks/useResumeLibrary.ts";

interface SaveResumeBarProps {
  library: ResumeLibrary;
  fileName: string;
  bytes?: ArrayBuffer;
  sourceKind: "pdf" | "docx" | "markdown";
  result: CascadeResult;
  score: AnonymousAtsScore;
}

export function SaveResumeBar({
  library,
  fileName,
  bytes,
  sourceKind,
  result,
  score,
}: SaveResumeBarProps) {
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const id = await library.save({
        id: savedId ?? undefined,
        filename: fileName,
        bytes,
        sourceKind,
        result,
        score,
      });
      setSavedId(id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-light bg-surface-subtle px-4 py-3">
      <p className="text-sm text-content-secondary">
        {savedId === null
          ? "Keep this resume to reload later — saved only in this browser."
          : "Saved to your library on this browser."}
      </p>
      <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save()}>
        {saving
          ? "Saving…"
          : savedId === null
            ? "Save to library"
            : "Update saved copy"}
      </Button>
    </div>
  );
}
