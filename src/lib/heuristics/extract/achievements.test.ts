// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { liftHeaderLabel } from "./projects.ts";
import { extractAchievements } from "./achievements.ts";
import { achievementYearJoiner } from "../../score/entry-dates.ts";
import type { PdfLine, PdfSection } from "../sections.ts";

// liftHeaderLabel is defined in projects.ts and shared by achievementFromBlock
// (achievements.ts imports it from there). These tests cover the URL-lift
// behavior from the achievements surface — the same function handles both.

describe("liftHeaderLabel — mid-sentence domain is NOT lifted (#237)", () => {
  it("leaves return2india.com in title when mid-sentence", () => {
    // Source: "Exit · Founded and sold return2india.com to Satyam Infoway …"
    const header =
      "Exit · Founded and sold return2india.com to Satyam Infoway (NASDAQ: SIFY). 200K monthly visits. [2000]";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBeUndefined();
    expect(label).toContain("return2india.com");
  });

  it("leaves domain in title when preceded and followed by words", () => {
    const header = "Launched mysite.com for enterprise clients";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBeUndefined();
    expect(label).toContain("mysite.com");
  });
});

describe("liftHeaderLabel — standalone URL IS lifted", () => {
  it("lifts a bare standalone domain at the end of a header", () => {
    // "My OSS Library | github.com/user/repo" — domain is at end, no word after it
    const header = "My OSS Library | github.com/user/repo";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBe("github.com/user/repo");
    expect(label).toBe("My OSS Library");
  });

  it("lifts an https:// URL regardless of position", () => {
    const header =
      "Founded and sold https://return2india.com to Satyam Infoway";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBe("https://return2india.com");
    // label should have the URL removed and cleaned up
    expect(label).not.toContain("https://return2india.com");
  });

  it("lifts a domain-only header line", () => {
    const { label, url } = liftHeaderLabel(["janedoe.dev"]);
    expect(url).toBe("janedoe.dev");
    expect(label).toBe("");
  });

  it("lifts a www. URL always (standalone)", () => {
    // URL_RE matches the first domain segment: www.janedoe — the trailing .com
    // is a known URL_RE limitation (three-part domains). The key behavior under
    // test is that www. prefix triggers standalone promotion regardless of
    // surrounding text context.
    const header = "Portfolio | www.janedoe.com";
    const { url } = liftHeaderLabel([header]);
    expect(url).toBeDefined();
    expect(url).toMatch(/^www\./);
  });

  it("lifts a later standalone link past a leading mid-prose domain", () => {
    // A prose domain (acme.example) appears BEFORE a genuine standalone link
    // (github.com/me/repo). The first URL_RE hit is the prose domain, which
    // isStandaloneUrl correctly rejects — so the parser must keep scanning and
    // lift the real link, not give up on the first match.
    const header = "Sold acme.example to buyer | github.com/me/repo";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBe("github.com/me/repo");
    // The lifted link is stripped; the leading prose domain stays in the label.
    expect(label).toContain("acme.example");
    expect(label).not.toContain("github.com/me/repo");
  });
});

describe("liftHeaderLabel — substring/duplicate URL aliasing (#249)", () => {
  it("lifts standalone site.com even when mysite.com precedes it in prose", () => {
    // Class 1 aliasing: indexOf("site.com") lands inside "mysite.com" (position 2)
    // rather than at the genuine standalone occurrence after the separator.
    // With the index-passing fix, isStandaloneUrl receives the regex match index
    // (position of the real standalone "site.com"), not a re-derived indexOf.
    const header = "Built mysite.com for client | site.com";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBe("site.com");
    // The prose-embedded mysite.com stays in the label; only the standalone
    // site.com is stripped.
    expect(label).toContain("mysite.com");
    expect(label).not.toContain("| site.com");
  });

  it("strips a duplicated link cleanly with no dangling separator or raw URL", () => {
    // Class 2 aliasing: raw.replace(url, "") only removes the first occurrence.
    // The second copy of github.com/a/b would be left in the label as a raw URL.
    // With the slice-based strip, ALL regex-matched occurrences are removed.
    const header = "Repo | github.com/a/b | github.com/a/b";
    const { label, url } = liftHeaderLabel([header]);
    expect(url).toBe("github.com/a/b");
    // Label must not contain a raw URL or a dangling separator run.
    expect(label).toBe("Repo");
  });
});

// ── year_separator: the source's own title↔year punctuation (#380) ───────────
//
// The header is stored decomposed (type / title / year), so every consumer that
// shows it re-composes it and has to emit SOME separator between the parts. The
// separator the SOURCE used is therefore parse-time information — and stripping
// the date deletes it, which is how "Globex Engineering Excellence, 2021" came
// back as "Globex Engineering Excellence · 2021".

const mkLine = (text: string): PdfLine => ({
  page: 0,
  y: 0,
  x: 0,
  items: [],
  text,
  maxFontSize: 11,
  allCaps: false,
  gapAbove: 0,
});
const mkAchievements = (rows: string[]): PdfSection => ({
  name: "achievements",
  lines: rows.map(mkLine),
});

describe("extractAchievements — year_separator (#380)", () => {
  it("keeps the comma a flat award list set its year off with", () => {
    const { value } = extractAchievements(
      mkAchievements(["Globex Engineering Excellence, 2021"]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].title).toBe("Globex Engineering Excellence");
    expect(value[0].year).toBe("2021");
    expect(value[0].year_separator).toBe(",");
  });

  it("records NO separator when whitespace alone set the year off", () => {
    // Absent is not "no separator" — the consumer falls back to the middot. What
    // matters is that we don't invent a comma the résumé never wrote.
    const { value } = extractAchievements(
      mkAchievements(["Best Paper Award 2021"]),
    );
    expect(value[0].year).toBe("2021");
    expect(value[0].year_separator).toBeUndefined();
  });

  it("keeps the separator on the bulleted entry-block path too", () => {
    // A section carrying bullets routes through parseEntryBlocks, which strips
    // the date (and its punctuation) off the header before the achievement is
    // built — so the separator has to ride along on the block.
    const { value } = extractAchievements(
      mkAchievements([
        "Globex Engineering Excellence, 2021",
        "• Cited by 100+ downstream projects",
      ]),
    );
    expect(value[0].title).toBe("Globex Engineering Excellence");
    expect(value[0].year_separator).toBe(",");
  });
});

// ── A word that merely STARTS with a month prefix is not a month ─────────────
//
// The lone-date fallback and `stripDateRange` both key on a month regex. Keyed
// on the LOOSE one (`Mar` + `[a-z]*`), "Marketing", "Marathon", "Mayor" and
// friends parse as months — so the word is deleted from the title AND recorded
// as the date. STRICT_MONTH_YEAR_RE is what keeps ordinary headers intact.

describe("extractAchievements — false-month words in the title", () => {
  it.each([
    ["Head of Marketing 2020", "Head of Marketing", "2020"],
    ["Boston Marathon 2021", "Boston Marathon", "2021"],
    ["Deputy Mayor 2021", "Deputy Mayor", "2021"],
    ["Junior Fellow 2019", "Junior Fellow", "2019"],
    ["Decathlon Champion 2018", "Decathlon Champion", "2018"],
    ["Sepsis Research Grant 2020", "Sepsis Research Grant", "2020"],
  ])("keeps the whole title of %s", (row, title, year) => {
    const { value } = extractAchievements(mkAchievements([row]));
    expect(value[0].title).toBe(title);
    expect(value[0].year).toBe(year);
  });

  it("still opens a NEW entry for a header that is only a false month + year (B1b)", () => {
    // `startsNewAnchor` keys on "does anything survive stripDateRange?". When the
    // false month was eaten too, "Marketing 2021 - 2022" stripped to "" and the
    // second entry was silently merged into the first.
    const { value } = extractAchievements(
      mkAchievements([
        "Best Paper Award 2019 - 2020",
        "• Cited by 100+ downstream projects",
        "Marketing 2021 - 2022",
        "• Grew pipeline 3x",
      ]),
    );
    expect(value).toHaveLength(2);
    expect(value.map((a) => a.title)).toEqual(["Best Paper Award", "Marketing"]);
  });

  it("still captures a REAL lone month-year whole", () => {
    const { value } = extractAchievements(mkAchievements(["tinylm Jan. 2026"]));
    expect(value[0].title).toBe("tinylm");
    expect(value[0].year).toBe("2026");
  });

  it.each(["March 2021", "Sept 2021", "Sep. 2021", "May 2021"])(
    "still strips the real month-year %s off the title",
    (date) => {
      const { value } = extractAchievements(
        mkAchievements([`Best Paper Award ${date}`]),
      );
      expect(value[0].title).toBe("Best Paper Award");
    },
  );
});

// ── parse → export → re-parse is byte-stable for EVERY separator glyph ───────
//
// `dateSeparator` reports the source's own title↔year punctuation and the
// exporter re-emits it via `achievementYearJoiner`. If `stripDateRange` does not
// also REMOVE that glyph from the title, the title keeps it and the exporter
// adds a second copy — and the doubling compounds on every Download-PDF cycle
// ("Tech Lead: 2020" → "Tech Lead:: 2020" → "Tech Lead::: 2020"). One cycle
// would not catch it; two do.

/** The exporter's own recomposition of a decomposed achievement header. */
const recompose = (a: { title: string; year?: string; year_separator?: string }) =>
  a.year ? `${a.title}${achievementYearJoiner(a.year_separator)}${a.year}` : a.title;

describe("achievement header — round-trips through every date separator", () => {
  // Every glyph DATE_SEPARATOR_RE can report.
  it.each([",", ";", ":", "|", "·", "–", "—", "-"])(
    "is idempotent across two cycles with %s",
    (sep) => {
      const source = `Tech Lead${sep} 2020`;

      const first = extractAchievements(mkAchievements([source])).value[0];
      expect(first.title).toBe("Tech Lead");
      expect(first.year).toBe("2020");
      expect(first.year_separator).toBe(sep);

      // Cycle 1: export, re-parse.
      const exported1 = recompose(first);
      const second = extractAchievements(mkAchievements([exported1])).value[0];
      expect(second).toEqual(first);

      // Cycle 2: the fixed point must hold, not merely the first hop.
      const exported2 = recompose(second);
      expect(exported2).toBe(exported1);
      const third = extractAchievements(mkAchievements([exported2])).value[0];
      expect(third).toEqual(first);
    },
  );
});
