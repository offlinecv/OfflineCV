// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fix It's keyboard (#810): Escape finishes, ←/→ step.
 *
 * The listener sits on `window`, so it hears every key on the page, and the
 * invariant is that it acts only on a key nothing else claimed. That rule is
 * `fixItKeyAction`, pure over the event and the document so it is tested at
 * module scope; the hook is only the subscription.
 *
 * - A field, popover or menu that consumed the key has called `preventDefault`
 *   (an `EditableField` cancelling on Escape, a `Popover` dismissing — #1001).
 *   React's handlers and `document` listeners both run before `window`.
 * - An open native `<dialog>` closes on Escape WITHOUT preventing it, so while
 *   one is open every key is the dialog's.
 * - Arrows stand aside for anything that moves a caret or a selection with
 *   them, and for modified arrows (word / line jumps, history navigation).
 *
 * The hook subscribes once per mount and reads the latest handlers through a
 * ref, so a re-grade on every keystroke does not re-attach the listener.
 */

import { useEffect, useRef } from "react";

export type FixItKeyAction = "exit" | "next" | "prev";

export function fixItKeyAction(e: KeyboardEvent): FixItKeyAction | null {
  if (e.defaultPrevented) return null;
  if (document.querySelector("dialog[open]")) return null;
  if (e.key === "Escape") return "exit";
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return null;
  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  const el = document.activeElement;
  if (
    el instanceof HTMLElement &&
    (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))
  ) {
    return null;
  }
  return e.key === "ArrowRight" ? "next" : "prev";
}

export function useFixItKeyboard(
  handlers: Record<FixItKeyAction, () => void>,
): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = fixItKeyAction(e);
      if (!action) return;
      e.preventDefault();
      latest.current[action]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
