// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ProfileLinkAdd — the GUIDED profile-link add affordance for the contact card.
 *
 * Replaces the bare `https://…` field a naive user got no help with. Collapsed,
 * it is a quiet "+ <label>" pill; expanded, it offers tappable network chips
 * (LinkedIn / GitHub / GitLab / Portfolio — see `PROFILE_QUICK_PICKS`) that
 * pre-fill the host prefix and drop the caret after it, so the user types only
 * their handle. A persistent helper line names the rest of the recognized hosts
 * ("…and more are recognized automatically"), turning "what do I paste?" into
 * "it'll figure it out". The committed URL is classified downstream the same way
 * a pasted one is — no new parse path.
 *
 * Reuse analysis: a NEW shared surface, not a parallel one. It reuses the
 * `AddPill` collapsed trigger and the `@design-system` `Button` primitive; the
 * network chip-picker + helper text are genuinely new (no existing surface owns
 * "choose a profile network"). Both add points that need this — the empty
 * "Professional profile" links row and the extra-links "+ Add" — consume THIS
 * one component instead of each re-rolling a URL input. The quick-pick data is
 * derived from `PROFILE_HOSTS`, so the picker never drifts from what we accept.
 */

import { useRef, useState } from "react";
import { Button } from "@design-system";
import {
  PROFILE_QUICK_PICKS,
  otherRecognizedNetworks,
} from "../../lib/contact/profile-registry.ts";
import { AddPill } from "./ReconstructedAdd.tsx";

interface ProfileLinkAddProps {
  /** Commit the entered URL (raw string; classified by the caller's sink). */
  onAdd: (url: string) => void;
  /** Collapsed-pill label, e.g. "Add a professional profile" / "Add a profile". */
  label?: string;
  /** Keep the input open after a commit so several links can be added in a row
   *  (the extra-links use). The single required-slot use collapses after one. */
  stayOpenAfterAdd?: boolean;
}

/** The recognized-but-not-a-chip hosts, e.g. "ORCID, Google Scholar, Substack".
 *  Capped so the helper stays one readable line; "and more" covers the tail. */
const HELPER_EXAMPLES = otherRecognizedNetworks().slice(0, 3).join(", ");

export function ProfileLinkAdd({
  onAdd,
  label = "Add a profile",
  stayOpenAfterAdd = false,
}: ProfileLinkAddProps) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    const trimmed = draft.trim();
    // Ignore an empty entry or a bare scheme left from a tapped chip.
    if (!trimmed || trimmed === "https://") return;
    onAdd(trimmed);
    setDraft("");
    if (!stayOpenAfterAdd) setExpanded(false);
  };

  /** Tap a network chip: seed its prefix and drop the caret at the end so the
   *  user types straight into the handle slot. */
  const pick = (prefix: string) => {
    setDraft(prefix);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  if (!expanded) {
    return <AddPill label={label} onClick={() => setExpanded(true)} />;
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-lg bg-surface-subtle p-3 text-left"
      onBlur={(e) => {
        if (
          !e.currentTarget.contains(e.relatedTarget as Node | null) &&
          draft.trim().length === 0
        ) {
          setExpanded(false);
        }
      }}
    >
      <span className="text-xs font-medium text-content-secondary">{label}</span>

      {/* Network quick-picks — tap to pre-fill the host, then type your handle. */}
      <div className="flex flex-wrap gap-1.5">
        {PROFILE_QUICK_PICKS.map((p) => (
          <Button
            key={p.label}
            variant="ghost"
            size="sm"
            onClick={() => pick(p.prefix)}
            aria-label={`Add ${p.label}`}
            className="rounded-full bg-surface-card px-2.5 py-1 text-xs text-content-secondary hover:text-brand-amber"
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="url"
          inputMode="url"
          value={draft}
          autoFocus
          aria-label={label}
          placeholder="Tap a network above, or paste any profile URL"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft("");
              setExpanded(false);
            }
          }}
          className="min-w-0 flex-1 rounded border border-border bg-surface-card px-2 py-1 text-sm text-content-primary outline-hidden focus:ring-1 focus:ring-brand-amber"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={commit}
          disabled={draft.trim().length === 0 || draft.trim() === "https://"}
          aria-label={label}
        >
          Add
        </Button>
      </div>

      <span className="text-xs text-content-tertiary">
        {HELPER_EXAMPLES
          ? `${HELPER_EXAMPLES}, and more are recognized automatically.`
          : "Any profile or portfolio link is recognized automatically."}
      </span>
    </div>
  );
}
