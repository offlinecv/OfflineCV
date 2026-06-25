// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ContactCard — a centered visual contact card (#146) with optional inline
 * editing (#147).
 *
 *   Name                       ← card heading (largest, semibold)
 *   location · email · phone   ← pipe-joined contact line, present-only
 *   in/slug   ·   gh/slug      ← links line, glyph-free clickable slugs
 *   N of M fields detected     ← muted audit footer
 *
 * This component owns the card chrome, the name heading, and the audit footer;
 * the per-segment contact/links rendering (and its inline-edit affordances)
 * lives in `ContactDetails` so the card stays within the ~200 LOC budget.
 *
 * Editing (#147): when BOTH `overrides` and `onFieldChange` are provided, the
 * five editable fields (`full_name`, `email`, `phone`, `linkedin_url`,
 * `location`) become inline-editable in place via the shared `EditableField`
 * primitive. When the props are absent the card is pure display (#146 behavior,
 * unchanged). Override state, clear-to-absent, and score re-eval flow through the
 * existing `useEditableParse` plumbing — unchanged. Gating still flows through
 * `buildContactFields` + the confidence floor — no second copy of that logic.
 */

import type { CascadeResult } from "../../lib/heuristics/types.ts";
import { buildContactFields, type ContactDisplayField } from "../../lib/contact.ts";
import { Card, EditableField } from "@design-system";
import type { ContactOverrides } from "../../hooks/useEditableParse.ts";
import { ContactDetails, EDITABLE_KEYS } from "./ContactDetails.tsx";

interface ContactCardProps {
  result: CascadeResult;
  /** In-memory overrides for the editable contact fields. When provided
   *  together with `onFieldChange`, the card becomes inline-editable (#147). */
  overrides?: ContactOverrides;
  /** Called when the user commits an edit on a contact field. */
  onFieldChange?: (key: keyof ContactOverrides, newValue: string) => void;
}

export function ContactCard({
  result,
  overrides,
  onFieldChange,
}: ContactCardProps) {
  const fields = buildContactFields(result);
  const editable = overrides !== undefined && onFieldChange !== undefined;

  // Apply in-memory overrides onto the editable fields: a non-empty override
  // replaces the parsed value (becomes detected); an empty string means the
  // user cleared it → revert to the gated "not found" state. Mirrors the
  // pre-#146 behavior; non-editable fields pass through untouched.
  const displayFields = fields.map((field): ContactDisplayField => {
    const ovKey = EDITABLE_KEYS[field.key];
    if (!editable || ovKey === undefined) return field;
    const ov = overrides[ovKey];
    if (ov === undefined) return field;
    if (ov === "") return { ...field, value: "", gated: true, reason: "absent" };
    return { ...field, value: ov, gated: false, reason: undefined };
  });

  const detectedCount = displayFields.filter((f) => !f.gated).length;
  const name = displayFields.find((f) => f.group === "identity");
  const contactLine = displayFields.filter((f) => f.group === "contact");
  const links = displayFields.filter((f) => f.group === "link");

  const commit = (key: keyof ContactOverrides, v: string) =>
    onFieldChange?.(key, v);

  return (
    <Card id="contact" className="scroll-mt-6 text-center">
      {/* Name heading — the immediate "whose resume" anchor. */}
      <h2 className="text-lg font-semibold text-content-primary">
        {editable ? (
          <EditableField
            value={name && !name.gated ? name.value : undefined}
            placeholder="Name not detected"
            label="Name"
            textSize="lg"
            textWeight="semibold"
            onCommit={(v) => commit("full_name", v)}
          />
        ) : name && !name.gated ? (
          name.value
        ) : (
          <span className="font-normal text-content-muted">
            Name not detected
          </span>
        )}
      </h2>

      <ContactDetails
        contactLine={contactLine}
        links={links}
        editable={editable}
        commit={commit}
      />

      {/* Subtle audit footer — the parser-audit signal, made unobtrusive. */}
      <p className="mt-3 text-xs text-content-muted">
        {detectedCount} of {displayFields.length} fields detected
      </p>
    </Card>
  );
}
