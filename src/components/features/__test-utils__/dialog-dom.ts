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
 *  - A controlled `<textarea>`'s `.value = x` is SWALLOWED by React's value
 *    tracker, so a suite that assigns it directly types nothing and asserts
 *    against a stale empty string — see {@link typeIntoTextArea}.
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

/**
 * Click the button whose visible text — or `aria-label`, for an icon button
 * with no text — is `name`. Returns it, so a caller can assert on presence in
 * the same line, and returns `undefined` rather than throwing when there is no
 * match: "this control is absent" is a thing several suites assert directly.
 *
 * Text equality, not `includes`: "Edit" and "Edit cover letter" are different
 * controls in these dialogs, and a substring match would silently pick
 * whichever came first in the DOM.
 */
export function clickButtonIn(
  container: HTMLElement,
  name: string,
): HTMLButtonElement | undefined {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => (candidate.textContent || candidate.getAttribute("aria-label")) === name,
  );
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return button;
}

/**
 * Type into the first `<textarea>` in `container` the way a controlled React
 * input requires.
 *
 * The native value setter, then an `input` event: React installs its own
 * property descriptor to track changes, so a plain `area.value = text` updates
 * the DOM node while React's tracker still believes the value is unchanged —
 * the re-render never happens and the component's state stays empty. A suite
 * that gets this wrong sees an empty body and a disabled Save with no error to
 * explain either.
 */
export function typeIntoTextArea(container: HTMLElement, text: string): void {
  const area = container.querySelector("textarea");
  if (!area) throw new Error("typeIntoTextArea: no <textarea> in the container");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
