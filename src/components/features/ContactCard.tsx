// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * ContactCard — a centered visual contact card (#146) with optional inline
 * editing (#147).
 *
 *   Name                       ← card heading (largest, semibold)
 *   location · email · phone   ← pipe-joined contact line, present-only
 *   in/slug   ·   gh/slug      ← links line, glyph-free clickable slugs
 *
 * The detected/total completeness summary no longer lives here — it moved up
 * into the AttentionStrip (top of the reconstructed resume) so every "needs
 * your attention" signal is co-located; the inline "not detected" pills stay in
 * the contact line, where the field is fixed.
 *
 * This component owns the card chrome and the name heading; the per-segment
 * contact/links rendering (and its inline-edit affordances) lives in
 * `ContactDetails` so the card stays within the ~200 LOC budget.
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
import { applyContactOverrides, buildContactFields } from "../../lib/contact.ts";
import { Card, EditableField } from "@design-system";
import { SECTION_IDS } from "../../lib/anchors.ts";
import type {
  ContactOverrides,
  ProfileOverride,
} from "../../hooks/useEditableParse.ts";
import type { LegacyLinkKey } from "../../lib/score/types.ts";
import { ContactDetails } from "./ContactDetails.tsx";

interface ContactCardProps {
  result: CascadeResult;
  /** In-memory overrides for the editable contact fields. When provided
   *  together with `onFieldChange`, the card becomes inline-editable (#147). */
  overrides?: ContactOverrides;
  /** Called when the user commits an edit on a non-link contact field
   *  (name/email/phone/location). */
  onFieldChange?: (key: keyof ContactOverrides, newValue: string) => void;
  /** Called when the user edits/clears one of the four detected legacy link
   *  slots (#427) — routed to the consolidated `profileOverrides` channel. */
  onLegacyLinkChange?: (key: LegacyLinkKey, url: string | undefined) => void;
  /** Extra user-added contact links beyond the four legacy slots (#427). Wired
   *  together with the add/edit/remove handlers to enable the variable-length
   *  links affordance in the editable card. */
  extraProfiles?: readonly ProfileOverride[];
  onAddProfile?: (url: string) => void;
  onEditProfile?: (id: string, url: string) => void;
  onRemoveProfile?: (id: string) => void;
}

export function ContactCard({
  result,
  overrides,
  onFieldChange,
  onLegacyLinkChange,
  extraProfiles,
  onAddProfile,
  onEditProfile,
  onRemoveProfile,
}: ContactCardProps) {
  const editable = overrides !== undefined && onFieldChange !== undefined;

  // Resolve overrides against the parsed fields via the shared helper — the same
  // path the AttentionStrip uses to count gaps, so card and strip never disagree.
  const displayFields = applyContactOverrides(
    buildContactFields(result.canonical),
    editable ? overrides : undefined,
  );

  const name = displayFields.find((f) => f.group === "identity");
  const contactLine = displayFields.filter((f) => f.group === "contact");
  const links = displayFields.filter((f) => f.group === "link");

  const commit = (key: keyof ContactOverrides, v: string) =>
    onFieldChange?.(key, v);

  return (
    <Card id={SECTION_IDS.contact} className="scroll-mt-6 text-center">
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
        onLegacyLinkChange={onLegacyLinkChange}
        extraProfiles={extraProfiles}
        onAddProfile={onAddProfile}
        onEditProfile={onEditProfile}
        onRemoveProfile={onRemoveProfile}
      />
    </Card>
  );
}
