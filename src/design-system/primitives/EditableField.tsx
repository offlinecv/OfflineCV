// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * EditableField — the ONE shared inline-edit primitive.
 *
 * Renders in one of two modes:
 *   • read  — shows the current value (or a "not detected" placeholder when
 *             value is absent). Clicking the pencil icon enters edit mode.
 *   • edit  — inline <input> (default) or auto-growing <textarea> (multiline)
 *             pre-filled with the current value.
 *             Single-line: blurring or pressing Enter/Escape commits/cancels.
 *             Multiline: explicit Save / Cancel buttons; blur does NOT commit
 *             (a multi-line paste that accidentally defocuses shouldn't lose
 *             the draft). Enter submits a newline; Escape cancels.
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
 *   multiline   — opt-in: renders a full-width auto-growing <textarea> with an
 *                 explicit Save / Cancel action row. ADDITIVE — existing
 *                 single-line callers are byte-for-byte unchanged.
 *   onRework    — opt-in (multiline only): renders a "Rework" action in the
 *                 Save/Cancel row. The callback receives the current draft text
 *                 so the caller can trigger AI rewrite on the live draft.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "./Button.tsx";

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
  /**
   * How the edit affordance is revealed in read mode:
   *   reserve — pencil always occupies layout (opacity-0 → visible on hover).
   *             Keeps the affordance focusable; no layout shift. Default.
   *   hover   — pencil takes no layout space until hover/focus; the value text
   *             itself becomes the click/keyboard edit trigger. Use inline (e.g.
   *             a resume bullet) where a reserved pencil leaves an awkward gap.
   */
  revealOn?: "reserve" | "hover";
  /**
   * Read-mode root box model:
   *   flex   — `inline-flex` atom; value + pencil stay on one line, the box
   *            never breaks across lines. Default — right for short fields
   *            (title, company, contact chips).
   *   inline — `inline` flow; the value wraps as real text and following inline
   *            siblings (e.g. bullet check badges) flow right after the last
   *            word. Use for long-form prose like a resume bullet.
   */
  display?: "flex" | "inline";
  /**
   * Multiline variant (opt-in, ADDITIVE).
   *
   * When true:
   *   – Renders a full-width auto-growing <textarea> instead of <input>.
   *   – Edit mode breaks out of the inline flow and takes a block layout (full
   *     width of the parent container).
   *   – Commit requires an explicit "Save" button click (or Ctrl/Cmd+Enter).
   *     Blur and Enter do NOT commit — a multi-line paste that accidentally
   *     defocuses shouldn't lose the draft. Escape still cancels.
   *   – An explicit "Cancel" button discards the draft.
   *
   * Existing single-line callers omitting this prop are byte-for-byte
   * unchanged in behavior.
   */
  multiline?: boolean;
  /**
   * Rework callback (multiline only, opt-in).
   *
   * When provided alongside `multiline`, a "Rework" action appears next to
   * Save/Cancel. The callback receives the current draft text so the caller
   * can trigger an AI-rewrite pass on the live draft (e.g. thread through
   * RewriteButton's engine). The EditableField itself has no rewrite logic.
   */
  onRework?: (currentDraft: string) => void;
}

export function EditableField({
  value,
  placeholder = "not detected",
  label,
  onCommit,
  className,
  textWeight = "normal",
  textSize = "sm",
  revealOn = "reserve",
  display = "flex",
  multiline = false,
  onRework,
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startEdit = useCallback(() => {
    setDraft(value ?? "");
    setEditing(true);
    // Focus after the next paint so the element is mounted.
    requestAnimationFrame(() => {
      if (multiline) {
        textareaRef.current?.focus();
        // Place cursor at end.
        const ta = textareaRef.current;
        if (ta) {
          ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
      } else {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    });
  }, [value, multiline]);

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

  // ── Multiline edit mode ───────────────────────────────────────────────────

  // Auto-grow: sync textarea height to scroll height on every draft change.
  useEffect(() => {
    if (!multiline || !editing) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [draft, multiline, editing]);

  if (editing && multiline) {
    return (
      <div className={`flex w-full flex-col gap-1.5 ${className ?? ""}`}>
        <textarea
          ref={textareaRef}
          aria-label={label}
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter commits; bare Enter inserts a newline.
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className={[
            "w-full resize-none overflow-hidden rounded border border-border",
            "bg-surface-card px-2 py-1.5",
            sizeCls,
            weightCls,
            "text-content-primary leading-snug",
            "outline-hidden focus:ring-1 focus:ring-brand-amber",
          ].join(" ")}
        />
        {/* Save / Cancel / Rework action row */}
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={commit}
            aria-label={`Save ${label}`}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={cancel}
            aria-label={`Cancel editing ${label}`}
          >
            Cancel
          </Button>
          {onRework && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRework(draft)}
              aria-label={`Rework ${label} with AI`}
              className="ml-auto flex items-center gap-1 text-content-tertiary hover:text-brand-amber"
            >
              <ReworkSparkleIcon />
              Rework
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ── Single-line edit mode (original behavior, unchanged) ──────────────────

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
            "outline-hidden focus:ring-1 focus:ring-brand-amber",
          ].join(" ")}
        />
      </span>
    );
  }

  // ── Read mode (shared by both variants) ───────────────────────────────────

  const hoverReveal = revealOn === "hover";

  // hover mode: the value text is the primary edit trigger (so the pencil can
  // take zero layout space without losing keyboard access). reserve mode: plain
  // text, pencil owns the affordance.
  const valueText = (
    <span
      {...(hoverReveal
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-label": `Edit ${label}`,
            onClick: startEdit,
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                startEdit();
              }
            },
          }
        : {})}
      className={[
        sizeCls,
        weightCls,
        hasValue ? "text-content-primary" : "text-content-muted italic",
        hoverReveal
          ? "cursor-text rounded-xs outline-hidden focus-visible:ring-1 focus-visible:ring-brand-amber"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {hasValue ? value : placeholder}
    </span>
  );

  const inlineFlow = display === "inline";

  // reserve: opacity-0 keeps the pencil in flow + focusable (no shift).
  // hover: display:none collapses its width; the value text covers keyboard a11y.
  // Inline flow has no flex `gap`, so the pencil carries its own left margin.
  const pencilSpacing = inlineFlow ? "ml-1 align-middle " : "";
  const pencilCls =
    pencilSpacing +
    (hoverReveal
      ? "shrink-0 hidden group-hover:inline-flex group-focus-within:inline-flex text-content-muted hover:text-content-secondary"
      : "shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 text-content-muted hover:text-content-secondary");

  // Inline mode: plain `inline` so the value wraps as text and trailing siblings
  // flow after the last word. Flex mode: `inline-flex` atom (value + pencil never
  // split). `min-w-0`/`items-center`/`gap-1` only bite in flex mode.
  const rootBox = inlineFlow
    ? "inline"
    : "inline-flex min-w-0 items-center gap-1";

  return (
    <span className={`group ${rootBox} ${className ?? ""}`}>
      {valueText}
      {/* Pencil-icon edit button — hover bonus in hover mode, primary in reserve mode */}
      <Button
        variant="icon"
        aria-label={`Edit ${label}`}
        onClick={startEdit}
        tabIndex={hoverReveal ? -1 : undefined}
        className={pencilCls}
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
      </Button>
    </span>
  );
}

/** Small sparkle icon for the Rework action in the multiline action row. */
function ReworkSparkleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3 w-3 shrink-0"
      fill="currentColor"
    >
      <path d="M12 2l1.9 5.6a4 4 0 0 0 2.5 2.5L22 12l-5.6 1.9a4 4 0 0 0-2.5 2.5L12 22l-1.9-5.6a4 4 0 0 0-2.5-2.5L2 12l5.6-1.9a4 4 0 0 0 2.5-2.5L12 2z" />
    </svg>
  );
}
