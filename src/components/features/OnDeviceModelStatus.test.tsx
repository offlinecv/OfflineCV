// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The status line that replaced the model picker (#1015): silent without
 * WebGPU, "Download" asks for consent before it loads anything, a cached
 * model reads Ready on mount with a two-step Remove, a failed load is
 * announced with a retry, and a load a feature is drawing a bar for reads
 * "Loading…" here without a second progress bar.
 * Engine layer mocked — its mock publishes to the real `engine-status.ts`,
 * as the real `loadEngine` does; the consent request is mocked to a chosen
 * answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const engine = vi.hoisted(() => ({
  capability: "available" as string,
  cached: false,
  consent: true,
  loadEngine: vi.fn(),
  clearModel: vi.fn(),
}));
vi.mock("../../lib/webllm/capability.ts", () => ({
  detectWebGpu: () => Promise.resolve(engine.capability),
}));
vi.mock("../../lib/webllm/web-llm.ts", () => ({
  loadEngine: engine.loadEngine,
  clearModel: engine.clearModel,
}));
vi.mock("../../lib/webllm/model-cache.ts", () => ({
  hasModelWeightsCached: () => Promise.resolve(engine.cached),
}));
vi.mock("../../hooks/useModelConsent.ts", () => ({
  requestModelConsent: () => Promise.resolve(engine.consent),
}));

import { OnDeviceModelStatus } from "./OnDeviceModelStatus.tsx";
import { SHIPPED_MODEL } from "../../lib/webllm/models.ts";
import {
  _resetEngineStatusForTesting,
  markEngineLoaded,
  markEngineLoading,
  registerFeatureLoadBar,
} from "../../lib/webllm/engine-status.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<OnDeviceModelStatus />);
  });
  await settle();
}

function button(label: RegExp): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (!match) throw new Error(`no button matching ${label}`);
  return match;
}

async function click(label: RegExp): Promise<void> {
  await act(async () => button(label).click());
  await settle();
}

beforeEach(() => {
  engine.capability = "available";
  engine.cached = false;
  engine.consent = true;
  _resetEngineStatusForTesting();
  engine.loadEngine.mockReset().mockImplementation(async (id: string) => {
    markEngineLoading(id, { progress: 0, text: "Starting…" });
    markEngineLoaded(id);
    return { chat: {} };
  });
  engine.clearModel.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("OnDeviceModelStatus", () => {
  it("renders nothing without WebGPU", async () => {
    engine.capability = "no-webgpu";
    await mount();
    expect(container.innerHTML).toBe("");
  });

  it("names the shipped model and offers the download with its size", async () => {
    await mount();
    expect(container.textContent).toContain(SHIPPED_MODEL.name);
    expect(button(/Download · ~1\.9 GB/)).toBeTruthy();
  });

  it("declined consent: Download loads nothing", async () => {
    engine.consent = false;
    await mount();
    await click(/Download/);
    expect(engine.loadEngine).not.toHaveBeenCalled();
    expect(button(/Download/)).toBeTruthy();
  });

  it("accepted consent: Download loads the shipped model, then reads Ready", async () => {
    await mount();
    engine.cached = true; // what the post-download re-probe will find
    await click(/Download/);
    expect(engine.loadEngine).toHaveBeenCalledOnce();
    expect(engine.loadEngine.mock.calls[0]![0]).toBe(SHIPPED_MODEL.id);
    expect(container.textContent).toContain("Ready · runs offline");
  });

  it("a failed load is announced and offers Try again", async () => {
    engine.loadEngine.mockRejectedValue(new Error("no shader-f16"));
    await mount();
    await click(/Download/);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't download.",
    );
    expect(container.textContent).toContain("no shader-f16");
    expect(button(/Try again/)).toBeTruthy();
  });

  it("a returning user with the model cached reads Ready on mount, untouched", async () => {
    engine.cached = true;
    await mount();
    expect(container.textContent).toContain("Ready · runs offline");
    expect(container.textContent).not.toContain("Download");
  });

  it("a load a feature is drawing reads Loading…, with no second bar, then Ready", async () => {
    await mount();
    let unregister!: () => void;
    await act(async () => {
      unregister = registerFeatureLoadBar();
      markEngineLoading(SHIPPED_MODEL.id, {
        progress: 0.4,
        text: "Fetching param cache",
        source: "network",
      });
    });
    // That feature renders its own bar; a copy here read as two downloads.
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    expect(container.textContent).not.toContain("Download ·");
    await act(async () => {
      unregister();
      markEngineLoaded(SHIPPED_MODEL.id);
    });
    await settle();
    expect(container.textContent).toContain("Ready · runs offline");
  });

  it("yields its own Download's bar to a feature that joins the load, and takes it back", async () => {
    let finish!: () => void;
    engine.loadEngine.mockImplementation(async (id: string) => {
      markEngineLoading(id, { progress: 0.3, text: "shard 3", source: "network" });
      await new Promise<void>((resolve) => (finish = resolve));
      markEngineLoaded(id);
      return { chat: {} };
    });
    await mount();
    await click(/Download/);
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    let unregister!: () => void;
    await act(async () => {
      unregister = registerFeatureLoadBar(); // a rewrite's bar mounts
    });
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    await act(async () => unregister()); // …and unmounts mid-load
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    await act(async () => finish());
    await settle();
  });

  it.each([
    ["network", `Downloading ${SHIPPED_MODEL.name} (~1.9 GB, one time)`],
    ["device", `Loading ${SHIPPED_MODEL.name} from this device`],
  ] as const)(
    "its own Download shows the bar, labelled by where the weights come from (%s)",
    async (source, label) => {
      let finish!: () => void;
      engine.loadEngine.mockImplementation(async (id: string) => {
        markEngineLoading(id, { progress: 0.3, text: "shard 3", source });
        await new Promise<void>((resolve) => (finish = resolve));
        markEngineLoaded(id);
        return { chat: {} };
      });
      await mount();
      await click(/Download/);
      expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
      expect(container.textContent).toContain(label);
      await act(async () => finish());
      await settle();
      expect(container.querySelector('[role="progressbar"]')).toBeNull();
    },
  );

  it("Remove asks once more, then clears the shipped model", async () => {
    engine.cached = true;
    await mount();
    await click(/Remove from this device/);
    expect(engine.clearModel).not.toHaveBeenCalled();
    engine.cached = false;
    await click(/^Remove$/);
    expect(engine.clearModel).toHaveBeenCalledWith(SHIPPED_MODEL.id);
    expect(button(/Download/)).toBeTruthy();
  });
});
