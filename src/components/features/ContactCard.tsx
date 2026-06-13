// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ContactCard — displays extracted contact fields as a chip strip.
 *
 * Detected fields show the value with a success chip; undetected fields
 * show a warning chip with a "not detected" label. Always renders all 5
 * fields so the reader can spot gaps at a glance.
 *
 * Edit mode (#58): when `overrides` and `onFieldChange` are provided, each
 * field chip gains an inline EditableField affordance. Edited values replace
 * the parser-detected value in the display (in memory only; lost on reset).
 * A cleared field reverts to the "not detected" chip state.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { buildContactFields } from "../../lib/contact.ts";
import { Chip } from "../ui/Chip.tsx";
import { Card } from "../shared/Card.tsx";
import { EditableField } from "../ui/EditableField.tsx";
import type { ContactOverrides } from "../../hooks/useEditableParse.ts";

interface ContactCardProps {
  result: CascadeResult;
  /** In-memory overrides for contact fields. When provided, each field gains
   *  an inline edit affordance. */
  overrides?: ContactOverrides;
  /** Called when the user commits an edit on a contact field. */
  onFieldChange?: (key: keyof ContactOverrides, newValue: string) => void;
}

/** Map from ContactOverrides key → display label. */
const FIELD_LABELS: Record<keyof ContactOverrides, string> = {
  full_name: "Name",
  email: "Email",
  phone: "Phone",
  linkedin_url: "LinkedIn",
  location: "Location",
};

/** Map from ContactDisplayField.key → ContactOverrides key (only the 5 editable ones). */
const KEY_MAP: Record<string, keyof ContactOverrides> = {
  full_name: "full_name",
  email: "email",
  phone: "phone",
  linkedin_url: "linkedin_url",
  location: "location",
};

export function ContactCard({
  result,
  overrides,
  onFieldChange,
}: ContactCardProps) {
  const fields = buildContactFields(result);
  const editable = overrides !== undefined && onFieldChange !== undefined;

  // Apply in-memory overrides: a non-empty override replaces the parsed value;
  // an empty string means "user cleared it" → treat as absent.
  const displayFields = fields.map((field) => {
    const overrideKey = KEY_MAP[field.key];
    if (!editable || overrideKey === undefined) return field;
    const ov = overrides[overrideKey];
    if (ov === undefined) return field; // no override yet
    if (ov === "") {
      // User cleared → show as absent.
      return { ...field, value: "", gated: true, reason: "absent" as const };
    }
    // User set a value → show as detected.
    return { ...field, value: ov, gated: false, reason: undefined };
  });

  const detectedCount = displayFields.filter((f) => !f.gated).length;

  return (
    <Card id="contact" className="scroll-mt-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-content-muted">
        Contact — {detectedCount} of 5 detected
      </h2>
      <div className="flex flex-wrap gap-2">
        {displayFields.map((field) => {
          const overrideKey = KEY_MAP[field.key] as
            | keyof ContactOverrides
            | undefined;

          if (!editable || overrideKey === undefined) {
            // Read-only rendering (no edit hooks provided).
            return field.gated ? (
              <Chip key={field.key} tone="warning" icon="⚠">
                {field.label} not detected
                {field.reason === "low_confidence" && " (low confidence)"}
              </Chip>
            ) : (
              <Chip key={field.key} tone="success" icon="✓">
                {field.value}
              </Chip>
            );
          }

          // Editable chip: wraps value in EditableField inside a chip-shaped shell.
          const fieldLabel = FIELD_LABELS[overrideKey];
          const currentValue = field.gated ? "" : field.value;

          return (
            <span
              key={field.key}
              className={[
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs",
                field.gated
                  ? "bg-feedback-warning-bg text-feedback-warning-text"
                  : "bg-feedback-success-bg text-feedback-success-text",
              ].join(" ")}
            >
              <span aria-hidden="true">{field.gated ? "⚠" : "✓"}</span>
              <EditableField
                value={currentValue || undefined}
                placeholder={`${field.label} not detected`}
                label={fieldLabel}
                textSize="xs"
                onCommit={(v) => onFieldChange(overrideKey, v)}
              />
            </span>
          );
        })}
      </div>
    </Card>
  );
}
