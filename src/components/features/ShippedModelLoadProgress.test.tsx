// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  _resetEngineStatusForTesting,
  getFeatureLoadBarCount,
  markEngineLoading,
} from "../../lib/webllm/engine-status.ts";
import { SHIPPED_MODEL } from "../../lib/webllm/models.ts";
import type { ProgressUpdate } from "../../lib/webllm/types.ts";
import { ShippedModelLoadProgress } from "./ShippedModelLoadProgress.tsx";

function render(progress: ProgressUpdate, showExplainer = false): string {
  return renderToStaticMarkup(
    createElement(ShippedModelLoadProgress, { progress, showExplainer }),
  );
}

afterEach(() => _resetEngineStatusForTesting());

describe("ShippedModelLoadProgress", () => {
  it("names the one-time download only when the weights come from the network", () => {
    expect(render({ progress: 0.1, text: "", source: "network" })).toContain(
      `Downloading ${SHIPPED_MODEL.name} (~1.9 GB, one time)`,
    );
    const fromDevice = render({ progress: 0.1, text: "", source: "device" });
    expect(fromDevice).toContain(`Loading ${SHIPPED_MODEL.name} from this device`);
    expect(fromDevice).not.toContain("one time");
  });

  it("claims neither before the probe has answered", () => {
    const html = render({ progress: 0, text: "Starting…" });
    expect(html).toContain(`Loading ${SHIPPED_MODEL.name}`);
    expect(html).not.toContain("one time");
    expect(html).not.toContain("from this device");
  });

  it("drops the download explainer for a load from this device", () => {
    expect(render({ progress: 0.1, text: "", source: "network" }, true)).toMatch(
      /What.{1,6}s happening/,
    );
    expect(render({ progress: 0.1, text: "", source: "device" }, true)).not.toMatch(
      /What.{1,6}s happening/,
    );
  });

  it("counts as a feature bar while mounted, so the status line yields its own", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(ShippedModelLoadProgress, { progress: { progress: 0, text: "" } }),
      ),
    );
    expect(getFeatureLoadBarCount()).toBe(1);
    await act(async () => root.unmount());
    expect(getFeatureLoadBarCount()).toBe(0);
  });

  it("follows the engine's progress over a caller that joined the load", () => {
    markEngineLoading(SHIPPED_MODEL.id, {
      progress: 0.64,
      text: "Fetching param cache[20/31]",
      source: "network",
    });
    const html = render({ progress: 0, text: "Starting…" });
    expect(html).toContain('aria-valuenow="64"');
    expect(html).toContain("Fetching param cache[20/31]");
  });
});
