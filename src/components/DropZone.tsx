// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { useCallback, useId, useRef, useState } from "react";

interface DropZoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
  /** Optional status line shown beneath the prompt (e.g. "Parsing…"). */
  status?: string;
}

function isPdf(f: File): boolean {
  return (
    f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
  );
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
      if (!isPdf(f)) {
        setError("That doesn't look like a PDF. Please drop a .pdf file.");
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
        accept="application/pdf,.pdf"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
      />
      <p className="text-sm font-medium">
        Drop a resume PDF here, or click to pick one
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
