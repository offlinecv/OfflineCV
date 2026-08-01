// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared jsdom recipes for suites that drive a `Dialog`-bearing component
 * through raw `createRoot` — NOT itself a `*.test.tsx` file, so it isn't
 * picked up as a suite. Sibling of `experience-section-dom.ts`, and extracted
 * on the same bar: the `HTMLDialogElement` polyfill reached a THIRD copy
 * (`ResumeLibrary.test.tsx`, `JobLetterIndicator.test.tsx`,
 * `LetterRevealDialog.test.tsx`), and the third copy is the one that would
 * have been wrong.
 *
 * What is easy to get subtly wrong here, and why each piece is worth sharing:
 *
 *  - `Dialog`'s effect calls `showModal()` and `close()`, which jsdom does not
 *    implement at all. A suite that forgets the polyfill fails with a bare
 *    "not a function" from inside the primitive, several frames from the test.
 *  - `close()` must also DISPATCH the `close` event, not merely drop the `open`
 *    attribute: `Dialog` wires `onClose` to that event, so a polyfill that only
 *    toggles the attribute silently breaks every close-path assertion while
 *    looking correct.
 *  - `Dialog` always renders its children into the DOM and toggles `open`
 *    imperatively, so a suite must scope assertions to `dialog[open]` rather
 *    than the whole container's `textContent` — see `openDialogText`.
 */

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach } from "vitest";

/**
 * Teach jsdom the two `HTMLDialogElement` methods `Dialog` calls. Registers a
 * `beforeAll`, so call it at a suite's module scope.
 */
export function installDialogPolyfill(): void {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });
}

export interface DomRoot {
  /** The container mounted for the CURRENT test — a getter, because a fresh
   *  element is created per test. */
  readonly container: HTMLElement;
  /** Render (or re-render) into that container, wrapped in `act`. */
  render(node: ReactNode): void;
  /** The text of whichever dialog is OPEN, or null when none is. `Dialog`
   *  keeps every child in the DOM, so `container.textContent` sees closed
   *  dialogs too and would pass against the wrong one. */
  openDialogText(): string | null;
}

/**
 * A per-test `createRoot` container, torn down after each test. Registers
 * `beforeEach`/`afterEach`, so call it at a suite's module scope and keep the
 * returned handle.
 */
export function setupDomRoot(): DomRoot {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  return {
    get container() {
      return container;
    },
    render(node: ReactNode) {
      act(() => root.render(node));
    },
    openDialogText() {
      return container.querySelector("dialog[open]")?.textContent ?? null;
    },
  };
}
