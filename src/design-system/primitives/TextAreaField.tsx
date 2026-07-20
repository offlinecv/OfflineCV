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
 * variant.
 *
 * Design rules (CLAUDE.md): semantic tokens only; no hardcoded hex or raw
 * palette classes.
 */

import { useEffect, useRef } from "react";

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
  /** When true, the textarea is read-only and dimmed. */
  disabled?: boolean;
  /** Extra classes on the root wrapper (layout stays with the caller). */
  className?: string;
}

export function TextAreaField({
  value,
  onChange,
  label,
  placeholder,
  rows = 2,
  disabled = false,
  className,
}: TextAreaFieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: sync height to scroll height on every value change. Skip the
  // pin when the element is detached/hidden (scrollHeight 0) — e.g. mounted
  // inside a closed <dialog> — so it doesn't collapse to 0px; the natural
  // `rows` height then shows once the field becomes visible.
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (ta.scrollHeight > 0) ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      aria-label={label}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={[
        "w-full resize-none overflow-hidden rounded border border-border",
        "bg-surface-card px-2 py-1.5 text-sm leading-snug",
        "text-content-primary placeholder:text-content-muted",
        "outline-hidden focus:ring-1 focus:ring-brand-amber",
        "disabled:opacity-60",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
