// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * FixItTarget — an inline `<span>` Fix It anchor (#810), for call sites that
 * mint one per item of a list and so cannot call `useFixItTarget` themselves
 * (`ContactDetails`' field rows). Everything else calls the hook directly.
 *
 * `anchorId` is optional so a call site whose anchor moves between siblings
 * (`RoleHeader`'s start date) can keep the wrapper mounted while it is not the
 * anchor: swapping the span in and out would remount whatever it wraps.
 */

import type { ReactNode } from "react";
import { useFixItTarget } from "../../hooks/useFixItMode.ts";

export function FixItTarget({
  anchorId,
  className = "",
  children,
}: {
  anchorId?: string;
  className?: string;
  children: ReactNode;
}) {
  // "" can never be the active anchor, so an unanchored wrapper never lights up.
  const target = useFixItTarget(anchorId ?? "", "inline");
  return (
    <span
      id={anchorId}
      tabIndex={anchorId === undefined ? undefined : target.tabIndex}
      className={`${className} ${target.className}`}
    >
      {children}
    </span>
  );
}
