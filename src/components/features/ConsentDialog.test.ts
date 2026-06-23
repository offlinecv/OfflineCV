// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentDialog } from "./ConsentDialog.tsx";
import type { ModelMetadata } from "../../lib/webllm/models.ts";

const gemma: ModelMetadata = {
  id: "gemma-2-2b-it-q4f16_1-MLC",
  name: "Gemma 2 (2B)",
  licenseType: "Restricted-Community",
  tier: "Standard",
  licenseUrl: "https://ai.google.dev/gemma/terms",
  downloadSizeMb: 1895,
};

const llama: ModelMetadata = {
  id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
  name: "Llama 3.2 (3B)",
  licenseType: "Restricted-Community",
  tier: "High",
  licenseUrl: "https://www.llama.com/llama3_2/license/",
  downloadSizeMb: 2264,
};

function render(props: Parameters<typeof ConsentDialog>[0]): string {
  return renderToStaticMarkup(createElement(ConsentDialog, props));
}

describe("ConsentDialog", () => {
  it("names the specific model in the title (consent is per-licenseType but disclosure is per-model)", () => {
    const html = render({
      model: gemma,
      open: true,
      onAccept: () => {},
      onDecline: () => {},
    });
    expect(html).toContain("Gemma 2 (2B)");
  });

  it("shows the vendor's licenseUrl with safe link attributes (target=_blank, rel=noopener noreferrer)", () => {
    const html = render({
      model: gemma,
      open: true,
      onAccept: () => {},
      onDecline: () => {},
    });
    expect(html).toContain("https://ai.google.dev/gemma/terms");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders different vendor link per model — Llama gets the Llama license URL, not the Gemma one", () => {
    const html = render({
      model: llama,
      open: true,
      onAccept: () => {},
      onDecline: () => {},
    });
    expect(html).toContain("https://www.llama.com/llama3_2/license/");
    expect(html).not.toContain("ai.google.dev/gemma/terms");
  });

  it("renders both Accept and Decline buttons", () => {
    const html = render({
      model: gemma,
      open: true,
      onAccept: () => {},
      onDecline: () => {},
    });
    expect(html).toMatch(/Accept/);
    expect(html).toContain("Decline");
  });

  it("mentions that accept applies to the license type, not just this one model", () => {
    // Forward guard against a future copy change that loses the
    // 'one accept covers the whole license type' nuance — which is the
    // load-bearing UX promise behind the per-licenseType persistence.
    const html = render({
      model: gemma,
      open: true,
      onAccept: () => {},
      onDecline: () => {},
    });
    expect(html.toLowerCase()).toContain("once per license type");
  });
});
