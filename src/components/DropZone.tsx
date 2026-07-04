// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useCallback, useId, useRef, useState } from "react";
import {
  isAcceptedResumeFile,
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

  const handleFiles = useCallback(
    (files: FileList | null) => {
      setError(null);
      if (!files || files.length === 0) return;
      const f = files[0];
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
        handleFiles(e.dataTransfer.files);
      }}
      className={[
        "flex cursor-pointer flex-col items-center justify-center gap-2",
        "rounded-xl border-2 border-dashed px-6 py-12 text-center",
        "transition-colors",
        dragOver
          ? "border-content-primary bg-surface-hover"
          : "border-border hover:border-border-strong",
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
        onChange={(e) => handleFiles(e.target.files)}
      />
      <p className="text-sm font-medium">
        Drop a resume PDF or DOCX here, or click to pick one
      </p>
      <p className="text-xs text-content-muted">
        Your file stays in this browser tab.
      </p>
      {status && (
        <p className="mt-2 text-xs text-content-tertiary">
          {status}
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-feedback-error-text">{error}</p>
      )}
    </label>
  );
}
