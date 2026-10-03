// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Pins where `RoleHeader` puts the role's actions (#913 follow-up): LEFT of the
 * dates, never after them. Edit chrome rests at `opacity: 0` and keeps its
 * box, so a toolbar trailing the dates held them ~56px short of the column's
 * right edge — the dates no longer lined up with the PDF they preview.
 *
 * jsdom does no layout, so this asserts document order, the same
 * `renderToStaticMarkup` pattern as `ReconstructedAdd.remove-button.test.tsx`.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoleHeader } from "./RoleHeader.tsx";
import type { BulletGroup } from "../../lib/score/group-bullets.ts";

const GROUP = {
  experienceIndex: 0,
  experience: {
    title: "Staff Engineer",
    company: "Acme",
    start_date: "2021",
    end_date: "2024",
  },
  bullets: [],
} as unknown as BulletGroup;

const ACTIONS = createElement("span", { "data-testid": "role-actions" });

describe("RoleHeader actions (#913 follow-up)", () => {
  it("renders an editable role's actions before its dates, so the dates end the row", () => {
    const html = renderToStaticMarkup(
      createElement(RoleHeader, {
        group: GROUP,
        onFieldChange: () => {},
        actions: ACTIONS,
      }),
    );
    const actionsAt = html.indexOf('data-testid="role-actions"');
    const startAt = html.indexOf("2021");
    const endAt = html.indexOf("2024");
    expect(actionsAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(actionsAt);
    expect(endAt).toBeGreaterThan(startAt);
    // Nothing trails the end date inside the header.
    expect(html.slice(endAt)).not.toContain("role-actions");
  });

  it("still renders the actions on a read-only heading", () => {
    const html = renderToStaticMarkup(
      createElement(RoleHeader, { group: GROUP, actions: ACTIONS }),
    );
    expect(html).toContain('data-testid="role-actions"');
    expect(html).toContain("Staff Engineer");
  });
});

describe("RoleHeader — 'Current role' checkbox (#686)", () => {
  it("is disabled when the role has no start date to anchor 'ongoing'", () => {
    const undated = {
      experienceIndex: 0,
      experience: { title: "Staff Engineer", company: "Acme" },
      bullets: [],
    } as unknown as BulletGroup;
    const html = renderToStaticMarkup(
      createElement(RoleHeader, {
        group: undated,
        onFieldChange: () => {},
        actions: ACTIONS,
      }),
    );
    const checkboxAt = html.indexOf('type="checkbox"');
    expect(checkboxAt).toBeGreaterThan(-1);
    // The nearest preceding/following attributes on the same input tag.
    const tagEnd = html.indexOf(">", checkboxAt);
    expect(html.slice(checkboxAt, tagEnd)).toContain("disabled");
  });

  it("is enabled once the role has a start date", () => {
    const html = renderToStaticMarkup(
      createElement(RoleHeader, {
        group: GROUP,
        onFieldChange: () => {},
        actions: ACTIONS,
      }),
    );
    const checkboxAt = html.indexOf('type="checkbox"');
    const tagEnd = html.indexOf(">", checkboxAt);
    expect(html.slice(checkboxAt, tagEnd)).not.toContain("disabled");
  });

  it("reflects a parsed-ongoing role as checked, with no editable End cell", () => {
    const ongoing = {
      experienceIndex: 0,
      experience: {
        title: "Staff Engineer",
        company: "Acme",
        start_date: "2021",
        is_current: true,
      },
      bullets: [],
    } as unknown as BulletGroup;
    const html = renderToStaticMarkup(
      createElement(RoleHeader, {
        group: ongoing,
        onFieldChange: () => {},
        actions: ACTIONS,
      }),
    );
    const checkboxAt = html.indexOf('type="checkbox"');
    const tagEnd = html.indexOf(">", checkboxAt);
    expect(html.slice(checkboxAt, tagEnd)).toContain("checked");
    expect(html).toContain("Present");
    expect(html).not.toContain('placeholder="end date"');
  });
});
