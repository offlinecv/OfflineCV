// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * EditableField — the ONE shared inline-edit primitive.
 *
 * Renders in one of two modes:
 *   • read  — shows the current value (or a "not detected" placeholder when
 *             value is absent). The value itself is the edit affordance: a text
 *             cursor + a subtle hover tint signal editability; clicking/tapping
 *             it (or focusing it and pressing Enter/Space) enters edit mode.
 *             No pencil icon — one icon per field reads as clutter on a
 *             document-shaped surface, and a hover-only pencil is invisible on
 *             touch. The quiet hover affordance works with mouse, keyboard, and
 *             touch alike (Notion/Linear/Docs pattern).
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
 */

import { useState, useRef, useCallback, useEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "./Button.tsx";

interface EditableFieldProps {
  value: string | undefined;
  placeholder?: string;
  label: string;
  onCommit: (newValue: string) => void;
  /**
   * Read-mode display override (ADDITIVE, opt-in). When set, read mode shows
   * this instead of `value`, while edit mode still seeds and commits the raw
   * `value`. Lets a field display a derived form (e.g. a LinkedIn slug) yet edit
   * the underlying URL. Omitting it preserves the original behavior exactly.
   */
  displayValue?: string;
  /** Extra classes on the root wrapper. */
  className?: string;
  /** Visual weight of the read-mode text. Defaults to "normal". */
  textWeight?: "normal" | "semibold";
  /** Text size of the read-mode text. Defaults to "sm". */
  textSize?: "xs" | "sm" | "base" | "lg";
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
   * Optional SHAPE validator (ADDITIVE, opt-in). Runs against the current
   * committed `value` in read mode. Returns `null` when the value is a clean
   * shape, or a short message when it is not (e.g. `banana` in a date field).
   *
   * NON-BLOCKING by design: a shape-fail never rejects the commit or traps the
   * user in edit mode — the value still commits and a soft warning icon appears
   * beside it in read mode, carrying the message on hover / for screen readers.
   * Omitting this prop leaves callers byte-for-byte unchanged (no icon, no
   * behavior change).
   */
  validate?: (value: string) => string | null;
}

/**
 * Soft, non-blocking shape-warning glyph shown beside a read-mode value whose
 * `validate` returned a message. A small stroke triangle in the semantic
 * warning-icon token — the message rides on `title` (hover) and `aria-label`
 * (assistive tech), so the warning is never colour-only.
 */
function ShapeWarningGlyph({ message }: { message: string }) {
  return (
    <svg
      role="img"
      aria-label={message}
      className="ml-1 inline-block h-3.5 w-3.5 shrink-0 align-text-bottom text-feedback-warning-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title>{message}</title>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" x2="12" y1="9" y2="13" />
      <line x1="12" x2="12.01" y1="17" y2="17" />
    </svg>
  );
}

export function EditableField({
  value,
  placeholder = "not detected",
  label,
  onCommit,
  displayValue,
  className,
  textWeight = "normal",
  textSize = "sm",
  display = "flex",
  multiline = false,
  validate,
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
    textSize === "xs"
      ? "text-xs"
      : textSize === "lg"
        ? "text-lg"
        : textSize === "base"
          ? "text-base"
          : "text-sm";

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
        {/* Save / Cancel action row */}
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

  // Quiet inline-edit affordance: the value itself is the click/keyboard/tap
  // target. No pencil icon — a text cursor + a subtle hover tint signal
  // editability, which (unlike a hover-revealed pencil) also works on touch.
  const inlineFlow = display === "inline";

  // Non-blocking shape check: run the optional validator against the committed
  // value only when there is one to check. An absent field is never a typo.
  const warning = validate && hasValue ? validate(value ?? "") : null;

  // Inline mode: plain `inline` so the value wraps as text and trailing siblings
  // flow after the last word. Flex mode: `inline-flex` atom. The negative margin
  // offsets the hover-tint padding so the tinted box doesn't shift the layout.
  const rootBox = inlineFlow
    ? "inline"
    : "inline-flex min-w-0 items-center";

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Edit ${label}`}
      onClick={startEdit}
      onKeyDown={(e: ReactKeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          startEdit();
        }
      }}
      className={[
        rootBox,
        "cursor-text rounded px-1 -mx-1 transition-colors",
        "hover:bg-surface-subtle",
        "outline-hidden focus-visible:ring-1 focus-visible:ring-brand-amber",
        sizeCls,
        weightCls,
        hasValue ? "text-content-primary" : "text-content-muted italic",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {hasValue ? (displayValue ?? value) : placeholder}
      {warning && <ShapeWarningGlyph message={warning} />}
    </span>
  );
}

