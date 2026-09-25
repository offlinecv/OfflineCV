// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentDialog } from "./ConsentDialog.tsx";
import { SHIPPED_MODEL } from "../../lib/webllm/models.ts";

function render(): string {
  return renderToStaticMarkup(
    createElement(ConsentDialog, {
      model: SHIPPED_MODEL,
      open: true,
      onAccept: () => {},
      onDecline: () => {},
    }),
  );
}

describe("ConsentDialog", () => {
  it("names the shipped model", () => {
    expect(render()).toContain("Gemma 2 (2B)");
  });

  it("links the vendor's terms with safe link attributes (target=_blank, rel=noopener noreferrer)", () => {
    const html = render();
    expect(html).toContain("https://ai.google.dev/gemma/terms");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("states the download size before the user commits to it", () => {
    expect(render()).toContain("~1.9 GB");
  });

  it("renders both Accept and Decline buttons", () => {
    const html = render();
    expect(html).toMatch(/Accept/);
    expect(html).toContain("Decline");
  });
});
