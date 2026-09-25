// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
 * It no longer owns card chrome (#955). It renders a plain `<section>`: both
 * lanes wrap the résumé in a `Card` with the identical border/radius/
 * background/padding (`ResultDetail` on `/`, `App`'s authoring branch for a
 * from-scratch résumé), and a second copy of that chrome as its
 * first child drew two nested identical borders carrying no information —
 * position and type size already say "this is the contact block" — while the
 * doubled `p-5` cost ~40px of the vertical budget #955 exists to win back.
 * Deliberately NOT swapped for a tint or an accent: this surface previews a
 * printed ATS PDF, and tinting the one block that is pure text would imply it
 * exports that way. What this component still owns is the name heading; the
 * per-segment contact/links rendering (and its inline-edit affordances) lives
 * in `ContactDetails` so the card stays within the ~200 LOC budget.
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
import type { ContactDisplayField } from "../../lib/contact.ts";
import { applyContactOverrides, buildContactFields } from "../../lib/contact.ts";
import { EditableField } from "@design-system";
import { SECTION_IDS } from "../../lib/anchors.ts";
import type {
  ContactOverrides,
  ProfileOverride,
} from "../../hooks/useEditableParse.ts";
import type { LegacyLinkKey } from "../../lib/score/types.ts";
import { ContactDetails } from "./ContactDetails.tsx";
import { headlineRoundTripWarning } from "../../lib/edit/headline.ts";
import { useFixItTarget } from "../../hooks/useFixItMode.ts";
import { contactFieldAnchorId } from "../../lib/score/guidance.ts";

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
  onAddProfile?: (url: string) => string | undefined;
  onEditProfile?: (id: string, url: string) => void;
  onRemoveProfile?: (id: string) => void;
}

/**
 * The tagline line under the name (#599) — the user's chosen primary role when
 * one is set, otherwise the standalone title the parser lifted from the profile
 * block. Rendered as its own component rather than inline in `ContactCard`
 * because the gated-vs-editable-vs-absent branching is what pushed the card's
 * cognitive complexity past the bar; `ContactCard` is already at the top of the
 * repo's ~200 LOC budget, so the house rule is to extract into a sibling.
 *
 * Renders nothing when there is no headline AND the card is display-only — a
 * blank editable slot is the affordance that lets a user add one, but on a
 * read-only card it would just be dead space.
 */
function HeadlineField({
  headline,
  editable,
  onCommit,
}: {
  headline: ContactDisplayField | undefined;
  editable: boolean;
  onCommit: (value: string) => void;
}) {
  const shown = headline && !headline.gated ? headline.value : undefined;
  if (!editable) {
    return shown ? (
      <div className="mt-1 text-sm font-normal text-content-muted">{shown}</div>
    ) : null;
  }
  return (
    <div className="mt-1 text-sm font-normal text-content-muted">
      <EditableField
        value={shown}
        placeholder="headline"
        label="Headline"
        textSize="sm"
        textWeight="normal"
        onCommit={onCommit}
        validate={headlineRoundTripWarning}
      />
    </div>
  );
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

  const name = displayFields.find((f) => f.key === "full_name");
  const headline = displayFields.find((f) => f.key === "headline");
  const contactLine = displayFields.filter((f) => f.group === "contact");
  const links = displayFields.filter((f) => f.group === "link");

  const nameTarget = useFixItTarget(contactFieldAnchorId("full_name"), "inline");

  const commit = (key: keyof ContactOverrides, v: string) =>
    onFieldChange?.(key, v);

  return (
    // The header block is one `edit-scope` (#913): its empty-field prompts and
    // add pills rest hidden and show while any of it is hovered or focused.
    <section id={SECTION_IDS.contact} className="edit-scope scroll-mt-6 text-center">
      {/* Name heading — the immediate "whose resume" anchor. */}
      <h2
        id={nameTarget.id}
        tabIndex={nameTarget.tabIndex}
        className={`inline-block text-lg font-semibold text-content-primary ${nameTarget.className}`}
      >
        {editable ? (
          <EditableField
            value={name && !name.gated ? name.value : undefined}
            placeholder="name"
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

      <HeadlineField
        headline={headline}
        editable={editable}
        onCommit={(v) => commit("headline", v)}
      />

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
    </section>
  );
}
