// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * EditableField — the ONE shared inline-edit primitive.
 *
 * Renders in one of two modes:
 *   • read  — shows the current value (or a "not detected" placeholder when
 *             value is absent). Clicking the pencil icon enters edit mode.
 *   • edit  — inline <input> pre-filled with the current value; blurring or
 *             pressing Enter/Escape commits/cancels.
 *
 * Design rules (CLAUDE.md):
 *   – Semantic tokens only; no hardcoded hex or raw palette classes.
 *   – No raw <button> in feature code — this component owns the affordance so
 *     callers never need one.
 *   – Single affordance: reuse here, not a parallel component per field.
 *
 * Props:
 *   value       — current display value (may be empty/undefined when absent).
 *   placeholder — shown when value is empty, e.g. "not detected".
 *   label       — accessible label for the input (aria-label).
 *   onCommit    — called with the trimmed new string (or "" on clear).
 *   className   — extra classes on the root wrapper (layout stays with caller).
 */

import { useState, useRef, useCallback } from "react";

interface EditableFieldProps {
  value: string | undefined;
  placeholder?: string;
  label: string;
  onCommit: (newValue: string) => void;
  /** Extra classes on the root wrapper. */
  className?: string;
  /** Visual weight of the read-mode text. Defaults to "normal". */
  textWeight?: "normal" | "semibold";
  /** Text size of the read-mode text. Defaults to "sm". */
  textSize?: "xs" | "sm" | "base";
}

export function EditableField({
  value,
  placeholder = "not detected",
  label,
  onCommit,
  className,
  textWeight = "normal",
  textSize = "sm",
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback(() => {
    setDraft(value ?? "");
    setEditing(true);
    // Focus after the next paint so the input is mounted.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [value]);

  const commit = useCallback(() => {
    setEditing(false);
    onCommit(draft.trim());
  }, [draft, onCommit]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft(value ?? "");
  }, [value]);

  const hasValue = Boolean(value);

  const weightCls =
    textWeight === "semibold" ? "font-semibold" : "font-normal";
  const sizeCls =
    textSize === "xs" ? "text-xs" : textSize === "base" ? "text-base" : "text-sm";

  if (editing) {
    return (
      <span className={`inline-flex min-w-0 items-center gap-1 ${className ?? ""}`}>
        <input
          ref={inputRef}
          type="text"
          aria-label={label}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className={[
            "min-w-0 flex-1 rounded border border-border bg-surface-card px-1.5 py-0.5",
            sizeCls,
            weightCls,
            "text-content-primary",
            "outline-none focus:ring-1 focus:ring-brand-amber",
          ].join(" ")}
        />
      </span>
    );
  }

  return (
    <span
      className={`group inline-flex min-w-0 items-center gap-1 ${className ?? ""}`}
    >
      <span
        className={[
          sizeCls,
          weightCls,
          hasValue ? "text-content-primary" : "text-content-muted italic",
        ].join(" ")}
      >
        {hasValue ? value : placeholder}
      </span>
      {/* Pencil-icon edit button — owns the interactive affordance */}
      <button
        type="button"
        aria-label={`Edit ${label}`}
        onClick={startEdit}
        className="inline-flex shrink-0 items-center rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-amber text-content-muted hover:text-content-secondary"
      >
        {/* Pencil SVG — 12×12 */}
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086zM11.189 6.25 9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.25.25 0 0 0 .108-.064L11.19 6.25z" />
        </svg>
      </button>
    </span>
  );
}
