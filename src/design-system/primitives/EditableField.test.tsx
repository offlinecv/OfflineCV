// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Tests for the `EditableField` primitive's empty-state placeholder treatment
 * (#376). Read mode is static (no client-only effects run before `editing` is
 * true), so — matching `Dialog.test.ts` — these run via `renderToStaticMarkup`
 * in the repo's default Node test env; no jsdom needed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditableField } from "./EditableField.tsx";

function render(props: Parameters<typeof EditableField>[0]): string {
  return renderToStaticMarkup(createElement(EditableField, props));
}

describe("EditableField read mode", () => {
  it("prefixes an empty field's placeholder with '+ ' so it reads as an add-affordance, not a value", () => {
    const html = render({
      value: undefined,
      placeholder: "location",
      label: "Location",
      onCommit: () => {},
    });
    // The glyph is its own aria-hidden span, not folded into the text — so a
    // screen reader gets "Add Location", never "plus location".
    expect(html).toContain('<span aria-hidden="true">+ </span>location');
  });

  it("defaults the placeholder to the lowercased label, so '+ not detected' is unrepresentable", () => {
    const html = render({ value: undefined, label: "Location", onCommit: () => {} });
    expect(html).toContain('<span aria-hidden="true">+ </span>location');
    expect(html).not.toContain("not detected");
  });

  it("emptyAffordance='plain' drops the glyph AND the Add verb — the empty state is a state, not a gap", () => {
    const html = render({
      value: undefined,
      placeholder: "Untitled resume",
      emptyAffordance: "plain",
      label: "Resume name",
      onCommit: () => {},
    });
    expect(html).not.toContain("+ ");
    expect(html).toContain("Untitled resume");
    expect(html).toContain('aria-label="Edit Resume name"');
    // The add-path invariant still holds for a plain field: it is the only input
    // path, so it stays focusable and activatable.
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
  });

  it("renders a populated field's value verbatim, with no '+ ' prefix", () => {
    const html = render({
      value: "Chicago, IL",
      placeholder: "location not detected",
      label: "Location",
      onCommit: () => {},
    });
    expect(html).toContain(">Chicago, IL<");
    expect(html).not.toContain("+ Chicago, IL");
  });

  it("keeps the empty field focusable and clickable — same role/tabIndex as before, only the visible text and the verb change", () => {
    const html = render({
      value: undefined,
      placeholder: "start date",
      label: "Start date",
      onCommit: () => {},
    });
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    // The verb matches what the field OFFERS: an empty add-field is announced
    // "Add …", so the accessible name contains the visible label (WCAG 2.5.3).
    expect(html).toContain('aria-label="Add Start date"');
    // The muted/italic empty-state treatment is unchanged — the "+" prefix is
    // additive, not a replacement for the existing visual distinction.
    expect(html).toMatch(/class="[^"]*text-content-muted[^"]*italic[^"]*"/);
  });

  it("does not prefix a populated value even when a displayValue override is set", () => {
    const html = render({
      value: "https://linkedin.com/in/jane",
      displayValue: "linkedin.com/in/jane",
      placeholder: "not detected",
      label: "LinkedIn",
      onCommit: () => {},
    });
    expect(html).toContain(">linkedin.com/in/jane<");
    expect(html).not.toContain("+ linkedin.com/in/jane");
  });
});

/**
 * #376's completeness criterion — "no call site is special-cased or skipped" —
 * is a property of the WHOLE REPO, not of this primitive, so it cannot be tested
 * by rendering the primitive alone. It regressed exactly that way once already:
 * two call sites (ContactExtraLinks, AchievementTypePicker) were never visited by
 * the placeholder rewrite, and because `emptyAffordance` defaults to "add" they
 * silently INHERITED the new "+ " glyph on top of their old sentence-case copy —
 * "+ Link URL", "+ Custom label". The default that makes the affordance
 * repo-wide is the same default that spreads the defect to anything overlooked.
 *
 * So the guard is a source sweep: an "add"-mode placeholder must be a bare noun
 * phrase, because it is rendered directly after a "+ ".
 */
describe("EditableField call sites (issue 376 — repo-wide, no site skipped)", () => {
  // `[\s\S]*?`, NOT `[^>]*?`: nearly every call site spans several lines and
  // carries an arrow-function prop (`onCommit={(v) => …}`), so a `>`-terminated
  // scan stops dead at the arrow and sees only the handful of single-line sites.
  // That version of this sweep matched 2 of 23 and passed while the bug was live.
  const CALL_SITE_RE = /<EditableField\b[\s\S]*?\/>/g;
  const PLACEHOLDER_RE = /placeholder=(?:"([^"]*)"|\{`([^`]*)`\})/;
  const PLAIN_RE = /emptyAffordance=["{]?["']?plain/;

  const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  function componentFiles(): string[] {
    return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".tsx") && !p.endsWith(".test.tsx"))
      .map((p) => join(SRC_DIR, p))
      .sort();
  }

  it("never gives an add-affordance field a capitalized or '…not detected' placeholder", () => {
    const offenders: string[] = [];
    let sitesSeen = 0;
    for (const file of componentFiles()) {
      const src = readFileSync(file, "utf8");
      for (const site of src.match(CALL_SITE_RE) ?? []) {
        sitesSeen++;
        // "plain" fields render the bare placeholder with no "+ ", so prose there
        // is fine — it is a state description, not a gap to fill.
        if (PLAIN_RE.test(site)) continue;
        const m = PLACEHOLDER_RE.exec(site);
        const placeholder = m?.[1] ?? m?.[2];
        // No placeholder at all is the GOOD case: the primitive derives it from
        // `label`, which is what makes "+ not detected" unrepresentable.
        if (!placeholder) continue;
        if (/not detected/i.test(placeholder) || /^[A-Z]/.test(placeholder)) {
          offenders.push(`${file}: placeholder="${placeholder}"`);
        }
      }
    }

    // Non-vacuity: a sweep that silently walks nothing (wrong root, wrong
    // extension filter) passes green while the bug is live — the exact way the
    // `[^>]*?` version of CALL_SITE_RE failed.
    expect(sitesSeen).toBeGreaterThan(15);
    expect(offenders).toEqual([]);
  });
});
