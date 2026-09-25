// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The rewrite surfaces go through the shared consent gate before any model
 * load (#1015). Driven through the REAL `requestModelConsent` and a mounted
 * `ModelConsentHost` — only the engine layer is mocked — so what is asserted
 * is the user's path: click Rewrite → the consent dialog opens → Decline
 * leaves nothing loaded, Accept continues into the load of the shipped model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const { loadEngine } = vi.hoisted(() => ({
  loadEngine: vi.fn((_modelId: string, _onProgress: unknown) =>
    Promise.reject(new Error("stop after load")),
  ),
}));
vi.mock("../../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => Promise.resolve("available"),
}));
vi.mock("../../lib/webllm/web-llm.ts", () => ({
  loadEngine,
  acquireInference: vi.fn(),
  releaseInference: vi.fn(),
}));

import { ModelConsentHost } from "./ModelConsentHost.tsx";
import { useSectionRewrite } from "./SectionRewrite.tsx";
import {
  useResumeRewrite,
  type ResumeRewriteController,
} from "../../hooks/useResumeRewrite.ts";
import { _resetModelConsentRequestForTesting } from "../../hooks/useModelConsent.ts";
import {
  _resetModelConsentForTesting,
  hasModelConsent,
} from "../../lib/webllm/consent.ts";
import { SHIPPED_MODEL } from "../../lib/webllm/models.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.open = false;
};

const BULLETS = [
  "Cut checkout latency 42% by resharding the ledger service.",
  "Led 5 engineers through a zero-downtime Oracle migration.",
];

let container: HTMLDivElement;
let root: Root;
let resume: ResumeRewriteController;

function SectionProbe() {
  const { trigger, panel } = useSectionRewrite(BULLETS);
  return (
    <>
      {trigger}
      {panel}
    </>
  );
}

function ResumeProbe() {
  resume = useResumeRewrite([
    { kind: "experience", id: "e1", label: "Staff Engineer", bullets: BULLETS },
  ]);
  return null;
}

async function mount(probe: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <>
        <ModelConsentHost />
        {probe}
      </>,
    );
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function buttonNamed(label: RegExp): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((b) =>
    label.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`),
  );
  if (!match) throw new Error(`no button matching ${label}`);
  return match;
}

function consentOpen(): boolean {
  return container.querySelector("dialog")?.open === true;
}

beforeEach(() => {
  localStorage.clear();
  _resetModelConsentForTesting();
  _resetModelConsentRequestForTesting();
  loadEngine.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("section rewrite — consent gate", () => {
  it("first click opens the consent dialog and loads nothing yet", async () => {
    await mount(<SectionProbe />);
    await act(async () => buttonNamed(/rewrites every bullet/).click());
    await settle();
    expect(consentOpen()).toBe(true);
    expect(loadEngine).not.toHaveBeenCalled();
  });

  it("decline: nothing loads and no consent is recorded", async () => {
    await mount(<SectionProbe />);
    await act(async () => buttonNamed(/rewrites every bullet/).click());
    await settle();
    await act(async () => buttonNamed(/Decline/).click());
    await settle();
    expect(loadEngine).not.toHaveBeenCalled();
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(false);
  });

  it("accept: the rewrite continues into loading the shipped model", async () => {
    await mount(<SectionProbe />);
    await act(async () => buttonNamed(/rewrites every bullet/).click());
    await settle();
    await act(async () => buttonNamed(/Accept/).click());
    await settle();
    expect(hasModelConsent(SHIPPED_MODEL.id)).toBe(true);
    expect(loadEngine).toHaveBeenCalledOnce();
    expect(loadEngine.mock.calls[0]![0]).toBe(SHIPPED_MODEL.id);
  });
});

describe("whole-résumé rewrite — consent gate", () => {
  it("decline: start() leaves the controller idle and loads nothing", async () => {
    await mount(<ResumeProbe />);
    let started!: Promise<void>;
    await act(async () => {
      started = resume.start();
    });
    expect(consentOpen()).toBe(true);
    await act(async () => buttonNamed(/Decline/).click());
    await act(async () => {
      await started;
    });
    expect(resume.status.kind).toBe("idle");
    expect(loadEngine).not.toHaveBeenCalled();
  });

  it("accept: start() continues into loading the shipped model", async () => {
    await mount(<ResumeProbe />);
    let started!: Promise<void>;
    await act(async () => {
      started = resume.start();
    });
    await act(async () => buttonNamed(/Accept/).click());
    await act(async () => {
      await started;
    });
    expect(loadEngine).toHaveBeenCalledOnce();
    expect(loadEngine.mock.calls[0]![0]).toBe(SHIPPED_MODEL.id);
  });
});
