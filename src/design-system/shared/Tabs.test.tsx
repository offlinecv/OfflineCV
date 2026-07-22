// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Tests for `Tab`'s optional `description` prop (issue 519) — the shared-
 * primitive regression risk is a description-less `Tab` picking up the new
 * two-line wrapper, and the two-line one changing the roving-tabindex keyboard
 * contract `TabList.onKeyDown` implements.
 *
 * Two render paths on purpose: the markup assertions stay on
 * `renderToStaticMarkup` (cheap, no DOM), while the keyboard block needs a real
 * document to move focus — hence the jsdom pragma and the raw createRoot + act
 * harness the sibling render tests use.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Tabs, TabList, Tab } from "./Tabs.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function renderTab(tab: ReactElement): string {
  return renderToStaticMarkup(
    <Tabs value="a" onValueChange={() => {}} id="t">
      <TabList aria-label="Test tabs">{tab}</TabList>
    </Tabs>,
  );
}

describe("Tab description", () => {
  it("omitting description reproduces today's single-line rendering exactly", () => {
    const html = renderTab(<Tab id="a">Reconstructed resume</Tab>);
    // No two-line wrapper, no subtitle markup, no flex-col grouping — just the
    // label directly inside the button, same as before this prop existed.
    expect(html).not.toContain("flex-col");
    expect(html).not.toContain("sm:block");
    expect(html).toContain("Reconstructed resume");
  });

  it("a description renders as a subtitle under the label, not a stray floating span", () => {
    const html = renderTab(
      <Tab id="a" description="what a parser pulled out — edit it here">
        Reconstructed resume
      </Tab>,
    );
    expect(html).toContain("Reconstructed resume");
    expect(html).toContain("what a parser pulled out — edit it here");
    // Subtitle is nested inside the same <button> as the label, so it
    // contributes to the tab's accessible name (see Tabs.tsx doc comment) —
    // not a sibling element outside the tab.
    const buttonOpen = html.indexOf("<button");
    const buttonClose = html.indexOf("</button>");
    const subtitleIndex = html.indexOf("what a parser pulled out");
    expect(subtitleIndex).toBeGreaterThan(buttonOpen);
    expect(subtitleIndex).toBeLessThan(buttonClose);
  });

  it("suppresses the subtitle below the sm breakpoint so 375px degrades to single-line", () => {
    const html = renderTab(
      <Tab id="a" description="search job boards">
        Find jobs
      </Tab>,
    );
    expect(html).toContain("hidden");
    expect(html).toContain("sm:block");
  });

  it("a description-less Tab still carries count and warn inline, unchanged", () => {
    const html = renderTab(
      <Tab id="a" count={3} warn>
        Source &amp; diagnostics
      </Tab>,
    );
    expect(html).toContain("setup needed");
    expect(html).not.toContain("flex-col");
  });
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** Three tabs with the middle one selected by default, so a roving-tabindex
 *  assertion can distinguish "the active tab" from "the first tab". `value`
 *  moves the selection to an edge tab for the wrap-around cases. */
function renderTabList(
  onValueChange: (value: string) => void,
  description: string | undefined,
  value = "b",
): HTMLButtonElement[] {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <Tabs value={value} onValueChange={onValueChange} id="t">
        <TabList aria-label="Test tabs">
          <Tab id="a" description={description}>
            Alpha
          </Tab>
          <Tab id="b" description={description}>
            Beta
          </Tab>
          <Tab id="c" description={description}>
            Gamma
          </Tab>
        </TabList>
      </Tabs>,
    );
  });
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
}

function press(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

// The keyboard contract must not depend on `description` (issue 519's "keyboard
// behaviour unchanged" criterion): the two-line branch nests the label in an
// extra wrapper span, and `onKeyDown` resolves tabs through `data-tab-id` on
// the button — so a regression there would only show up on one of the two.
for (const withDesc of [false, true]) {
  const description = withDesc ? "a one-line subtitle" : undefined;
  describe(`TabList keyboard navigation (${withDesc ? "with" : "without"} description)`, () => {
    it("gives only the selected tab a reachable tabindex", () => {
      const tabs = renderTabList(() => {}, description);
      expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    });

    it("ArrowRight selects and focuses the next tab", () => {
      const onValueChange = vi.fn();
      const tabs = renderTabList(onValueChange, description);
      press(tabs[1]!, "ArrowRight");
      expect(onValueChange).toHaveBeenCalledWith("c");
      expect(document.activeElement).toBe(tabs[2]);
    });

    it("ArrowLeft selects and focuses the previous tab", () => {
      const onValueChange = vi.fn();
      const tabs = renderTabList(onValueChange, description);
      press(tabs[1]!, "ArrowLeft");
      expect(onValueChange).toHaveBeenCalledWith("a");
      expect(document.activeElement).toBe(tabs[0]);
    });

    it("Home selects and focuses the first tab", () => {
      const onValueChange = vi.fn();
      const tabs = renderTabList(onValueChange, description);
      press(tabs[1]!, "Home");
      expect(onValueChange).toHaveBeenCalledWith("a");
      expect(document.activeElement).toBe(tabs[0]);
    });

    it("End selects and focuses the last tab", () => {
      const onValueChange = vi.fn();
      const tabs = renderTabList(onValueChange, description);
      press(tabs[1]!, "End");
      expect(onValueChange).toHaveBeenCalledWith("c");
      expect(document.activeElement).toBe(tabs[2]);
    });

    // The modulo in `onKeyDown` is the whole wrap-around contract, and an
    // off-by-one there (`% tabs.length` dropped, or the `+ tabs.length` that
    // keeps ArrowLeft from going negative) only misbehaves at the two edges —
    // which the middle-selected cases above can never reach.
    it("ArrowRight wraps from the last tab to the first", () => {
      const onValueChange = vi.fn();
      const tabs = renderTabList(onValueChange, description, "c");
      press(tabs[2]!, "ArrowRight");
      expect(onValueChange).toHaveBeenCalledWith("a");
      expect(document.activeElement).toBe(tabs[0]);
    });

    it("ArrowLeft wraps from the first tab to the last", () => {
      const onValueChange = vi.fn();
      const tabs = renderTabList(onValueChange, description, "a");
      press(tabs[0]!, "ArrowLeft");
      expect(onValueChange).toHaveBeenCalledWith("c");
      expect(document.activeElement).toBe(tabs[2]);
    });

    it("leaves an unhandled key alone", () => {
      const onValueChange = vi.fn();
      const tabs = renderTabList(onValueChange, description);
      press(tabs[1]!, "ArrowDown");
      expect(onValueChange).not.toHaveBeenCalled();
    });
  });
}
