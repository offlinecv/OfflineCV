// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * End-to-end repro for #611 — dropping a `.md` whose body carries
 * reference-style links.
 *
 * Sibling of `markdown-inline-links.repro.test.ts`: same real drop path
 * (`parseMarkdownFile` → `runCascadeFromMarkdown`), over
 * `tests/fixtures/markdown/reference-links.md`, pinning the three distinct
 * leaks measured on the pre-#611 baseline. #611 was filed as a hypothesis, so
 * what that baseline actually did is worth recording:
 *
 *   1. `[label][ref]`, `[label][]` and `[label]` all survived verbatim into
 *      `PdfLine.text`, and from there into `experience[].description` and
 *      `heuristic_achievements[].title` — as the issue presumed.
 *   2. The `[ref]: url` DEFINITION line's fate turned out to depend on where it
 *      sat, which the issue did not anticipate. Under a prose section it was
 *      appended verbatim to `summary`. Above the first section header it became
 *      the contact `website_url` PLUS a bogus `kind: "other"` profile entry —
 *      the one placement #610's profile-banding cannot stop, which is why this
 *      fixture puts `[handbook]:` in the profile band. Under Education or
 *      Skills it was silently swallowed by the section extractor and left no
 *      trace in the canonical fields at all — but it still printed into
 *      `rawText`, which `EvidencePanel` shows the user verbatim. (On plain
 *      `main`, before #610's banding, ALL THREE placements leaked
 *      `website_url`.)
 *
 * The fixture is a synthetic persona (see `tests/fixtures/markdown/README.md`);
 * `npm run check:fixtures` does not cover `.md`, so treat it manually.
 */

import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCascadeFromMarkdown } from "./cascade.ts";
import { parseMarkdownFile } from "../ingest/markdown.ts";
import type { CascadeResult } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../../../tests/fixtures/markdown/reference-links.md");

let result: CascadeResult;

beforeAll(async () => {
  const { rawText, markdown } = parseMarkdownFile(
    await fsp.readFile(FIXTURE, "utf8"),
  );
  result = await runCascadeFromMarkdown(rawText, markdown);
});

/** Every string the parse produced that a reader could see in the export. */
function visibleStrings(r: CascadeResult): string[] {
  const f = r.canonical.fields;
  return [
    f.summary ?? "",
    ...(f.skills ?? []),
    ...(f.experience ?? []).flatMap((e) => [
      e.title ?? "",
      e.company ?? "",
      e.description ?? "",
    ]),
    ...(f.projects ?? []).flatMap((p) => [p.name ?? "", p.description ?? ""]),
    ...(f.heuristic_achievements ?? []).flatMap((a) => [
      a.title ?? "",
      a.type ?? "",
    ]),
    ...(f.education ?? []).flatMap((e) => [e.institution ?? "", e.degree ?? ""]),
  ];
}

describe("#611 — link-definition lines are never résumé content", () => {
  it("leaves no `[ref]: url` line in any user-visible field", () => {
    // The bare TARGET is expected to appear — `[handbook]` is used in a bullet
    // and resolves to it. What must not appear is the definition SYNTAX.
    for (const s of visibleStrings(result)) {
      expect(s).not.toMatch(/\]\s*:\s*(?:https?:|www\.)/);
    }
  });

  it("leaves no `[ref]: url` line in rawText either", () => {
    // `rawText` is not merely scorer input — `EvidencePanel` prints it back to
    // the user verbatim, so a surviving definition line is visible markdown.
    expect(result.rawText).not.toMatch(/^\s*\[[^\]]+\]:\s/m);
  });

  it("does not promote a definition-only URL to website_url or portfolio_url", () => {
    // `[handbook]:` sits ABOVE the first section header, i.e. inside the
    // profile band that #610's contact fix deliberately still trusts.
    expect(result.canonical.fields.website_url).toBeUndefined();
    expect(result.canonical.fields.portfolio_url).toBeUndefined();
  });

  it("carries only genuine contact links in profiles[]", () => {
    const profiles = result.canonical.fields.profiles ?? [];
    expect(profiles.map((p) => p.url)).toEqual([
      "https://linkedin.com/in/averyokonkwo",
      "https://github.com/averyokonkwo",
    ]);
    expect(profiles.every((p) => p.kind !== "other")).toBe(true);
  });
});

describe("#611 — reference-link usages flatten to `label url`", () => {
  it("resolves the full, collapsed, and shortcut forms in Experience bullets", () => {
    const staff = (result.canonical.fields.experience ?? []).find(
      (e) => e.company === "Example Corp",
    )?.description;
    expect(staff).toBeDefined();
    // `[label][ref]`
    expect(staff).toContain(
      "Led the catalog migration https://example.org/eng-blog/catalog-migration that cut",
    );
    // `[label][]`, matched case-insensitively against `[pricing rebuild]:`
    expect(staff).toContain(
      "Wrote the Pricing Rebuild https://example.net/pricing-rebuild design doc",
    );
    // bare `[label]`
    expect(staff).toContain(
      "Maintained the handbook https://example.org/platform-handbook every platform team",
    );
  });

  it("lifts the Projects entry URL from an angle-wrapped definition", () => {
    const project = (result.canonical.fields.projects ?? [])[0];
    expect(project).toBeDefined();
    expect(project!.name).not.toMatch(/\[|\]/);
    expect(project!.url).toBe("https://example.org/ledger-toolkit");
  });

  it("leaves no bracket residue in the achievement title, and keeps the URL as data", () => {
    const patent = (result.canonical.fields.heuristic_achievements ?? []).find(
      (a) => /Issued Patent/.test(a.title ?? ""),
    );
    expect(patent).toBeDefined();
    expect(patent!.title).not.toMatch(/\[|\]/);
    expect(patent!.title).toContain("Issued Patent XX0000000A0");
    // `startsWith`, not equality: `URL_RE` treats the fixture's trailing `;` as
    // part of the URL. That is pre-existing and path-agnostic — see the same
    // note in `markdown-inline-links.repro.test.ts`.
    expect(patent!.url).toMatch(/^https:\/\/example\.org\/patents\/XX0000000A0/);
    // The `[2019]` year marker is a shortcut-reference SHAPE that nothing
    // defines, so it stayed literal and the extractor could still read it.
    expect(patent!.year).toBe("2019");
  });

  it("leaves an UNDEFINED reference exactly as the author wrote it", () => {
    // CommonMark's own reading: `[warehouse indexer][missing]` has no
    // definition, so it IS literal text. Rewriting it would be inventing data.
    const senior = (result.canonical.fields.experience ?? []).find(
      (e) => e.company === "Northwind Systems",
    )?.description;
    expect(senior).toContain("[warehouse indexer][missing]");
  });
});
