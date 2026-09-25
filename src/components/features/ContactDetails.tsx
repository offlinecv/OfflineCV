// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
 * When `editable` is set, the editable fields (email/phone/location/work
 * authorization on the contact line, LinkedIn on the links line) render via the
 * shared `EditableField` primitive; LinkedIn edits the full URL but displays the
 * derived slug. Otherwise everything is display-only (#146 behavior).
 *
 * Work authorization (#792) is the one contact-line row that is OPTIONAL, so it
 * neither renders a "not detected" pill nor counts as a gap. Its add path is
 * the `ContactWorkAuthorization` affordance below the line, which exists
 * because a hidden optional row is otherwise unreachable.
 */

import type { ReactNode } from "react";
import { formatLinkDisplay, type ContactDisplayField } from "../../lib/contact.ts";
import { EditableField } from "@design-system";
import { classifyProfile } from "../../lib/contact/profile-registry.ts";
import {
  validateEmail,
  validatePhone,
  validateUrl,
  type FieldValidator,
} from "../../lib/edit/field-validators.ts";
import type {
  ContactOverrides,
  ProfileOverride,
} from "../../hooks/useEditableParse.ts";
import type { LegacyLinkKey } from "../../lib/score/types.ts";
import { ContactExtraLinks } from "./ContactExtraLinks.tsx";
import { ContactWorkAuthorization } from "./ContactWorkAuthorization.tsx";
import { ProfileLinkAdd } from "./ProfileLinkAdd.tsx";
import { FixItTarget } from "./FixItTarget.tsx";
import { contactFieldAnchorId } from "../../lib/score/guidance.ts";

/** The inline-editable non-link contact fields, mapped 1:1 to their
 *  `ContactOverrides` key. Link fields (linkedin/github/portfolio/website) are
 *  edited through the consolidated `profileOverrides` channel (#427), not this
 *  map — see `onLegacyLinkChange`. */
const EDITABLE_KEYS: Record<string, keyof ContactOverrides> = {
  full_name: "full_name",
  email: "email",
  phone: "phone",
  location: "location",
  work_authorization: "work_authorization",
};

/** The optional work-authorization contact row (#792). Named once here because
 *  two places need it: the contact-line filter that suppresses its "not
 *  detected" pill, and the add affordance that replaces it. */
const WORK_AUTHORIZATION_KEY = "work_authorization";

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
  /** Edit/clear one of the four detected legacy link slots (#427) — routed to
   *  the consolidated `profileOverrides` channel. */
  onLegacyLinkChange?: (key: LegacyLinkKey, url: string | undefined) => void;
  /** Extra user-added links beyond the four legacy slots (#427). When
   *  `onAddProfile` is provided (editable card), the variable-length add/edit/
   *  delete affordance renders below the legacy links line. */
  extraProfiles?: readonly ProfileOverride[];
  onAddProfile?: (url: string) => string | undefined;
  onEditProfile?: (id: string, url: string) => void;
  onRemoveProfile?: (id: string) => void;
  /** An empty-field prompt the card hands down to lead the add row — the
   *  headline's, when there is none, so it does not hold a blank line of its
   *  own under the name. */
  leadingAdd?: ReactNode;
}

export function ContactDetails({
  contactLine,
  links,
  editable,
  commit,
  onLegacyLinkChange,
  extraProfiles,
  onAddProfile,
  onEditProfile,
  onRemoveProfile,
  leadingAdd,
}: ContactDetailsProps) {
  // The parsed location, threaded into the phone validator's region default so a
  // non-US local-form number isn't falsely flagged (see `validatorFor`).
  const location = contactLine.find((f) => f.key === "location")?.value;
  // Work authorization (#792) is the one contact-line row whose absence is not
  // a gap, so it must never draw the "not detected" warning pill the required
  // rows draw. An absent value is dropped from the line and replaced by the
  // "+ Add work authorization" affordance below (editable card only); a
  // low-confidence value still renders, like its siblings, so it can be
  // confirmed or corrected in place.
  const segments = contactLine.filter(
    (f) => f.key !== WORK_AUTHORIZATION_KEY || f.reason !== "absent",
  );
  const workAuthorizationAbsent = !segments.some(
    (f) => f.key === WORK_AUTHORIZATION_KEY,
  );
  const presentLinks = editable
    ? links.filter((f) => !f.gated || f.reason !== "absent")
    : links;
  const absentLinks = editable
    ? links.filter((f) => f.gated && f.reason === "absent")
    : [];

  return (
    <>
      {/* Contact line: location / email / phone, pipe-joined, present-only. */}
      {segments.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
          {segments.map((field, i) => (
            <span key={field.key} className="inline-flex items-center gap-x-2">
              {i > 0 && <span className="text-content-muted">|</span>}
              <FixItTarget
                anchorId={contactFieldAnchorId(field.key)}
                className="inline-flex items-center"
              >
                {renderContactValue(field, editable, commit, location)}
              </FixItTarget>
            </span>
          ))}
        </p>
      )}

      {/* Links line: clickable slugs, middot-separated, license-safe (no logos). */}
      {presentLinks.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
          {presentLinks.map((field, i) => (
            <span key={field.key} className="inline-flex items-center gap-x-2">
              {i > 0 && <span className="text-content-muted">·</span>}
              <FixItTarget
                anchorId={contactFieldAnchorId(field.key)}
                className="inline-flex items-center"
              >
                {renderLink(field, editable, onLegacyLinkChange)}
              </FixItTarget>
            </span>
          ))}
        </p>
      )}

      {/* The absent links, work-authorization, and extra-links "+ Add" affordances
          share one row (#953) — grouping all secondary/optional add affordances on a
          single line instead of stacking separate rows. While every item on it
          is edit chrome, a fine pointer floats the row (`edit-float`) just
          under the card instead of holding a blank line above the résumé body;
          `pt-1` rather than a margin there, so the pointer crosses from the
          contact line onto the row without leaving the card's hover scope.
          A profile the user added is content, not chrome — it prints — so
          once one exists the row stays in flow. An open input also drops it
          back into flow (styles/edit-chrome.css). */}
      {editable &&
        (leadingAdd ||
          absentLinks.length > 0 ||
          workAuthorizationAbsent ||
          (onAddProfile && onEditProfile && onRemoveProfile)) && (
          <div
            className={`mt-2 flex flex-wrap items-center justify-center gap-2 text-sm ${
              extraProfiles && extraProfiles.length > 0
                ? ""
                : "edit-float inset-x-0 top-full pointer-fine:mt-0 pointer-fine:pt-1"
            }`}
          >
            {leadingAdd}
            {absentLinks.map((field) => (
              <FixItTarget
                key={field.key}
                anchorId={contactFieldAnchorId(field.key)}
                className="inline-flex items-center"
              >
                {renderLink(field, editable, onLegacyLinkChange)}
              </FixItTarget>
            ))}
            {workAuthorizationAbsent && (
              // Wrapped so `AddPill`'s `self-start` (correct for its other,
              // column-flow consumers) doesn't misalign it in this
              // `items-center` row — `self-start` only affects a DIRECT flex
              // child, and this wrapper, not the pill, is that child. It is a
              // `div` rather than a `span` because `ContactWorkAuthorization`
              // expands to `InlineBulletAdd`'s `<div class="flex …">`, and a
              // `span` may only contain phrasing content.
              <div className="inline-flex">
                <ContactWorkAuthorization
                  onAdd={(value) => commit(WORK_AUTHORIZATION_KEY, value)}
                />
              </div>
            )}
            {onAddProfile && onEditProfile && onRemoveProfile && (
              <ContactExtraLinks
                profiles={extraProfiles ?? []}
                onAdd={onAddProfile}
                onEdit={onEditProfile}
                onRemove={onRemoveProfile}
              />
            )}
          </div>
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
    <span className="inline-flex items-center gap-1 rounded-full bg-feedback-warning-bg px-2 py-0.5 text-sm text-feedback-warning-text">
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
  onCommitValue,
  displayValue,
  location,
}: {
  field: ContactDisplayField;
  onCommitValue: (v: string) => void;
  displayValue?: string;
  location?: string;
}) {
  const absent = field.gated && field.reason === "absent";
  const lowConfidence = field.gated && field.reason === "low_confidence";

  const editor = (
    <EditableField
      value={field.value || undefined}
      displayValue={displayValue}
      placeholder={field.label.toLowerCase()}
      label={field.label}
      textSize="sm"
      validate={validatorFor(field.key, location)}
      onCommit={onCommitValue}
    />
  );

  if (absent) {
    // NOT edit chrome (#913): the pill exists so a missing REQUIRED field is
    // seen at a glance, and before the #313 reveal there is no Fix It step to
    // bring it back. `edit-reveal` keeps the empty field's own placeholder
    // (chrome, inside) visible, or the pill would rest empty.
    return (
      <span className="edit-reveal inline-flex items-center gap-1 rounded-full bg-feedback-warning-bg px-2 py-0.5 text-sm text-feedback-warning-text">
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
      <EditableValue
        field={field}
        onCommitValue={(v) => commit(ovKey, v)}
        location={location}
      />
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
  onLegacyLinkChange: ((key: LegacyLinkKey, url: string | undefined) => void) | undefined,
) {
  // Every link row's key is one of the four legacy slots (the display rows are
  // built from those keys), so it is a `LegacyLinkKey` routed to the
  // consolidated `profileOverrides` channel (#427).
  const legacyKey = field.key as LegacyLinkKey;
  if (editable && onLegacyLinkChange !== undefined) {
    const commitLink = (v: string) => onLegacyLinkChange(legacyKey, v);
    if (!field.gated) {
      return (
        <span className="inline-flex items-center gap-1">
          <EditableValue
            field={field}
            onCommitValue={commitLink}
            displayValue={formatLinkDisplay(field.value)}
          />
          <a
            href={field.value}
            target="_blank"
            rel="noopener noreferrer"
            className="edit-chrome text-accent-primary hover:underline"
            aria-label={`Open ${field.label} in a new tab`}
          >
            ↗
          </a>
        </span>
      );
    }
    // An ABSENT required link (the brand-neutral "Professional profile" row is
    // the only one that reaches here — optional links skip when undetected) gets
    // the guided network picker instead of a bare URL field, so a naive user
    // learns what counts and which networks are accepted (#335-followup).
    if (field.reason === "absent") {
      // `onLegacyLinkChange` also serves the low-confidence CORRECTION path
      // below, where an unparseable edit is intentionally kept (raw value,
      // `kind: "other"`) so the correction isn't lost. That fallback is wrong
      // for a first-time ADD: classify here so an unclassifiable value (e.g.
      // "US Citizen") is rejected the same way `addProfile` rejects it,
      // instead of being written into the slot as a bogus link (#790).
      const addLink = (v: string): string | undefined => {
        if (classifyProfile(v) === undefined) return undefined;
        commitLink(v);
        return v;
      };
      return (
        <ProfileLinkAdd
          label={`Add a ${field.label.toLowerCase()}`}
          onAdd={addLink}
        />
      );
    }
    // Low-confidence: keep the editable value so the user can confirm/correct it.
    return <EditableValue field={field} onCommitValue={commitLink} />;
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
      className="text-accent-primary hover:underline"
    >
      {formatLinkDisplay(field.value)}
    </a>
  );
}
