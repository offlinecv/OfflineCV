// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * End-to-end repro for #610 — dropping a `.md` whose body carries markdown
 * inline links.
 *
 * Runs the REAL drop path (`parseMarkdownFile` → `runCascadeFromMarkdown`) over
 * `tests/fixtures/markdown/inline-links.md` so both halves of the fix are
 * pinned where the user actually sees them:
 *
 *   - Step 1 (`markdown-lines.ts`): `[label](url)` and `<url>` are flattened to
 *     `label url`, so no bracket-paren syntax reaches an extractor. Before the
 *     fix, an Experience bullet rendered the raw markdown into the exported PDF
 *     and `liftHeaderLabel` left an orphaned `[label]()` in an achievement
 *     title (it spliced out the URL and nothing else).
 *   - Step 2 (`contact.ts`): a URL that lives only in a body section never
 *     becomes the contact `website_url` / `portfolio_url`. Flattening alone
 *     does not fix this — it leaves a scheme-bearing URL in body text, which
 *     the doc-wide catch-all would still steal.
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
const FIXTURE = join(HERE, "../../../tests/fixtures/markdown/inline-links.md");

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

describe("#610 — inline link syntax never survives the .md drop path", () => {
  it("leaves no markdown link syntax in any user-visible field", () => {
    for (const s of visibleStrings(result)) {
      // `[2019]`-style bracketed years are fine — it is the LINK shape
      // (`](`, or a bracket immediately followed by parens) that must be gone.
      expect(s).not.toMatch(/\]\s*\(/);
      expect(s).not.toMatch(/\]\s*\(\s*\)/);
      expect(s).not.toMatch(/<https?:/);
    }
  });

  it("keeps the Experience bullet's label text AND its target, unbracketed", () => {
    // Reproduction 2 — an Experience bullet never passes through
    // `liftHeaderLabel`, so before the fix the whole `[label](url)` rendered
    // verbatim into the exported PDF.
    const roles = result.canonical.fields.experience ?? [];
    const migration = roles.find((e) =>
      /catalog migration/.test(e.description ?? ""),
    )?.description;
    expect(migration).toBeDefined();
    expect(migration).not.toContain("[catalog migration]");
    expect(migration).toContain(
      "Led the catalog migration https://example.org/eng-blog/catalog-migration that cut",
    );

    // The titled form `[label](url "Title")` drops the title and keeps both
    // halves of the link.
    const writeup = roles.find((e) => /writeup/.test(e.description ?? ""))
      ?.description;
    expect(writeup).toContain("the writeup https://example.net/pricing-writeup");
    expect(writeup).not.toContain("Pricing rebuild");
  });

  it("leaves no orphaned `[label]()` in the achievement title, and keeps the URL as data", () => {
    const achievements = result.canonical.fields.heuristic_achievements ?? [];
    const patent = achievements.find((a) => /Issued Patent/.test(a.title ?? ""));
    expect(patent).toBeDefined();
    // `liftHeaderLabel` spliced the URL out and left the syntax behind.
    expect(patent!.title).not.toMatch(/\[|\]\(|\(\)/);
    expect(patent!.title).toContain("Issued Patent XX0000000A0");
    // The target is preserved as structured data, not discarded.
    //
    // `startsWith`, not equality: the fixture writes the repro's `…A0;` shape,
    // and `URL_RE` treats a trailing `;` as part of the URL. That is
    // pre-existing, path-agnostic behavior — a PLAIN-TEXT résumé line reading
    // "Patent A0 https://example.org/x; more prose" lifts the same `;`-suffixed
    // URL today, because `liftHeaderLabel` is shared with the PDF path. Making
    // the `.md` path agree with the plain-text path is exactly what #610
    // restores, so the suffix is in-contract here; trimming sentence
    // punctuation off `URL_RE` would move every corpus fixture and is a
    // separate change.
    expect(patent!.url).toMatch(/^https:\/\/example\.org\/patents\/XX0000000A0/);
  });

  it("lifts the Projects entry URL without leaving link syntax in the name", () => {
    const project = (result.canonical.fields.projects ?? [])[0];
    expect(project).toBeDefined();
    expect(project!.name).not.toMatch(/\[|\]\(/);
    expect(project!.url).toBe("https://example.org/ledger-toolkit");
  });
});

describe("#610 — a body-section URL never reaches the contact card", () => {
  it("does not promote any body URL to website_url or portfolio_url", () => {
    expect(result.canonical.fields.website_url).toBeUndefined();
    expect(result.canonical.fields.portfolio_url).toBeUndefined();
  });

  it("carries only genuine contact links in profiles[]", () => {
    const profiles = result.canonical.fields.profiles ?? [];
    expect(profiles.map((p) => p.url)).toEqual([
      "https://linkedin.com/in/rileynakamura",
      "https://github.com/rileynakamura",
    ]);
    expect(profiles.every((p) => p.kind !== "other")).toBe(true);
  });

  it("still resolves the autolinked LinkedIn and the bare GitHub from the header", () => {
    expect(result.canonical.fields.linkedin_url).toBe(
      "https://linkedin.com/in/rileynakamura",
    );
    expect(result.canonical.fields.github_url).toBe(
      "https://github.com/rileynakamura",
    );
  });

  it("still holds #237's line — a bare domain mid-sentence is not a website", () => {
    // "sold sidebiz.example.com to a buyer" sits in the Summary. It must not
    // surface as a contact link on ANY tier.
    const links = [
      result.canonical.fields.website_url,
      result.canonical.fields.portfolio_url,
      result.canonical.fields.linkedin_url,
      result.canonical.fields.github_url,
    ];
    expect(links.some((u) => u?.includes("sidebiz.example.com"))).toBe(false);
  });
});
