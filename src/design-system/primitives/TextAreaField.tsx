// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * TextAreaField — the ONE always-visible multiline text input primitive.
 *
 * Distinct from `EditableField` (multiline): EditableField is a click-to-edit
 * affordance for an existing value on a document-shaped surface (read mode →
 * edit mode → commit). TextAreaField is a plain, always-editable, controlled
 * textarea for free composition — e.g. the rewrite "Instructions" box (#210)
 * where there's no read/edit toggle and the empty state should show example
 * placeholder text, not a "not detected" affordance.
 *
 * Owns the raw <textarea> so feature code never hand-rolls one (the textarea is
 * a UI primitive concern; CLAUDE.md's 3-tier rule keeps it here, not in
 * src/components/). Auto-grows to fit content like EditableField's multiline
 * variant — opt out with `autoGrow={false}` when the value is generated rather
 * than typed and can be arbitrarily long (#609's exported prompt), where
 * growing to fit would push the surrounding dialog's own controls off-screen.
 *
 * Design rules (CLAUDE.md): semantic tokens only; no hardcoded hex or raw
 * palette classes.
 */

import { useEffect, useRef } from "react";
import type { Ref } from "react";

interface TextAreaFieldProps {
  /** Controlled value. */
  value: string;
  /** Called with the raw textarea value on every keystroke. */
  onChange: (value: string) => void;
  /** Accessible label (aria-label) for the textarea. */
  label: string;
  /** Placeholder shown when empty (e.g. example asks). */
  placeholder?: string;
  /** Minimum visible rows before auto-grow kicks in. Defaults to 2. */
  rows?: number;
  /** When true, the textarea is non-interactive and dimmed. */
  disabled?: boolean;
  /**
   * When true, the value cannot be edited but stays focusable, scrollable and
   * SELECTABLE. Distinct from `disabled`, which dims the field and takes it out
   * of the tab order — a disabled textarea's text cannot be selected with the
   * mouse in Chromium, which makes it useless as a manual-copy fallback for a
   * generated artifact the user is meant to take elsewhere (#609).
   */
  readOnly?: boolean;
  /**
   * Sync the height to the content on every change. Defaults to true. False
   * pins the box at `rows` and scrolls the overflow instead.
   */
  autoGrow?: boolean;
  /** Extra classes on the root wrapper (layout stays with the caller). */
  className?: string;
  /**
   * Forwarded to the raw `<textarea>`, so a caller can focus or select it.
   *
   * This primitive owns its element and its own auto-grow ref, so before this
   * there was no way to reach the field from outside — and a caller that
   * replaces the body from elsewhere on the surface has to be able to land
   * focus on it (`LetterEditorDialog`'s "Start from…", #767 review: taking a
   * starting point unmounts the button that was clicked). React 19 takes `ref`
   * as a plain prop, so this is additive — it is merged with the internal ref
   * rather than replacing it.
   */
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextAreaField({
  value,
  onChange,
  label,
  placeholder,
  rows = 2,
  disabled = false,
  readOnly = false,
  autoGrow = true,
  className,
  ref,
}: TextAreaFieldProps) {
  const innerRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: sync height to scroll height on every value change. Skip the
  // pin when the element is detached/hidden (scrollHeight 0) — e.g. mounted
  // inside a closed <dialog> — so it doesn't collapse to 0px; the natural
  // `rows` height then shows once the field becomes visible.
  useEffect(() => {
    if (!autoGrow) return;
    const ta = innerRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (ta.scrollHeight > 0) ta.style.height = `${ta.scrollHeight}px`;
  }, [value, autoGrow]);

  return (
    <textarea
      // Both refs, not one: auto-grow reads `innerRef` on every value change,
      // and a caller's `ref` must still reach the same element. Assigning only
      // the forwarded one would silently disable auto-grow for that caller.
      ref={(node) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      aria-label={label}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      className={[
        "w-full resize-none rounded border border-border",
        autoGrow ? "overflow-hidden" : "overflow-y-auto",
        "bg-surface-card px-2 py-1.5 text-sm leading-snug",
        "text-content-primary placeholder:text-content-muted",
        "outline-hidden focus:ring-1 focus:ring-accent-primary",
        "disabled:opacity-60",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
