// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Smoke tests for `ModelSelector`'s presentational surface.
 *
 * The top-level component returns `null` until `detectWebGpu()` resolves,
 * which the Node-env `renderToStaticMarkup` harness can't drive. So the
 * testable surface is `ModelRow` (each registry entry's display branching)
 * and the pure `licenseLabel` helper. The interactive flow (click →
 * consent → load) is covered by manual test in the PR test plan.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelRow, licenseLabel } from "./ModelSelector.tsx";
import { MODEL_REGISTRY } from "../../lib/webllm/models.ts";

const qwen = MODEL_REGISTRY.find((m) => m.licenseType === "Apache-2.0")!;
const gemma = MODEL_REGISTRY.find(
  (m) => m.id === "gemma-2-2b-it-q4f16_1-MLC",
)!;
const llama = MODEL_REGISTRY.find(
  (m) => m.id === "Llama-3.2-3B-Instruct-q4f16_1-MLC",
)!;

function render(props: Parameters<typeof ModelRow>[0]): string {
  return renderToStaticMarkup(createElement(ModelRow, props));
}

const baseRow = {
  selected: false,
  cached: false,
  disabled: false,
  error: null,
  loadingProgress: null,
  onPick: () => {},
};

describe("licenseLabel", () => {
  it("renders 'Apache-2.0' for Apache-2.0 entries", () => {
    expect(licenseLabel(qwen)).toBe("Apache-2.0");
  });

  it("renders 'Vendor license' for Restricted-Community entries (specific vendor name lives in the consent dialog)", () => {
    expect(licenseLabel(gemma)).toBe("Vendor license");
    expect(licenseLabel(llama)).toBe("Vendor license");
  });
});

describe("ModelRow — cached vs fresh-download labels", () => {
  it("labels a cached row as 'Downloaded · runs offline'", () => {
    const html = render({ ...baseRow, model: qwen, cached: true });
    expect(html).toContain("Downloaded");
    expect(html).toContain("runs offline");
  });

  it("labels an uncached row with the download size in GB (the size-warning surface)", () => {
    // 1630 MB → 1.6 GB
    const html = render({ ...baseRow, model: qwen, cached: false });
    expect(html).toContain("Will download");
    expect(html).toContain("1.6 GB");
    expect(html).toContain("one-time");
  });

  it("uses the right size for Gemma 2 (1895 MB → 1.9 GB)", () => {
    const html = render({ ...baseRow, model: gemma, cached: false });
    expect(html).toContain("1.9 GB");
  });

  it("uses the right size for Llama 3.2 (2264 MB → 2.2 GB)", () => {
    const html = render({ ...baseRow, model: llama, cached: false });
    expect(html).toContain("2.2 GB");
  });
});

describe("ModelRow — selection + tier + license display", () => {
  it("shows the model's name + tier + license label", () => {
    const html = render({ ...baseRow, model: qwen });
    expect(html).toContain(qwen.name);
    expect(html).toContain(qwen.tier);
    expect(html).toContain("Apache-2.0");
  });

  it("marks the default model with a 'default' annotation", () => {
    const html = render({ ...baseRow, model: qwen });
    expect(html).toContain("default");
  });

  it("does NOT mark non-default models with the 'default' annotation", () => {
    const html = render({ ...baseRow, model: gemma });
    expect(html).not.toMatch(/>default</);
  });

  it("renders `aria-pressed=true` on the selected row (toggle semantics for SR users)", () => {
    expect(render({ ...baseRow, model: qwen, selected: true })).toContain(
      'aria-pressed="true"',
    );
    expect(render({ ...baseRow, model: qwen, selected: false })).toContain(
      'aria-pressed="false"',
    );
  });

  it("shows the '✓ Selected' badge on the selected row, not on others", () => {
    expect(
      render({ ...baseRow, model: qwen, selected: true }),
    ).toContain("Selected");
    expect(
      render({ ...baseRow, model: qwen, selected: false }),
    ).not.toContain("Selected");
  });
});

describe("ModelRow — load progress + error states", () => {
  it("renders the inline progress panel when loadingProgress is provided", () => {
    const html = render({
      ...baseRow,
      model: qwen,
      loadingProgress: { progress: 0.4, text: "fetching weights" },
    });
    // ModelLoadProgress label is "Loading <name> (one-time download)".
    expect(html).toContain(qwen.name);
    expect(html).toContain("40%");
    expect(html).toContain("fetching weights");
    expect(html).toContain('role="progressbar"');
  });

  it("renders the per-model friendly-summary error message with role=alert when error is provided", () => {
    const html = render({
      ...baseRow,
      model: gemma,
      error: {
        message:
          "Gemma 2 (2B) needs more GPU memory than your device can spare. Try a smaller model.",
      },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("more GPU memory");
    // No Technical details disclosure when `detail` is omitted.
    expect(html).not.toContain("Technical details");
  });

  it("renders the optional Technical details disclosure when raw error detail is provided", () => {
    const html = render({
      ...baseRow,
      model: gemma,
      error: {
        message: "Couldn't load Gemma 2 (2B).",
        detail: "Cannot find adapter that matches the request",
      },
    });
    expect(html).toContain("Technical details");
    expect(html).toContain("Cannot find adapter");
  });

  it("disables the row when `disabled` is true (another model is loading)", () => {
    expect(render({ ...baseRow, model: qwen, disabled: true })).toContain(
      "disabled",
    );
  });
});
