// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The shared consent gate end to end (#1015): `requestModelConsent` asks
 * through the one mounted `ModelConsentHost`, Accept records consent keyed to
 * the shipped model id and resolves `true`, Decline resolves `false` and
 * records nothing, concurrent asks share one dialog, and with no host mounted
 * the gate fails closed. Recorded consent answers without a dialog.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelConsentHost } from "./ModelConsentHost.tsx";
import {
  _resetModelConsentRequestForTesting,
  requestModelConsent,
} from "../../hooks/useModelConsent.ts";
import {
  _resetModelConsentForTesting,
  hasModelConsent,
  recordModelConsent,
} from "../../lib/webllm/consent.ts";
import { SHIPPED_MODEL } from "../../lib/webllm/models.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom's modal support varies by version; the `Dialog` primitive calls
// `showModal()` from an effect. Same stub as `FeedbackDialog.test.tsx`.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.open = false;
};

let container: HTMLDivElement;
let root: Root | null = null;

async function mountHost(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ModelConsentHost />);
  });
}

function dialog(): HTMLDialogElement | null {
  return container.querySelector("dialog");
}

function button(label: RegExp): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (!match) throw new Error(`no button matching ${label}`);
  return match;
}

/**
 * Start a request inside `act` so the host's re-render flushes. Wrapped in an
 * object: an async function returning the promise itself would flatten it
 * and wait for the answer the test has not given yet.
 */
async function ask(): Promise<{ answer: Promise<boolean> }> {
  let answer!: Promise<boolean>;
  await act(async () => {
    answer = requestModelConsent();
  });
  return { answer };
}

beforeEach(() => {
  _resetModelConsentForTesting();
  _resetModelConsentRequestForTesting();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe("requestModelConsent + ModelConsentHost", () => {
  it("renders nothing until something asks", async () => {
    await mountHost();
    expect(dialog()).toBeNull();
  });

  it("Accept records consent for the shipped model id and continues", async () => {
    await mountHost();
    const { answer } = await ask();
    expect(dialog()?.open).toBe(true);
    expect(container.textContent).toContain(SHIPPED_MODEL.name);

    await act(async () => {
      button(/Accept/).click();
    });
    await expect(answer).resolves.toBe(true);
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(true);
    expect(dialog()?.open).toBe(false);
  });

  it("Decline records nothing and resolves false", async () => {
    await mountHost();
    const { answer } = await ask();
    await act(async () => {
      button(/Decline/).click();
    });
    await expect(answer).resolves.toBe(false);
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(false);
  });

  it("concurrent requests share one dialog and one answer", async () => {
    await mountHost();
    const { answer: first } = await ask();
    const { answer: second } = await ask();
    expect(container.querySelectorAll("dialog")).toHaveLength(1);
    await act(async () => {
      button(/Accept/).click();
    });
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it("answers true without a dialog once consent is recorded", async () => {
    recordModelConsent(SHIPPED_MODEL.id);
    await mountHost();
    await expect((await ask()).answer).resolves.toBe(true);
    expect(dialog()).toBeNull();
  });

  it("fails closed with no host mounted", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      await expect(requestModelConsent()).resolves.toBe(false);
    } finally {
      console.warn = warn;
    }
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(false);
  });

  it("unmounting the host while it asks resolves the request as declined", async () => {
    await mountHost();
    const { answer } = await ask();
    act(() => root!.unmount());
    root = null;
    await expect(answer).resolves.toBe(false);
  });
});
