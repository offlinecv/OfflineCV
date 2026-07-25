// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Coverage for the Find Jobs tab on `/` after the search moved to `/jobs/`.
 *
 * The contract that matters: clicking the button STASHES the parse before it
 * navigates. If the write were skipped or ordered after the navigation, `/jobs/`
 * would load with no résumé and show its empty state — the failure the split
 * made possible, so it is the thing under test.
 *
 * jsdom implements no navigation, so the `window.location.href` assignment logs
 * a "Not implemented: navigation" notice from the virtual console. That is
 * expected noise, not a failure; the assertion is on sessionStorage.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FindJobsLauncher } from "./FindJobsLauncher.tsx";
import { readJobsHandoff } from "../../lib/jobs-handoff.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const parsed: HeuristicParsedResume = {
  full_name: "Dana Fixture",
  skills: ["React", "TypeScript", "GraphQL"],
  experience: [{ company: "Acme", title: "Staff Frontend Engineer" }],
  education: [],
};

let container: HTMLDivElement;
let root: Root;

function render(props: { parsed: HeuristicParsedResume }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(FindJobsLauncher, props));
  });
  return container;
}

function launchButton(el: HTMLElement): HTMLButtonElement {
  const button = [...el.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Open job workbench"),
  );
  if (!button) throw new Error("no launch button rendered");
  return button as HTMLButtonElement;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe("FindJobsLauncher", () => {
  it("previews the derived query terms without an editor", () => {
    const el = render({ parsed });
    expect(el.textContent).toContain("Starting from these terms");
    // `buildJobQuery` lowercases skill terms, so the preview shows what will
    // actually be searched, not the résumé's casing.
    expect(el.textContent).toContain("Staff Frontend Engineer");
    expect(el.textContent).toContain("react");
    // No chip-add inputs here — editing belongs to /jobs/ only.
    expect(el.querySelectorAll("input").length).toBe(0);
  });

  it("stashes the parse before navigating", () => {
    const el = render({ parsed });
    act(() => launchButton(el).click());

    const handoff = readJobsHandoff();
    expect(handoff).not.toBeNull();
    expect(handoff?.parsed.full_name).toBe("Dana Fixture");
    expect(handoff?.parsed.skills).toContain("GraphQL");
  });

  it("still offers the jump when no query could be derived", () => {
    // The workbench is where titles/skills get added, so a degenerate parse
    // must not disable the only route to it.
    const el = render({
      parsed: { skills: [], experience: [], education: [] },
    });
    expect(el.textContent).toContain("couldn't derive a search");
    expect(launchButton(el).disabled).toBe(false);
  });
});
