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
 */

import { EditableField } from "@design-system";
import { formatLinkDisplay } from "../../lib/contact.ts";
import type { ProfileOverride } from "../../hooks/useEditableParse.ts";
import { RemoveButton } from "./ReconstructedAdd.tsx";
import { ProfileLinkAdd } from "./ProfileLinkAdd.tsx";

interface ContactExtraLinksProps {
  profiles: readonly ProfileOverride[];
  onAdd: (url: string) => void;
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
    <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
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
      <span className="inline-flex items-center gap-x-2">
        {profiles.length > 0 && <span className="text-content-muted">·</span>}
        <ProfileLinkAdd onAdd={onAdd} label="Add a profile" stayOpenAfterAdd />
      </span>
    </p>
  );
}
