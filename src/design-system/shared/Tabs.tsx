// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tabs — the ONE accessible, controlled tabbed-navigation primitive.
 *
 * Composition:
 *   <Tabs value onValueChange>            context provider wrapper
 *     <TabList aria-label>                role="tablist", roving arrow-key focus
 *       <Tab id label count?>             role="tab", aria-selected, roving tabIndex
 *     <TabPanel id>…</TabPanel>           role="tabpanel", hidden when inactive
 *
 * Accessibility:
 *   – role="tablist"/"tab"/"tabpanel", aria-selected, aria-controls/id wiring,
 *     aria-labelledby on panels.
 *   – Arrow Left/Right (+ Home/End) move between tabs AND move focus (roving
 *     tabindex). Enter/Space activate (native button behaviour).
 *
 * Design rules (CLAUDE.md):
 *   – Semantic tokens only; no hardcoded hex or raw palette classes.
 *   – Triggers use the <Button> primitive (variant="tab") — no raw <button> in
 *     feature/primitive code.
 *   – Inactive panels stay mounted (hidden attr) so child UI state survives a switch.
 *
 * Selection affordance (#516): TabList is a recessed track (bg-surface-subtle);
 * the active Tab sits on bg-surface-card + shadow-xs + font-semibold — a real
 * surface step, not a 2px underline competing with the track's own border (the
 * pre-#516 bug). Never colour alone: the weight/surface step still resolves in
 * a greyscale render.
 */

import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { Button } from "../primitives/Button.tsx";
import { CountBadge } from "./CountBadge.tsx";

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (ctx == null) {
    throw new Error(`${component} must be used within <Tabs>`);
  }
  return ctx;
}

const tabId = (baseId: string, id: string) => `${baseId}-tab-${id}`;
const panelId = (baseId: string, id: string) => `${baseId}-panel-${id}`;

interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Stable prefix for tab/panel id wiring. */
  id: string;
  children: ReactNode;
}

export function Tabs({ value, onValueChange, id, children }: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onValueChange, baseId: id }}>
      {children}
    </TabsContext.Provider>
  );
}

interface TabListProps {
  "aria-label": string;
  children: ReactNode;
}

export function TabList({ "aria-label": ariaLabel, children }: TabListProps) {
  const { value, onValueChange } = useTabsContext("TabList");
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    if (tabs.length === 0) return;
    const currentIndex = tabs.findIndex(
      (t) => t.getAttribute("data-tab-id") === value,
    );
    let nextIndex = currentIndex;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }
    const next = tabs[nextIndex];
    if (next == null) return;
    event.preventDefault();
    const nextId = next.getAttribute("data-tab-id");
    if (nextId != null) onValueChange(nextId);
    next.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="flex gap-1 overflow-x-auto overflow-y-hidden rounded-md border border-border-light bg-surface-subtle p-1"
    >
      {children}
    </div>
  );
}

interface TabProps {
  id: string;
  children: ReactNode;
  /** Optional count badge rendered after the label (e.g. layout-flag count). */
  count?: number;
  /**
   * Render a small warning dot after the label — for a tab whose content is in
   * a degraded / needs-attention state (e.g. the on-device-AI tab when WebGPU
   * is unavailable, #276). Paired with a visually-hidden label so the state
   * isn't conveyed by colour alone.
   */
  warn?: boolean;
}

export function Tab({ id, children, count, warn }: TabProps) {
  const { value, onValueChange, baseId } = useTabsContext("Tab");
  const isActive = value === id;
  // Selection carries a real surface (bg-surface-card, matching the panel
  // beneath it) plus a font-weight step — never colour alone, so the row
  // still resolves in a greyscale render (#516). The inactive track is
  // bg-surface-subtle (set on TabList), so the active tab visibly "pops"
  // off it rather than relying on a 2px underline sitting on the TabList's
  // own border (the pre-#516 illegibility bug).
  //
  // Hover on an INACTIVE tab must not borrow the selected tab's surface:
  // `hover:bg-surface-card` made a merely-pointed-at tab look selected, with
  // only font-weight left to tell them apart. It hovers to an outline instead
  // of a fill — `bg-surface-hover` alone cannot carry it, because
  // `--color-bg-hover` and `--color-bg-subtle` (the track) are the SAME value
  // in dark (#334155 → 1.00:1). The inset `ring-border-strong` reads at
  // 2.34:1 light / 2.18:1 dark against the track — enough to be perceptible
  // for a hover-only affordance (not an enumerated 1.4.11 state), but BELOW
  // that criterion's 3:1, so do not reuse this token for a persistent
  // boundary (see `CountBadge.tsx`, which needs `content-muted` for exactly
  // that reason). It stays visually distinct from selection, which is a
  // filled surface with no ring.
  const activeCls = isActive
    ? "bg-surface-card text-content-primary font-semibold shadow-xs"
    : "bg-transparent text-content-secondary font-medium hover:bg-surface-hover hover:text-content-primary hover:ring-1 hover:ring-inset hover:ring-border-strong";

  return (
    <Button
      variant="tab"
      role="tab"
      id={tabId(baseId, id)}
      data-tab-id={id}
      aria-selected={isActive}
      aria-controls={panelId(baseId, id)}
      tabIndex={isActive ? 0 : -1}
      onClick={() => onValueChange(id)}
      className={activeCls}
    >
      {children}
      <CountBadge count={count} />
      {warn && (
        <>
          {/* U+26A0 + U+FE0E (VS-15) forces TEXT presentation so the glyph
              renders monochrome (tinted by the warning token), not as a colour
              emoji — the codebase's no-emoji-as-icon rule. */}
          <span aria-hidden="true" className="ml-1.5 text-feedback-warning-text">
            {"⚠︎"}
          </span>
          <span className="sr-only"> (setup needed)</span>
        </>
      )}
    </Button>
  );
}

interface TabPanelProps {
  id: string;
  children: ReactNode;
}

export function TabPanel({ id, children }: TabPanelProps) {
  const { value, baseId } = useTabsContext("TabPanel");
  const isActive = value === id;
  return (
    <div
      role="tabpanel"
      id={panelId(baseId, id)}
      aria-labelledby={tabId(baseId, id)}
      hidden={!isActive}
      tabIndex={0}
    >
      {children}
    </div>
  );
}
