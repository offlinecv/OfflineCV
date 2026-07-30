// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { useCallback, useId, useRef, useState } from "react";
import {
  isAcceptedResumeFile,
  extractDroppedFile,
  RESUME_ACCEPT_ATTR,
  RESUME_REJECT_HINT,
} from "../lib/file-accept.ts";

interface DropZoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
  /** Optional status line shown beneath the prompt (e.g. "Parsing…"). */
  status?: string;
}

export function DropZone({ onFile, disabled, status }: DropZoneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acceptFile = useCallback(
    (f: File | null) => {
      setError(null);
      if (!f) return;
      if (!isAcceptedResumeFile(f)) {
        setError(RESUME_REJECT_HINT);
        return;
      }
      onFile(f);
    },
    [onFile],
  );

  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled) return;
        // `extractDroppedFile` reads `dataTransfer.files` first and falls back to
        // `items[].getAsFile()` — some Linux/Chrome drags leave `.files` empty
        // and only expose the File through `items`, which looked like an accepted
        // drop that silently dropped the file.
        acceptFile(extractDroppedFile(e.dataTransfer));
      }}
      className={[
        "flex cursor-pointer flex-col items-center justify-center gap-2",
        "rounded-xl border-2 px-6 py-14 text-center",
        "transition-colors",
        // Accented at rest, not neutral (user testing, Jul 2026): the pre-drop
        // screen previously rendered every block on the same neutral surface,
        // so the one thing a first-time visitor must do did not read as the
        // primary action. This is now the only accent-bordered, accent-filled
        // surface above the fold — the hero above it is plain text.
        //
        // Drag feedback is dashed → solid, not colour alone: the border colour
        // is already accent at rest, so a colour-only drag state would be
        // invisible in a greyscale render (and to a red/green-blind user).
        dragOver
          ? "border-solid border-accent-primary bg-surface-hover"
          : "border-dashed border-accent-primary bg-accent-forward-bg hover:border-accent-primary-hover",
        disabled && "cursor-not-allowed opacity-60",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={RESUME_ACCEPT_ATTR}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
      />
      {/* Size/weight step is deliberate: this prompt has to out-rank the hero
          headline above it, and at `text-sm font-medium` it out-ranked nothing.
          The privacy line stays attached to the action it qualifies.

          On the repo's type scale, not beside it: `sm:text-xl` (20px) was the
          only `text-xl` in all of src/ — every other heading in the app steps
          14 → 16 → 18 → 24 → 30, so a lone 20px was an arbitrary size in the
          sense the Font Size Scale rule means. `sm:text-2xl` lands on the step
          the app already uses, and 24px is also what a 56px-padded box needs to
          stop reading as an empty panel with a caption. The hero headline is
          still one step above at `sm:text-3xl`; the drop zone leads on colour
          and fill, which is the contrast that survives a greyscale render. */}
      <p className="text-lg font-semibold text-content-primary sm:text-2xl">
        Drop your resume here
      </p>
      <p className="text-sm text-content-secondary">
        PDF or DOCX &middot; or click to pick a file
      </p>
      <p className="text-sm text-content-muted">
        Your file stays in this browser tab.
      </p>
      {status && (
        <p className="mt-2 text-sm text-content-tertiary">
          {status}
        </p>
      )}
      {error && (
        <p className="mt-2 text-sm text-feedback-error-text">{error}</p>
      )}
    </label>
  );
}
