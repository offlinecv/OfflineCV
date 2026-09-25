// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FixItScope — Fix It's two contexts and its dock, around one lane's résumé.
 *
 * Both lanes that render an editable résumé mount it: `Result` on `/`, and
 * `AuthoringResume` for a résumé started from scratch. It exists
 * because the tinted bullet markers (#913) read their step from
 * `FixItEntryContext`, so a lane that mounts the résumé without these
 * providers silently shows no marker on a bullet that fails every check — the
 * authoring lane did that until both lanes shared this piece.
 *
 * Two providers, not one: `FixItContext` carries only the active anchor, so a
 * re-grade that leaves the step alone re-renders no target, while
 * `FixItEntryContext` moves with every re-grade (see `useFixItStep`). The
 * dock renders as the providers' next sibling, only while the mode is active.
 *
 * The lane owns `useScoreFixIt` rather than this component, because its Fix
 * It entry button (`ScoreDetails`) sits outside the résumé these providers
 * wrap.
 */

import { useMemo } from "react";
import type { ReactNode } from "react";
import type { GuidanceItem } from "../../lib/score/guidance.ts";
import {
  FixItContext,
  FixItEntryContext,
  type FixItMode,
} from "../../hooks/useFixItMode.ts";
import { FixItToolbar } from "./FixItToolbar.tsx";

export function FixItScope({
  fixIt,
  items,
  children,
}: {
  fixIt: FixItMode;
  items: readonly GuidanceItem[];
  children: ReactNode;
}) {
  // Memoised so a re-grade that leaves the step alone re-renders no target.
  const context = useMemo(
    () => ({ activeAnchor: fixIt.activeAnchor }),
    [fixIt.activeAnchor],
  );
  return (
    <>
      <FixItContext.Provider value={context}>
        <FixItEntryContext.Provider value={fixIt.entry}>
          {children}
        </FixItEntryContext.Provider>
      </FixItContext.Provider>
      {fixIt.active && (
        <FixItToolbar
          items={items}
          currentIndex={fixIt.index}
          onNavigate={fixIt.navigate}
          onExit={fixIt.exit}
        />
      )}
    </>
  );
}
