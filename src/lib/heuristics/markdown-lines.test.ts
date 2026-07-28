// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the markdown/DOCX section path (`sectionizeMarkdown`).
 *
 * Focus: the #258 Layer B parity port. The PDF splitter (`classifyLine`) and
 * this markdown path share the same invariant — an L2 head-noun-anchor line
 * that re-matches the CURRENTLY open section is an institution entry under its
 * own header, not a new boundary, and must be retained as content. This file
 * pins that behavior on the markdown path so the two never drift.
 */

import { sectionizeMarkdown } from "./markdown-lines.ts";

describe("sectionizeMarkdown — institution name ending in a section anchor (#258 Layer B)", () => {
  it("retains an all-caps institution line under an open education section instead of eating it as a 2nd header", () => {
    const markdown = [
      "**Dana Lopez**",
      "",
      "dana.lopez@example.com | (312) 555-0123",
      "",
      "**EDUCATION**",
      "",
      "ACME PROFESSIONAL EDUCATION",
      "",
      "M.S. Data Science  2018 - 2020",
    ].join("\n");

    const { sections } = sectionizeMarkdown(markdown);

    // The institution line is retained as content inside an education section,
    // not consumed as a boundary label (which would drop the institution name).
    const inst = sections.find((s) =>
      s.lines.some((l) => l.text.includes("ACME PROFESSIONAL EDUCATION")),
    );
    expect(inst).toBeDefined();
    expect(inst!.name).toBe("education");

    // Exactly one education section — the institution line did NOT open a second.
    expect(sections.filter((s) => s.name === "education").length).toBe(1);
  });

  it("still opens a genuine L2 header for a DIFFERENT section than the one currently open", () => {
    // Suppression is gated on the CURRENTLY-open section, not "ever opened": a
    // real "Relevant Experience" (L2) header after an EDUCATION block must open
    // its own experience section, not bleed into education.
    const markdown = [
      "**Dana Lopez**",
      "",
      "dana.lopez@example.com | (312) 555-0123",
      "",
      "**EDUCATION**",
      "",
      "B.S. Computer Science, MIT  2019",
      "",
      "Relevant Experience",
      "",
      "Mentor, Local Shelter  2022 - Present",
    ].join("\n");

    const { sections } = sectionizeMarkdown(markdown);

    const mentor = sections.find((s) =>
      s.lines.some((l) => l.text.includes("Mentor, Local Shelter")),
    );
    expect(mentor).toBeDefined();
    expect(mentor!.name).toBe("experience");

    const edu = sections.find((s) =>
      s.lines.some((l) => l.text.includes("B.S. Computer Science")),
    );
    expect(edu!.name).toBe("education");
    expect(edu!.lines.some((l) => l.text.includes("Mentor"))).toBe(false);
  });
});

describe("sectionizeMarkdown — rawHeading capture (#285)", () => {
  it("captures the verbatim heading text, stripped of markdown decoration, for a synonym", () => {
    const markdown = [
      "**Dana Lopez**",
      "",
      "dana.lopez@example.com | (312) 555-0123",
      "",
      "**Work History**",
      "",
      "Engineer, Globex  2019 - 2021",
    ].join("\n");

    const { sections } = sectionizeMarkdown(markdown);

    const experience = sections.find((s) => s.name === "experience");
    expect(experience?.rawHeading).toBe("Work History");
  });

  it("leaves rawHeading undefined for the profile section", () => {
    const markdown = [
      "**Dana Lopez**",
      "",
      "dana.lopez@example.com | (312) 555-0123",
    ].join("\n");

    const { sections } = sectionizeMarkdown(markdown);

    const profile = sections.find((s) => s.name === "profile");
    expect(profile?.rawHeading).toBeUndefined();
  });
});

describe("sectionizeMarkdown — inline link flattening (#610)", () => {
  /** Convenience: the text of the single line produced by `md`. */
  const lineText = (md: string): string => {
    const { lines } = sectionizeMarkdown(md);
    expect(lines).toHaveLength(1);
    return lines[0].text;
  };

  it("flattens `[label](url)` to `label url`, matching mdToPlainText", () => {
    expect(lineText("Led the [catalog migration](https://example.org/blog/x) last year")).toBe(
      "Led the catalog migration https://example.org/blog/x last year",
    );
  });

  it("drops the optional CommonMark link title", () => {
    expect(lineText('See the [writeup](https://example.net/w "Pricing rebuild").')).toBe(
      "See the writeup https://example.net/w.",
    );
  });

  it("flattens every link on a line, not just the first", () => {
    expect(
      lineText("[one](https://example.org/1) and [two](https://example.org/2)"),
    ).toBe("one https://example.org/1 and two https://example.org/2");
  });

  it("flattens a link inside a bullet, keeping the bullet glyph", () => {
    expect(lineText("- Led the [migration](https://example.org/m) work")).toBe(
      "- Led the migration https://example.org/m work",
    );
  });

  it("emits the bare target for a degenerate empty label", () => {
    expect(lineText("Portfolio [](https://example.org/p) here")).toBe(
      "Portfolio https://example.org/p here",
    );
  });

  it("flattens a bare URI autolink to the URL itself", () => {
    expect(lineText("Site: <https://example.org/me>")).toBe(
      "Site: https://example.org/me",
    );
  });

  it("flattens an email autolink to the address itself", () => {
    expect(lineText("<riley.nakamura@example.com>")).toBe(
      "riley.nakamura@example.com",
    );
  });

  it("leaves a stray HTML-ish angle token alone — an autolink needs a scheme or an @", () => {
    expect(lineText("Wrote <b>bold</b> copy for the landing page")).toBe(
      "Wrote <b>bold</b> copy for the landing page",
    );
  });

  it("still strips markdown IMAGES entirely rather than flattening them", () => {
    // The `!`-prefixed form must never start reading as `alt url`: `stripImages`
    // runs first, so by the time `flattenLinks` sees the text the image is gone.
    expect(lineText("Headshot ![Riley Nakamura](https://example.org/me.png) here")).toBe(
      "Headshot  here",
    );
    expect(lineText("Logo ![logo](data:image/png;base64,AAAA) here")).toBe(
      "Logo  here",
    );
  });

});

describe("sectionizeMarkdown — reference-link flattening (#611)", () => {
  /** Convenience: the text of the single NON-blank line produced by `md`. */
  const lineText = (md: string): string => {
    const { lines } = sectionizeMarkdown(md);
    expect(lines).toHaveLength(1);
    return lines[0].text;
  };

  const DEFS = [
    "",
    "[cat]: https://example.org/eng-blog/catalog-migration",
    "[pricing rebuild]: https://example.net/pricing-rebuild",
  ].join("\n");

  it("flattens `[label][ref]` to `label url`, matching the inline shape", () => {
    // Was `leaves reference-style links unflattened` — #610 deferred this shape
    // and #611 claims it, so the assertion inverts rather than being deleted.
    expect(lineText(`Led the [catalog migration][cat] work${DEFS}`)).toBe(
      "Led the catalog migration https://example.org/eng-blog/catalog-migration work",
    );
  });

  it("flattens the collapsed `[label][]` and shortcut `[label]` forms too", () => {
    expect(lineText(`Wrote the [Pricing Rebuild][] doc${DEFS}`)).toBe(
      "Wrote the Pricing Rebuild https://example.net/pricing-rebuild doc",
    );
    expect(lineText(`Wrote the [Pricing Rebuild] doc${DEFS}`)).toBe(
      "Wrote the Pricing Rebuild https://example.net/pricing-rebuild doc",
    );
  });

  it("drops the `[ref]: url` definition lines entirely", () => {
    const { lines } = sectionizeMarkdown(
      `Led the [catalog migration][cat] work${DEFS}`,
    );
    expect(lines).toHaveLength(1);
    expect(lines.map((l) => l.text).join("\n")).not.toContain("]:");
  });

  it("leaves an undefined reference — and plain bracketed prose — untouched", () => {
    expect(lineText(`Owned the [warehouse indexer][missing] rewrite${DEFS}`)).toBe(
      "Owned the [warehouse indexer][missing] rewrite",
    );
    // `[2019]` is a shortcut-reference SHAPE, but nothing defines it, so it
    // stays the year marker the achievements extractor reads.
    expect(lineText(`Issued a patent. [2019]${DEFS}`)).toBe(
      "Issued a patent. [2019]",
    );
  });

  it("still flattens an INLINE link when the same line also holds a reference", () => {
    // Inline flattening runs first and consumes its own brackets, so the
    // shortcut rule can never re-read `[label](url)` as `[label]`.
    expect(
      lineText(`See [the post](https://example.org/p) and [catalog migration][cat]${DEFS}`),
    ).toBe(
      "See the post https://example.org/p and catalog migration https://example.org/eng-blog/catalog-migration",
    );
  });
});
