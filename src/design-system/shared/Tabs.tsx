// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
 *   – Triggers use the <Button> primitive — no raw <button> in feature/primitive code.
 *   – Inactive panels stay mounted (hidden attr) so child UI state survives a switch.
 */

import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { Button } from "../primitives/Button.tsx";

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
      className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border-light"
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
}

export function Tab({ id, children, count }: TabProps) {
  const { value, onValueChange, baseId } = useTabsContext("Tab");
  const isActive = value === id;
  const activeCls = isActive
    ? "border-brand-amber text-content-primary font-semibold"
    : "border-transparent text-content-secondary font-medium hover:text-content-primary";

  return (
    <Button
      variant="ghost"
      role="tab"
      id={tabId(baseId, id)}
      data-tab-id={id}
      aria-selected={isActive}
      aria-controls={panelId(baseId, id)}
      tabIndex={isActive ? 0 : -1}
      onClick={() => onValueChange(id)}
      className={`-mb-px rounded-none border-b-2 px-3 py-2 text-base hover:bg-transparent ${activeCls}`}
    >
      {children}
      {count != null && count > 0 && (
        <span className="ml-1.5 rounded-full bg-surface-subtle px-1.5 text-xs text-content-secondary">
          {count}
        </span>
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
