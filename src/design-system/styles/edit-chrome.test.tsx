// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The edit-chrome contract (#913): `edit-chrome.css`'s one rule, and the
 * design-system pieces that opt into it.
 *
 * jsdom evaluates no media query and cannot hover, so the rule is tested in
 * two halves. The stylesheet text pins the parts a regression would silently
 * break — fine pointer only, `opacity` rather than anything that drops a
 * control from the tab order. The selector itself is then run through
 * `Element.matches` over a real nested DOM to prove the "nearest scope"
 * reading the stylesheet's docblock argues for. jsdom's selector engine does
 * not implement `:focus-within`, so the test swaps the two state pseudo-classes
 * for one marker class and sets it the way the browser sets them: on the
 * element the pointer or focus is on AND every ancestor.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditableField } from "../primitives/EditableField.tsx";
import { SectionHeading } from "../shared/SectionHeading.tsx";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "edit-chrome.css"),
  "utf8",
);

/** The rule's selector, read from the stylesheet so the test cannot drift,
 *  with `:hover` / `:focus-within` swapped for the `.active` marker. */
function hideSelector(): string {
  const m = /@media \(pointer: fine\) \{\s*([^{]+)\{\s*opacity: 0;/u.exec(css);
  if (!m) throw new Error("edit-chrome.css no longer has the fine-pointer rule");
  const selector = m[1]!.replace(/\s+/gu, " ").trim();
  const swapped = selector.replace(":not(:hover, :focus-within)", ":not(.active)");
  if (swapped === selector) throw new Error("the scope's state test changed shape");
  return swapped;
}

/** Hover or focus on `el`: the state holds on it and on every ancestor. */
function activate(el: HTMLElement): void {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    n.classList.add("active");
  }
}

describe("edit-chrome.css", () => {
  it("hides chrome only on a fine pointer, so touch always shows it", () => {
    expect(css).toMatch(/@media \(pointer: fine\)/u);
    expect(css).not.toMatch(/pointer: coarse/u);
  });

  it("drops a float that holds an open input back into flow, only on a fine pointer", () => {
    // The user opened that field, so the content below makes room for it
    // rather than sitting under it (#1030 review).
    expect(css).toMatch(
      /@media \(pointer: fine\) \{[^@]*\.edit-float:has\(input, textarea\) \{\s*position: static;/u,
    );
  });

  it("hides with opacity, never visibility or display (both leave the tab order)", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(rules).toMatch(/opacity: 0/u);
    expect(rules).not.toMatch(/visibility\s*:/u);
    expect(rules).not.toMatch(/display\s*:/u);
  });
});

describe("edit-chrome selector — nearest scope wins", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  /** section scope > row scope > row chrome; plus section-level chrome and a
   *  second row, the way `ExperienceSection` > `ResumeBulletRow` nests. */
  function mount(): Record<string, HTMLElement> {
    document.body.innerHTML = `
      <section class="edit-scope" id="section">
        <div class="edit-scope" id="row">
          <span tabindex="0" id="field">text</span>
          <button class="edit-chrome" id="rowChrome">x</button>
        </div>
        <div class="edit-scope" id="otherRow">
          <button class="edit-chrome" id="otherChrome">x</button>
        </div>
        <button class="edit-chrome" id="sectionChrome">+ Add</button>
      </section>
      <button class="edit-chrome" id="unscoped">x</button>`;
    const byId = (id: string) => document.getElementById(id)!;
    return Object.fromEntries(
      [
        "field",
        "rowChrome",
        "otherChrome",
        "sectionChrome",
        "unscoped",
        "row",
      ].map((id) => [id, byId(id)]),
    );
  }

  const hidden = (el: HTMLElement) => el.matches(hideSelector());

  it("hides every scoped chrome at rest and never hides unscoped chrome", () => {
    const el = mount();
    expect(hidden(el.rowChrome!)).toBe(true);
    expect(hidden(el.otherChrome!)).toBe(true);
    expect(hidden(el.sectionChrome!)).toBe(true);
    expect(hidden(el.unscoped!)).toBe(false);
  });

  it("reveals a row's chrome and its section's — but not a sibling row's — when the row is hovered or holds focus", () => {
    const el = mount();
    activate(el.field!);
    expect(hidden(el.rowChrome!)).toBe(false);
    expect(hidden(el.sectionChrome!)).toBe(false);
    expect(hidden(el.otherChrome!)).toBe(true);
  });

  it("reveals a control the keyboard tabs onto, so it is never focused invisibly", () => {
    const el = mount();
    activate(el.otherChrome!);
    expect(hidden(el.otherChrome!)).toBe(false);
  });

  it("reveals everything inside an edit-reveal (Fix It's current step)", () => {
    const el = mount();
    el.row!.classList.add("edit-reveal");
    expect(hidden(el.rowChrome!)).toBe(false);
    expect(hidden(el.otherChrome!)).toBe(true);
  });

  it("reveals only the focus control inside an edit-reveal-focus (a section step)", () => {
    const el = mount();
    el.sectionChrome!.setAttribute("data-fixit-focus", "");
    document.getElementById("section")!.classList.add("edit-reveal-focus");
    expect(hidden(el.sectionChrome!)).toBe(false);
    // The section's other controls — a row's Remove — stay at rest.
    expect(hidden(el.rowChrome!)).toBe(true);
    expect(hidden(el.otherChrome!)).toBe(true);
  });
});

describe("design-system pieces on the contract", () => {
  const field = (value: string | undefined) =>
    renderToStaticMarkup(
      createElement(EditableField, { value, label: "Team", onCommit: () => {} }),
    );

  it("marks an EMPTY EditableField (its placeholder) as chrome", () => {
    expect(field(undefined)).toContain("edit-chrome");
  });

  it("leaves a FILLED EditableField alone — its value is content", () => {
    expect(field("Payments")).not.toContain("edit-chrome");
  });

  it("draws the PDF's section rule under SectionHeading, in a semantic border token", () => {
    const html = renderToStaticMarkup(
      createElement(SectionHeading, null, "Experience"),
    );
    expect(html).toMatch(/^<h2 class="[^"]*\bborder-b\b[^"]*"/u);
    expect(html).toContain("border-border-strong");
  });
});
