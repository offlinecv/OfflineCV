// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ContactExtraLinks — the variable-length "extra links" affordance on the
 * reconstructed-resume contact card (#335, #427).
 *
 * The four legacy link slots (LinkedIn / GitHub / portfolio / website) keep
 * rendering + editing through `ContactDetails`' `links` row. THIS surface owns
 * only the EXTRA links a user adds beyond those four (a second GitHub, a GitLab,
 * ORCID, an unknown host, …) — the untagged (`legacyKey`-less) entries of the
 * consolidated `profileOverrides` channel (#427):
 *
 *   in/slug · gh/slug          ← ContactDetails links line (legacy slots)
 *   gitlab.com/x ✕ · orcid… ✕  ← THIS row (user-added extras) + "+ Add link"
 *
 * Each entry edits its full URL in place via the shared `EditableField`
 * primitive (re-classified on commit so an unknown host shows its hostname as
 * the label), opens in a new tab via a small `↗`, and is removable. Rendered
 * only in the editable card — extras are session edit state, never present in a
 * pure-display card. Built entirely from `@design-system` primitives + the
 * shared `ReconstructedAdd` affordances, no raw `<button>`/hardcoded palette.
 *
 * Renders a Fragment, not its own `<p>` (#953) — it now shares a row with
 * `ContactWorkAuthorization`, composed by `ContactDetails`, which owns that
 * row's layout classes. A `<p>` here would either wrap redundantly inside the
 * row's own container or, if that container were ever a `<p>` itself, nest
 * block content inside block content.
 */

import { EditableField } from "@design-system";
import { formatLinkDisplay } from "../../lib/contact.ts";
import type { ProfileOverride } from "../../hooks/useEditableParse.ts";
import { RemoveButton } from "./ReconstructedAdd.tsx";
import { ProfileLinkAdd } from "./ProfileLinkAdd.tsx";

interface ContactExtraLinksProps {
  profiles: readonly ProfileOverride[];
  onAdd: (url: string) => string | undefined;
  onEdit: (id: string, url: string) => void;
  onRemove: (id: string) => void;
}

export function ContactExtraLinks({
  profiles,
  onAdd,
  onEdit,
  onRemove,
}: ContactExtraLinksProps) {
  return (
    <>
      {profiles.map((profile, i) => (
        <span key={profile.id} className="inline-flex items-center gap-x-2">
          {i > 0 && <span className="text-content-muted">·</span>}
          <span className="inline-flex items-center gap-1">
            <EditableField
              value={profile.url}
              displayValue={formatLinkDisplay(profile.url)}
              label={profile.network}
              textSize="sm"
              onCommit={(v) => onEdit(profile.id, v)}
            />
            <a
              href={profile.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-primary hover:underline"
              aria-label={`Open ${profile.network} in a new tab`}
            >
              ↗
            </a>
            <RemoveButton
              label={`Remove ${profile.network} link`}
              onClick={() => onRemove(profile.id)}
            />
          </span>
        </span>
      ))}
      {/* No leading `·` before the pill (#953). A separator earned its place
          while this component owned a whole links line and the pill terminated
          it; in the merged add row the pill is a button sitting beside the
          work-auth pill, which gets no separator of its own — the row's `gap-2`
          is what divides them. The span wrapper stays: it is the direct flex
          child that absorbs `AddPill`'s `self-start`, which would otherwise
          misalign the pill in the `items-center` row. */}
      <span className="inline-flex items-center gap-x-2">
        <ProfileLinkAdd onAdd={onAdd} label="Add a profile" stayOpenAfterAdd />
      </span>
    </>
  );
}
