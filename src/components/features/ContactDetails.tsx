// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ContactDetails — the contact line and links line of the centered ContactCard.
 *
 * Split out of `ContactCard` (#147) once the card crossed the ~200 LOC limit:
 * this owns the per-segment rendering — including the inline-edit affordances —
 * while `ContactCard` stays the owner of the card chrome, the name heading, and
 * the audit footer.
 *
 *   location · email · phone   ← contact line (pipe-joined, present-only)
 *   in/slug   ·   gh/slug      ← links line (glyph-free clickable slugs)
 *
 * When `editable` is set, the editable fields (email/phone/location on the
 * contact line, LinkedIn on the links line) render via the shared
 * `EditableField` primitive; LinkedIn edits the full URL but displays the
 * derived slug. Otherwise everything is display-only (#146 behavior).
 */

import { formatLinkDisplay, type ContactDisplayField } from "../../lib/contact.ts";
import { EditableField } from "@design-system";
import type { ContactOverrides } from "../../hooks/useEditableParse.ts";

/** The five inline-editable fields, mapped 1:1 to their `ContactOverrides` key.
 *  Fields absent from this map (github/portfolio/website) stay display-only. */
export const EDITABLE_KEYS: Record<string, keyof ContactOverrides> = {
  full_name: "full_name",
  email: "email",
  phone: "phone",
  linkedin_url: "linkedin_url",
  location: "location",
};

type Commit = (key: keyof ContactOverrides, v: string) => void;

interface ContactDetailsProps {
  contactLine: ContactDisplayField[];
  links: ContactDisplayField[];
  editable: boolean;
  commit: Commit;
}

export function ContactDetails({
  contactLine,
  links,
  editable,
  commit,
}: ContactDetailsProps) {
  return (
    <>
      {/* Contact line: location / email / phone, pipe-joined, present-only. */}
      {contactLine.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
          {contactLine.map((field, i) => (
            <span key={field.key} className="inline-flex items-center gap-x-2">
              {i > 0 && <span className="text-content-muted">|</span>}
              {renderContactValue(field, editable, commit)}
            </span>
          ))}
        </p>
      )}

      {/* Links line: clickable slugs, middot-separated, license-safe (no logos). */}
      {links.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
          {links.map((field, i) => (
            <span key={field.key} className="inline-flex items-center gap-x-2">
              {i > 0 && <span className="text-content-muted">·</span>}
              {renderLink(field, editable, commit)}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

/** A detected value, shown muted + dotted when the parser was unsure of it. */
function FieldValue({ field }: { field: ContactDisplayField }) {
  if (field.reason === "low_confidence") {
    return (
      <span
        className="text-content-muted underline decoration-dotted underline-offset-2"
        title="low confidence"
      >
        {field.value}
      </span>
    );
  }
  return <span className="text-content-secondary">{field.value}</span>;
}

/** Quiet inline marker for a missing required field — not a warning chip. */
function MissingToken({ label }: { label: string }) {
  return (
    <span className="text-content-muted">{label.toLowerCase()} not found</span>
  );
}

/** Render one contact-line segment — an inline editor when editable, else the
 *  detected value or a quiet "not found" token. Low-confidence values are kept
 *  (and editable) so the user can confirm/correct them. */
function renderContactValue(
  field: ContactDisplayField,
  editable: boolean,
  commit: Commit,
) {
  const ovKey = EDITABLE_KEYS[field.key];
  if (editable && ovKey !== undefined) {
    return (
      <EditableField
        value={field.value || undefined}
        placeholder={`${field.label.toLowerCase()} not found`}
        label={field.label}
        textSize="sm"
        onCommit={(v) => commit(ovKey, v)}
      />
    );
  }
  return field.gated && field.reason === "absent" ? (
    <MissingToken label={field.label} />
  ) : (
    <FieldValue field={field} />
  );
}

/** Render one links-line entry. LinkedIn is editable (edits the full URL, shows
 *  the derived slug); the rest stay display-only clickable slugs. */
function renderLink(
  field: ContactDisplayField,
  editable: boolean,
  commit: Commit,
) {
  if (editable && field.key === "linkedin_url") {
    return (
      <EditableField
        value={field.value || undefined}
        displayValue={field.value ? formatLinkDisplay(field.value) : undefined}
        placeholder="linkedin not found"
        label="LinkedIn"
        textSize="sm"
        onCommit={(v) => commit("linkedin_url", v)}
      />
    );
  }
  if (field.gated) {
    return field.reason === "low_confidence" ? (
      <FieldValue field={field} />
    ) : (
      <MissingToken label={field.label} />
    );
  }
  return (
    <a
      href={field.value}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand-amber hover:underline"
    >
      {formatLinkDisplay(field.value)}
    </a>
  );
}
