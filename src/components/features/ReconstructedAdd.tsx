// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ReconstructedAdd — shared "+ Add" affordances for the reconstructed-resume
 * surface (#180-followup). The parser can only correct what it found; these let
 * the user ADD what it missed entirely — a whole role / degree / project /
 * achievement, or a bullet under any entry — wired to useEditableParse's added*
 * channels so an addition re-grades the score AND flows into the PDF.
 *
 * Reuse analysis: this is a NEW shared file (not a parallel surface). It owns
 * the one progressive-disclosure "+ pill" pattern the Skills add input pioneered
 * (#180), so every section discloses an add affordance the same way instead of
 * each re-rolling it. Built entirely from the @design-system Button primitive +
 * semantic tokens — no raw <button>, no hardcoded palette.
 *
 * `AddPill` and `RemoveButton` are edit chrome (#913, styles/edit-chrome.css):
 * inside the résumé they rest hidden on a fine pointer and show while their
 * nearest `edit-scope` — row, entry, section, header block — is hovered or
 * holds focus. They stay in the tab order throughout. Outside any scope they
 * are always visible, so a reuse elsewhere is unaffected.
 */

import { useCallback, useState } from "react";
import type { FocusEvent } from "react";
import { Button, InlineResult } from "@design-system";

/**
 * Build an `onBlur` handler for a section container that fires `onExit` when
 * focus leaves the section's DOM subtree (the standard
 * `currentTarget.contains(relatedTarget)` idiom, shared with
 * {@link InlineBulletAdd}). Used to prune a blank "ghost" entry the user opened
 * with "+ Add …" and abandoned without typing (#379): the "+ Add" pill lives
 * inside the section and holds focus after the click, so a focus-exit fires
 * reliably even though the click-to-edit fields never autofocus.
 *
 * The prune is deferred one tick because a field commit fires on the SAME blur
 * event that leaves the section; running `onExit` synchronously would test the
 * entry's emptiness against pre-commit state and wrongly drop an entry the user
 * just typed into. The macrotask lets React flush the commit first.
 */
export function sectionExitBlur(
  onExit: () => void,
): (e: FocusEvent<HTMLElement>) => void {
  return (e) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setTimeout(onExit, 0);
  };
}

/** A small X glyph, matching the SkillChip remove control. */
function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

/**
 * The one-line prompt an EMPTY section shows above its {@link AddPill} (#380).
 *
 * A section that renders with no entries is ambiguous in a way that matters
 * here: it reads as "the parser found your achievements and dropped them" when
 * what it means is "this section is empty — you can fill it." The pattern that
 * resolves it is the standard guided empty state (a helpful message plus the
 * action, never bare blank space), with one constraint the copy must honour: it
 * describes what BELONGS in the section, and makes no claim about what the
 * parser did or did not find. We cannot tell "the résumé had none" apart from
 * "we missed them", so any finding-shaped wording ("no achievements detected")
 * would either be a guess or reinforce the very reading we are fixing. The
 * `AddPill` below it stays the reachable input path, untouched — the block-level
 * "add a whole entry" affordance it already is.
 */
export function SectionEmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-content-tertiary">{children}</p>;
}

/**
 * Where a floating pill sits on a fine pointer (`edit-float`, styles/
 * edit-chrome.css), relative to its `relative` host:
 *
 *   heading  top-right of a section, level with its `SectionHeading` — the
 *            section's own "+ Add entry" pill.
 *   below    in the gap under an entry — a role's "+ Add bullet". The host's
 *            list must leave more than the pill's height between entries on a
 *            fine pointer (`pointer-fine:gap-8`), or the revealed pill touches
 *            the next one.
 *
 * A floating pill is one line shorter on a fine pointer (`py-0.5`, 24px —
 * still the SC 2.5.8 target) so it fits the gap it floats in; on a coarse
 * pointer it stays in flow, so it keeps the in-flow pill's `py-1`.
 */
export type AddPillFloat = "heading" | "below";

const FLOAT_CLASS: Record<AddPillFloat, string> = {
  heading:
    "edit-float top-[var(--edit-float-inset,0px)] right-[var(--edit-float-inset,0px)] py-1 pointer-fine:py-0.5",
  below: "edit-float left-0 top-full py-1 pointer-fine:py-0.5",
};

/**
 * The collapsed progressive-disclosure trigger — a chip-shaped "+ <label>" pill
 * that sits inline with the content it adds to. Quiet by default; warms to the
 * brand accent on hover.
 */
export function AddPill({
  label,
  onClick,
  fixItFocus = false,
  float,
}: {
  label: string;
  onClick: () => void;
  /** Mark this as where a Fix It step on its section lands focus (#810) —
   *  set on a section's own "Add entry" pill, never a per-entry one. */
  fixItFocus?: boolean;
  /** Take the pill out of flow on a fine pointer — see {@link AddPillFloat}. */
  float?: AddPillFloat;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      data-fixit-focus={fixItFocus || undefined}
      aria-label={label}
      className={`edit-chrome self-start rounded-full bg-surface-subtle px-2.5 text-sm text-content-tertiary hover:text-accent-primary ${float ? FLOAT_CLASS[float] : "py-1"}`}
    >
      + {label}
    </Button>
  );
}

/**
 * A quiet remove (X) control for a user-added entry or bullet.
 *
 * The `icon` Button variant carries the 24×24 CSS-px WCAG 2.2 AA SC 2.5.8 TOUCH
 * TARGET (24, not 44 — see #581/#591) on its own, via a fixed, centred invisible
 * `after:` overlay (`Button.tsx`, #638). `min-h-6 min-w-6` here is NOT redundant
 * with that overlay — it sizes the VISIBLE box, and it is what makes the overlay
 * cost zero overflow:
 *
 *   - Visible affordance. `variant="icon"` paints `hover:bg-surface-subtle` and
 *     a `focus-visible` ring on the real box. The `CloseIcon` glyph is 10×10 and
 *     the variant adds only `p-0.5`, so without the minimum the hover rectangle
 *     and the focus ring shrink to ~14×14 — a ~40%-per-dimension regression in
 *     the affordance the user actually sees and aims at (#638 review).
 *   - Zero overflow. A 24×24 visible box means the centred 24×24 overlay lands
 *     entirely inside it, so the target never bleeds past the button. At 14×14 it
 *     overhangs 5px per side, which is wider than the `gap-1` (4px) separating
 *     this control from its neighbour in `ReconstructedRole`'s and
 *     `ContactExtraLinks`' action rows — and, being DOM-later, it would win
 *     hit-testing over that neighbour's visible box (the #581/#591 class).
 *
 * `inline-flex items-center justify-center` in Button's BASE keeps the glyph
 * centred as the box grows. Set here rather than on the variant so the change
 * stays scoped to the controls this file owns.
 */
export function RemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="icon"
      aria-label={label}
      onClick={onClick}
      className="edit-chrome min-h-6 min-w-6 shrink-0 text-content-muted hover:text-content-secondary"
    >
      <CloseIcon />
    </Button>
  );
}

/**
 * A two-step remove control for a résumé ENTRY (role / project / achievement /
 * education) — as opposed to {@link RemoveButton}'s bare one-click affordance,
 * which is what every entry used until #860.
 *
 * Deleting an entry takes every bullet rendered under it with it
 * (`removeEntryWithBullets`), and for a PARSED entry the only way back is
 * `resetAll` (which discards every edit in the session) or re-uploading the
 * PDF — the more expensive, less recoverable action, guarded by nothing, while
 * the per-bullet remove one level down (`useBulletRemoveStatus`, #626) at
 * least confirms AFTER the fact with an Undo. This confirms BEFORE instead: the
 * first click arms the row, naming the blast radius; a second click on
 * "Remove" is what actually calls `onRemove`. Escape, a blur out of the
 * control, or the explicit Cancel all disarm with no write to the edit model.
 *
 * Plain local `useState`, not the lifted `removes.pending` shape
 * `useBulletRemoveStatus` needs — that hook lives ABOVE the bullet row because
 * a bullet remove is immediate and unmounts the row before any state it held
 * could paint a confirmation. Here the write has not happened yet, so the row
 * this button lives in is still mounted while it is armed, and there is
 * nothing to lift.
 *
 * `autoFocus` on Cancel matters beyond keyboard reachability: in
 * `ReconstructedRole`, this button renders inside an `edit-chrome`-classed
 * actions span, which rests at opacity 0 unless its `edit-scope` is hovered or
 * `focus-within`. Arming can leave the pointer wherever the old button used to
 * be, not necessarily over the new confirm row, so the moved focus is what
 * keeps `focus-within` — and the confirmation itself — visible.
 *
 * `compact` drops the `InlineResult` warning chrome (border/bg/padding)
 * entirely — for the certifications middot-joined line (`ReconstructedResume`'s
 * `AchievementsSection`), that chrome's own `p-3` pushed the armed row's
 * baseline off its still-idle siblings sharing the same wrapped flex line. A
 * bare inline cluster keeps the same baseline the idle button sat on.
 *
 * `identity` disambiguates two entries of the same kind armed at once: every
 * role's confirm row otherwise carries the same "Remove role" / "Cancel"
 * pair, so arming a second role before resolving the first gives AT two
 * identical-sounding control groups. The confirm row is wrapped in a named
 * `role="group"` (`entryNoun` + `identity`) rather than renaming the buttons
 * themselves, because the idle affordance and the armed "Remove" button
 * share one `aria-label` on purpose (existing `[aria-label="Remove …"]` test
 * selectors click straight through the arm→confirm transition on it).
 * Callers pass whatever already identifies the entry on screen (a role's
 * `roleLabel`, an education's institution, a project's or achievement's
 * title) — never a fresh lookup.
 */
export function EntryRemoveButton({
  label,
  entryNoun,
  bulletCount,
  onRemove,
  compact = false,
  identity,
}: {
  /** `aria-label` for the idle affordance, e.g. "Remove role". */
  label: string;
  /** Singular noun naming what's being removed in the confirm copy, e.g.
   *  "role", "project", "certification", "education entry". */
  entryNoun: string;
  /** Bullets that go with the entry, named in the confirm copy so the blast
   *  radius is not a surprise (#860). Zero (Education, which owns no bullets)
   *  drops the clause instead of claiming a count that isn't there. */
  bulletCount: number;
  onRemove: () => void;
  /** Set for an entry sharing the certifications compact middot line — skips
   *  the `InlineResult` chrome so the armed confirm keeps the row's shared
   *  baseline instead of growing a bordered/padded strip mid-line. */
  compact?: boolean;
  /** Text naming THIS entry (a company, an institution, a title) — folded
   *  into the armed confirm row's group name so two entries of the same kind
   *  armed at once don't announce identically. Omitted (blank added entry)
   *  falls back to the bare `entryNoun`. */
  identity?: string;
}) {
  const [armed, setArmed] = useState(false);
  const disarm = useCallback(() => setArmed(false), []);
  const bulletClause =
    bulletCount > 0
      ? ` and its ${bulletCount} bullet${bulletCount === 1 ? "" : "s"}`
      : "";
  const confirmCopy = `Remove this ${entryNoun}${bulletClause}?`;
  // Rendered unconditionally (empty while idle), same idiom as CopyButton's
  // live region: assistive tech needs the node in the DOM before arming
  // changes its text, or the first arm announces nothing.
  const liveRegion = (
    <span className="sr-only" role="status" aria-live="polite">
      {armed ? confirmCopy : ""}
    </span>
  );

  if (!armed) {
    return (
      <span className="inline-flex">
        <RemoveButton label={label} onClick={() => setArmed(true)} />
        {liveRegion}
      </span>
    );
  }

  const confirmContent = (
    <>
      <span className="text-content-secondary">{confirmCopy}</span>
      <Button
        variant="secondary"
        size="sm"
        aria-label={label}
        onClick={onRemove}
      >
        Remove
      </Button>
      <Button variant="ghost" size="sm" autoFocus onClick={disarm}>
        Cancel
      </Button>
    </>
  );

  return (
    <span
      className="inline-flex"
      // Named group, not a rename of the Remove/Cancel buttons themselves —
      // two entries armed at once would otherwise still expose two identical
      // "Remove <noun>"/"Cancel" names (existing `[aria-label="Remove …"]`
      // test selectors key on that shared name for the idle→confirm
      // transition). The group name is what lets AT tell the pairs apart.
      role="group"
      aria-label={identity ? `${entryNoun}: ${identity}` : entryNoun}
      onBlur={sectionExitBlur(disarm)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          disarm();
        }
      }}
    >
      {compact ? (
        <span className="inline-flex flex-wrap items-baseline gap-2 text-sm">
          {confirmContent}
        </span>
      ) : (
        <InlineResult
          tone="warning"
          className="flex flex-wrap items-center gap-2 py-1.5 text-sm"
        >
          {confirmContent}
        </InlineResult>
      )}
      {liveRegion}
    </span>
  );
}

/**
 * Single-line progressive-disclosure add input — collapses to a "+ <label>"
 * pill, expands on click to an autofocused field + Add button, and collapses
 * back on Escape or empty blur. Stays open after a commit so several lines can
 * be added in a row. Mirrors the Skills add pattern, minus skill suggestions.
 *
 * `float` applies to the collapsed pill only: the open input is in flow, since
 * the user asked for it and the content below it should make room.
 */
export function InlineBulletAdd({
  onAdd,
  label = "Add bullet",
  placeholder = "Bullet text…",
  float,
}: {
  onAdd: (text: string) => void;
  label?: string;
  placeholder?: string;
  float?: AddPillFloat;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setDraft("");
  };

  if (!expanded) {
    return (
      <AddPill label={label} onClick={() => setExpanded(true)} float={float} />
    );
  }

  return (
    <div
      className="flex items-center gap-2"
      onBlur={(e) => {
        if (
          !e.currentTarget.contains(e.relatedTarget as Node | null) &&
          draft.trim().length === 0
        ) {
          setExpanded(false);
        }
      }}
    >
      <input
        type="text"
        value={draft}
        autoFocus
        aria-label={label}
        placeholder={placeholder}
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
        className="min-w-0 flex-1 rounded border border-border bg-surface-card px-2 py-1 text-sm text-content-primary outline-hidden focus:ring-1 focus:ring-accent-primary"
      />
      <Button
        variant="primary"
        size="sm"
        onClick={commit}
        disabled={draft.trim().length === 0}
        aria-label={label}
      >
        Add
      </Button>
    </div>
  );
}
