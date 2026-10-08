// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Popover — a click-triggered, non-modal panel for rich (paragraph-length)
 * content anchored to a trigger.
 *
 * `Dialog` is the ONE modal primitive: it traps focus, dims the page, and
 * demands a decision. A Popover is quieter — an explainer, a hint, a bit of
 * "why does this number look like that" prose that the user can dismiss by
 * clicking away without it ever having taken over the page. (Below `sm` the
 * panel becomes a bottom sheet over a tap-to-dismiss scrim (#971) — visual
 * only: still no focus trap, still no decision demanded.) Reaching for
 * `Dialog` for that case (as `AtsScoreReadout`'s old `<details>` block half-did)
 * either over-escalates a footnote into a modal, or under-escalates into a
 * bespoke `useState` + click-outside listener re-rolled at every callsite.
 * This is that listener, written once.
 *
 * The dismiss pattern (outside click + Escape) began life as a COPY of
 * `AchievementTypePicker`'s inline menu (#456). That copy is now gone: the
 * picker consumes this primitive instead (#953), so exactly one implementation
 * of the listener exists and the two cannot drift apart. `role`, `panelLabel`
 * and `trigger` are not general-purpose pass-throughs — they exist to carry the
 * only two shapes in the tree, an explainer dialog and a choice menu, down one
 * code path. A panel whose own controls dismiss it takes a function child and
 * gets `close`, rather than re-rolling the open state the primitive owns.
 *
 * The trigger MUST be a `<button>` — always the `Button` primitive, never an
 * `<a>`. This is not just the house "no raw markup" rule: at least one real
 * caller (`AtsScoreReadout`) renders exactly three `<a href="#…">` scroll
 * anchors and asserts that count in a regression test
 * (`AtsScoreReadout.test.tsx`). An anchor-trigger Popover dropped into that
 * section would silently inflate the anchor count and break an unrelated
 * assertion — so the primitive enforces the button by construction instead of
 * documenting it as a convention a caller could get wrong.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "./Button.tsx";

// Panel chrome mirrors `Dialog.tsx`'s CHROME constant (radius/border/bg/
// shadow/text), minus the modal-only backdrop rules — above `sm` a Popover
// never dims the page (below it, see `SCRIM`). `absolute` + `z-20` + `mt-1` positions it under the trigger, the
// same convention `AchievementTypePicker`'s menu uses.
//
// `w-72` is the preferred width and the `max-w` clamp BOUNDS THAT WIDTH — it
// keeps a 288px panel from being wider than a narrow viewport. It does not
// position anything, which is worth stating plainly because this comment used
// to claim the clamp was "what keeps it on screen". It is not: the panel is
// anchored to one of the trigger's edges, so where it lands is `align`'s job.
//
// Hence `align`. A trigger near the right edge — the docked score strip's ⓘ
// sits in the last group of a `justify-between` row, and below `sm` the middle
// group is hidden, which pins it right against the edge — opens a `left-0`
// panel straight off the viewport. No ancestor sets `overflow`, so nothing
// clips it into a scrollable area; it just overhangs, and on the state most
// users end up in. `right-0` anchors the other edge instead, which is a class
// swap rather than the JS positioning this dependency-free primitive avoids.
//
// `align` only picks WHICH trigger edge the panel hangs off, and at narrow
// viewports a 288px (or even the `max-w`-clamped ~343px) panel routinely has
// nowhere on either edge that keeps it fully on screen — measured off-screen
// in BOTH alignments at 375px (#959). Below `sm` the `max-sm:*` classes
// therefore stop anchoring the panel to the trigger at all and pin it to the
// VIEWPORT instead: `fixed` + `inset-x-4` centers it in a 2rem-gutter column
// regardless of `align`, and `top-auto` + `bottom-4` (rather than leaving
// `top-full` in effect) is load-bearing — for a `fixed` element `top: 100%`
// resolves against the viewport's height, not the trigger's, so without the
// override the panel renders a full viewport-height below the trigger,
// entirely off-screen; a bottom-anchored sheet is the one placement that
// stays reachable independent of where on the page the trigger sits. This
// is CSS-only, per the primitive's no-JS-positioning constraint above — no
// floating-ui, no measured trigger rect — and confirmed empirically (not
// just reasoned about) with a real Chromium page at 375px, since the
// `top: 100%` behavior above is exactly the kind of thing that looks right
// on paper and renders the panel invisible in practice.
//
// The breakpoint stays `sm` (640px). Review proposed narrowing it to 480px,
// on the grounds that an anchored panel is already contained at 560 and 639
// so pinning it there buys nothing. Measured across the range that argument
// skips, the narrowing REOPENS this bug: panel right edge is a constant 558px
// (trigger x 269.8 + `w-72`), so at 481 it overflows by 76.8px and at 500 by
// 57.8px — contained only from 558 up. The binding caller is the EXPANDED
// header explainer (`align=start`), whose trigger x is fixed by that row's
// copy; the docked strip's own trigger tracks the viewport via
// `justify-between` and stops overflowing above ~460px, so it is not what
// sets the floor. A 560px threshold clears the binding case by 2.2px, which
// is luck, not margin — and the next defensible stop, 600px, buys an 80px
// band in exchange for a margin that a single added word in the heading above
// would silently eat, since `w-72` is fixed and the trigger's x is set by
// that copy. `max-sm` is the narrowest threshold worth having.
//
// `max-h` + `overflow-y-auto` bound the sheet: `top:auto; bottom:16px;
// height:auto` grows UPWARD without limit, and a long panel was measured at
// h 1206 / y -410 with nothing scrollable — invisible off the top. Today's
// two callers happen to fit; this is a shared primitive, so it must not
// depend on that.
//
// `max-sm:fixed` pins to the viewport only while no ancestor establishes a
// containing block for fixed descendants — a non-`none` `transform`,
// `filter`, `backdrop-filter` or `perspective`, `contain: paint|layout`, or a
// `will-change` naming one of those. Under such an ancestor the sheet pins to
// THAT box instead. Today's callers are clear (both render in `PageShell`'s
// children, a sibling of its header), but the header itself is
// `backdrop-blur` and exposes `headerExtra`, so a `Popover` placed there would
// anchor to the header, not the viewport. The containment e2e cannot catch
// this: a header-anchored sheet still passes every on-screen bound it checks.
//
// `max-sm:overflow-x-hidden` + `break-words` (#971): CSS coerces a `visible`
// axis to `auto` when the OTHER axis is not `visible`, so `overflow-y-auto`
// alone silently makes `overflow-x` resolve to `auto` too — a future caller
// with a long unbreakable string would get a horizontal scrollbar inside the
// sheet instead of a wrap. `break-words` is unprefixed (not `max-sm:`-gated),
// as #971 specifies, so it applies at every width: above `sm` it makes an
// unbreakably-long word wrap inside the fixed `w-72` panel instead of running
// past its edge. No overflow class is added above `sm`.
const PANEL_BASE =
  "absolute top-full z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border-light bg-surface-card p-3 text-content-primary shadow-lg break-words max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:bottom-4 max-sm:w-auto max-sm:max-h-[calc(100vh-2rem)] max-sm:overflow-y-auto max-sm:overflow-x-hidden";

// The below-`sm` scrim (#971): a non-modal panel pinned to the viewport reads
// as a stray overlay rather than a layer, and — measured at 375px — it can
// occlude unrelated controls with nothing telling the user a layer is open.
// `hidden max-sm:block` keeps it out of the DOM's rendered box (and out of
// EVERY breakpoint above `sm`, where the panel stays trigger-anchored and
// nothing about this primitive changes) until the narrow breakpoint turns it
// back on; `max-sm:fixed max-sm:inset-0` then covers the viewport the same
// way `PANEL_BASE`'s `max-sm:fixed` does, and the same containing-block
// caveat documented above applies to both. `z-10` sits below the panel's
// `z-20` — scrim, then sheet, same order a modal paints in. The token mirrors
// `Dialog.tsx`'s `CHROME` (`backdrop:bg-content-primary/40
// backdrop:backdrop-blur-sm`) rather than inventing a second dim value: same
// visual weight, just on a plain element instead of `::backdrop`, since this
// primitive renders no `<dialog>`.
//
// `aria-hidden` + no `tabIndex`: the scrim is decorative and tap-to-dismiss
// only, never a focus stop and never announced — `Popover` stays non-modal
// semantically (no trap, `role="dialog"`/`menu` only), so nothing here should
// make it read as one to assistive tech.
const SCRIM =
  "hidden max-sm:block max-sm:fixed max-sm:inset-0 max-sm:z-10 max-sm:bg-content-primary/40 max-sm:backdrop-blur-sm";

/** Which of the trigger's edges the panel is anchored to. */
const PANEL_ALIGN = { start: "left-0", end: "right-0" } as const;

interface PopoverProps {
  /** Accessible name for the trigger button — and for the panel too, unless
   *  `panelLabel` overrides it. */
  label: string;
  /** Visible trigger content — an icon glyph, a short word, etc. Kept
   *  separate from `label` because the visible content is often a
   *  decorative/short mark while the accessible name should read as a
   *  sentence ("How is this scored?" rather than "ⓘ"). */
  triggerContent: ReactNode;
  /** Panel body. A FUNCTION child receives `{ close }`, which is how a panel
   *  whose own controls dismiss it (a menu that closes on pick) does so without
   *  re-rolling the open/close state the primitive already owns. */
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  /** Panel semantics. `dialog` (default) for an explainer; `menu` for a list of
   *  choices. The trigger's `aria-haspopup` is derived from this rather than
   *  passed separately — the two must never disagree, so they share one source. */
  role?: "dialog" | "menu";
  /** Accessible name for the PANEL when it must differ from the trigger's — a
   *  menu trigger often names the current VALUE ("Achievement type: Patent.
   *  Change it.") while the panel should name the CHOICE ("Achievement type"). */
  panelLabel?: string;
  /** Trigger presentation. Defaults to the `icon` variant. Grouped into one
   *  object rather than flattened into `triggerVariant`/`triggerClassName` so
   *  the prop list does not sprawl as trigger needs grow. */
  trigger?: { variant?: ButtonVariant; className?: string };
  /** Which trigger edge the panel is anchored to. `start` (default) opens
   *  rightwards from the trigger's left edge; `end` opens leftwards from its
   *  right edge, which is what keeps a right-anchored trigger's panel on
   *  screen. This cannot be done through `className` — `PANEL_BASE` would still
   *  carry the opposing class and the repo ships no `tailwind-merge`. */
  align?: "start" | "end";
  /** Extra classes appended to the panel for positioning or width.
   *
   *  NOTE: this APPENDS, and the repo ships no `tailwind-merge`/`clsx`, so it
   *  cannot override a property `PANEL` already sets — Tailwind emits `p-2`
   *  before `p-3`, so a caller passing `p-2` still renders `p-3`. Panel padding
   *  is therefore uniform at `p-3`, deliberately.
   *
   *  ACCEPTED CONSEQUENCE (#953): `AchievementTypePicker`'s menu went from
   *  `p-2` to `p-3` when it adopted this primitive — a real +4px density
   *  change to a shipping surface, not an oversight. It was chosen over the two
   *  alternatives: adding a padding prop (prop sprawl on a primitive), or
   *  dropping `p-3` from `PANEL` (which would silently un-pad every existing
   *  caller). Use `className` only for properties `PANEL` leaves alone. */
  className?: string;
}

export function Popover({
  label,
  triggerContent,
  children,
  role = "dialog",
  panelLabel,
  trigger,
  align = "start",
  className,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Focus management. `role="dialog"` without it would be a REGRESSION on what
  // this primitive replaced: a native `<details>`/`<summary>`, which browsers
  // make keyboard-operable and screen-reader-announced for free. So move focus
  // into the panel on open — the panel is `tabIndex={-1}`, programmatically
  // focusable but not in the tab order — and hand it back to the trigger on
  // close so the user resumes where they left off instead of at the top of the
  // document. `wasOpen` gates the restore to a REAL close: without it the
  // initial mount (never opened) would yank focus to the trigger on page load.
  //
  // Not a focus TRAP — a Popover is non-modal, so tabbing onward out of the
  // panel is correct behaviour and `Dialog` remains the primitive that traps.
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    } else if (wasOpen.current) {
      // `:scope > button` IS the trigger, by construction — it cannot match a
      // button inside the panel. That matters: the picker's panel is a grid of
      // `role="menuitemradio"` buttons, so a mis-resolution would drop focus on
      // a preset. A bare `"button"` also works today, but only because the
      // panel happens to be unmounted by the time this runs — a proof resting
      // on unmount ordering, which would break silently behind an exit
      // transition, a delayed unmount, or a hidden-but-mounted panel.
      rootRef.current
        ?.querySelector<HTMLButtonElement>(":scope > button")
        ?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  // Dismiss on outside click / Escape. The panel is the only thing holding
  // focus, so leaving it any other way would strand it open over the page.
  // This is the single copy of the listener both callers share.
  //
  // The below-`sm` scrim (#971) dismisses through its OWN `onClick`, not
  // through this listener: the scrim is a child of `rootRef`, so a tap on it
  // never satisfies this handler's `!contains` check and `close()` never
  // double-fires for the same tap.
  //
  // Escape is marked handled (`preventDefault`): the keydown keeps bubbling to
  // `window`, where a page-level listener — Fix It's dock (#810) — reads an
  // unclaimed Escape as its own and would exit too (#1001).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const panel = `${PANEL_BASE} ${PANEL_ALIGN[align]}`;
  const panelCls = className ? `${panel} ${className}` : panel;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <Button
        variant={trigger?.variant ?? "icon"}
        className={trigger?.className}
        aria-haspopup={role}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {triggerContent}
      </Button>

      {open && (
        <>
          <div aria-hidden="true" onClick={close} className={SCRIM} />
          <div
            ref={panelRef}
            id={panelId}
            role={role}
            aria-label={panelLabel ?? label}
            tabIndex={-1}
            className={panelCls}
          >
            {typeof children === "function" ? children({ close }) : children}
          </div>
        </>
      )}
    </div>
  );
}
