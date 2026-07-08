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
import {
  validateEmail,
  validatePhone,
  validateUrl,
  type FieldValidator,
} from "../../lib/edit/field-validators.ts";
import type { ContactOverrides } from "../../hooks/useEditableParse.ts";

/** The inline-editable contact fields, mapped 1:1 to their `ContactOverrides`
 *  key. Includes the link fields — a detected GitHub/portfolio/website URL is
 *  editable too (only optional links that the parser actually found render, so
 *  there is nothing to edit when absent). */
const EDITABLE_KEYS: Record<string, keyof ContactOverrides> = {
  full_name: "full_name",
  email: "email",
  phone: "phone",
  linkedin_url: "linkedin_url",
  location: "location",
  github_url: "github_url",
  portfolio_url: "portfolio_url",
  website_url: "website_url",
};

type Commit = (key: keyof ContactOverrides, v: string) => void;

/** Shape validator per editable contact field. Name/location are free-form
 *  (a "parser audit, not a judge" — any string is a legitimate name), so they
 *  map to no validator; email/link fields each get a shape check. Phone is
 *  resolved separately (see `validatorFor`) because it needs the parsed
 *  location threaded in for its region default. */
const FIELD_VALIDATORS: Partial<Record<string, FieldValidator>> = {
  email: validateEmail,
  linkedin_url: validateUrl,
  github_url: validateUrl,
  portfolio_url: validateUrl,
  website_url: validateUrl,
};

/** Resolve the validator for a field. Phone binds the résumé's parsed location
 *  so non-US local-form numbers aren't falsely flagged (mirrors the parser's
 *  `extractContact`, which wires `regionFromLocation` for the same reason). */
function validatorFor(
  key: string,
  location: string | undefined,
): FieldValidator | undefined {
  if (key === "phone") return (v) => validatePhone(v, location);
  return FIELD_VALIDATORS[key];
}

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
  // The parsed location, threaded into the phone validator's region default so a
  // non-US local-form number isn't falsely flagged (see `validatorFor`).
  const location = contactLine.find((f) => f.key === "location")?.value;
  return (
    <>
      {/* Contact line: location / email / phone, pipe-joined, present-only. */}
      {contactLine.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
          {contactLine.map((field, i) => (
            <span key={field.key} className="inline-flex items-center gap-x-2">
              {i > 0 && <span className="text-content-muted">|</span>}
              {renderContactValue(field, editable, commit, location)}
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

/** Discernible warning token for a missing required field — a quiet pill, not a
 *  loud chip, but clearly set apart from the present values around it so the gap
 *  is spotted at a glance (restores the pre-#146 yellowish affordance). */
function MissingToken({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-feedback-warning-bg px-2 py-0.5 text-xs text-feedback-warning-text">
      <span aria-hidden="true">⚠</span>
      {label} not detected
    </span>
  );
}

/** An inline editor for one field, wrapped in a state-tinted shell so a missing
 *  required field stays discernible (warning pill) and a low-confidence value
 *  keeps its dotted treatment — both still editable. */
function EditableValue({
  field,
  ovKey,
  commit,
  displayValue,
  location,
}: {
  field: ContactDisplayField;
  ovKey: keyof ContactOverrides;
  commit: Commit;
  displayValue?: string;
  location?: string;
}) {
  const absent = field.gated && field.reason === "absent";
  const lowConfidence = field.gated && field.reason === "low_confidence";

  const editor = (
    <EditableField
      value={field.value || undefined}
      displayValue={displayValue}
      placeholder={`${field.label} not detected`}
      label={field.label}
      textSize="sm"
      validate={validatorFor(field.key, location)}
      onCommit={(v) => commit(ovKey, v)}
    />
  );

  if (absent) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-feedback-warning-bg px-2 py-0.5 text-xs text-feedback-warning-text">
        <span aria-hidden="true">⚠</span>
        {editor}
      </span>
    );
  }
  if (lowConfidence) {
    return (
      <span
        className="underline decoration-dotted underline-offset-2"
        title="low confidence"
      >
        {editor}
      </span>
    );
  }
  return editor;
}

/** Render one contact-line segment — an inline editor when editable, else the
 *  detected value or a discernible "not detected" token. Low-confidence values
 *  are kept (and editable) so the user can confirm/correct them. */
function renderContactValue(
  field: ContactDisplayField,
  editable: boolean,
  commit: Commit,
  location: string | undefined,
) {
  const ovKey = EDITABLE_KEYS[field.key];
  if (editable && ovKey !== undefined) {
    return (
      <EditableValue field={field} ovKey={ovKey} commit={commit} location={location} />
    );
  }
  return field.gated && field.reason === "absent" ? (
    <MissingToken label={field.label} />
  ) : (
    <FieldValue field={field} />
  );
}

/** Render one links-line entry. When editable, a present link gets a
 *  navigate-AND-edit dual affordance — the slug edits the full URL in place, a
 *  small `↗` opens it in a new tab — so editing no longer costs the click-
 *  through. A missing (required) link is an editable warning token (add in
 *  place). Without editing, every link is a display-only clickable slug. */
function renderLink(
  field: ContactDisplayField,
  editable: boolean,
  commit: Commit,
) {
  const ovKey = EDITABLE_KEYS[field.key];
  if (editable && ovKey !== undefined) {
    if (!field.gated) {
      return (
        <span className="inline-flex items-center gap-1">
          <EditableValue
            field={field}
            ovKey={ovKey}
            commit={commit}
            displayValue={formatLinkDisplay(field.value)}
          />
          <a
            href={field.value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-amber hover:underline"
            aria-label={`Open ${field.label} in a new tab`}
          >
            ↗
          </a>
        </span>
      );
    }
    return <EditableValue field={field} ovKey={ovKey} commit={commit} />;
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
