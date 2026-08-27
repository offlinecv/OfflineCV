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

describe("extractAchievements — splitType: false (#899)", () => {
  it("never splits a leading 'Type · title' segment for a certification", () => {
    // Un-opted-in (achievements default): a header carrying the canonical
    // "Type · title" shape splits — the exact shape `splitAchievementType`
    // recognizes, and the one a credential line can genuinely carry when a
    // résumé sets its issuer or category off with a middot ("AWS · Certified
    // Solutions Architect").
    const split = extractAchievements(
      mkAchievements(["AWS · Certified Solutions Architect"]),
    );
    expect(split.value[0].type).toBe("AWS");
    expect(split.value[0].title).toBe("Certified Solutions Architect");

    // `splitType: false` preserves the whole credential name and never sets
    // `type` — nonsensical for a credential, which is not "Type · label" shaped
    // even when it happens to contain a middot (#899). This exercises the
    // option ALONE; the real certifications call site pairs it with
    // `splitCompactList`, under which that same middot reads as a credential
    // boundary instead — see the `splitCompactList` block below for why that
    // reading has to win.
    const unsplit = extractAchievements(
      mkAchievements(["AWS · Certified Solutions Architect"]),
      { splitType: false },
    );
    expect(unsplit.value[0].type).toBeUndefined();
    expect(unsplit.value[0].title).toBe("AWS · Certified Solutions Architect");
  });

  it("preserves a plain credential title (no split candidate either way)", () => {
    const { value } = extractAchievements(
      mkAchievements(["Patent Bar Registration"]),
      { splitType: false },
    );
    expect(value[0].type).toBeUndefined();
    expect(value[0].title).toBe("Patent Bar Registration");
  });
});

// ── The compact certifications line, read back apart (#899) ──────────────────
//
// The exporter compresses two or more credentials onto ONE middot-joined line
// and the renderer wraps it ATOMICALLY, so every extracted line of the block
// begins at a credential boundary. `splitCompactList` is the inverse of that,
// and these cover the shapes the hop can produce plus the source shapes the
// split must not damage. The end-to-end proof over a real PDF lives in
// `corpus-roundtrip.test.ts`; this pins the line-level contract.
describe("extractAchievements — splitCompactList (#899)", () => {
  /** The certifications call site: both options, exactly as `openresume.ts`
   *  passes them. */
  const certifications = (rows: string[]) =>
    extractAchievements(mkAchievements(rows), {
      splitType: false,
      splitCompactList: true,
    }).value;

  it("splits one middot-joined line into one entry per credential", () => {
    const value = certifications([
      "AWS Certified Cloud Practitioner (2025) · AWS Certified Solutions Architect (2026) · CKA",
    ]);
    expect(value.map((v) => [v.title, v.year])).toEqual([
      ["AWS Certified Cloud Practitioner", "2025"],
      ["AWS Certified Solutions Architect", "2026"],
      ["CKA", undefined],
    ]);
  });

  it("splits a WRAPPED compact list, whose lines are credential-aligned", () => {
    // What `wrapSegmentsToLines` actually emits: whole segments per line, the
    // separator re-drawn only BETWEEN the segments that share a line. The tail
    // line carries no separator of its own and must still open its own entry.
    const value = certifications([
      "AWS Certified Cloud Practitioner (2025) · AWS Certified Solutions Architect (2026)",
      "Certified Kubernetes Administrator (CKA) (2021)",
    ]);
    expect(value.map((v) => v.title)).toEqual([
      "AWS Certified Cloud Practitioner",
      "AWS Certified Solutions Architect",
      "Certified Kubernetes Administrator (CKA)",
    ]);
    expect(value.map((v) => v.year)).toEqual(["2025", "2026", "2021"]);
  });

  it("opens an entry for a lowercase-led credential on a wrapped tail line", () => {
    // The wrapped-tail FOLD (`isAwardContinuation`) is switched off for the
    // whole section once any line carries the separator: a credential that
    // happens to start lowercase would otherwise be swallowed by the line
    // above, silently losing it. Nothing can be a wrapped tail here — the
    // renderer never breaks inside a credential.
    const value = certifications([
      "AWS Certified Cloud Practitioner (2025) · AWS Certified Solutions Architect (2026)",
      "iOS App Development Certification (2020)",
    ]);
    expect(value).toHaveLength(3);
    expect(value[2].title).toBe("iOS App Development Certification");
  });

  it("re-joins a date-only fragment to the credential it dates", () => {
    // A source that wrote "CKA · 2021" means the middot as its YEAR separator,
    // not as a list boundary. Splitting there would strand "2021" as a
    // title-less entry (dropped) and rob "CKA" of its year, so the fragment is
    // re-joined verbatim — leaving this line parsing exactly as it did before
    // the split existed, separator included.
    const value = certifications(["CKA · 2021 · AWS Certified Developer"]);
    expect(value).toEqual([
      { title: "CKA", year: "2021", year_separator: "·" },
      { title: "AWS Certified Developer" },
    ]);
  });

  it("re-joins a MONTH-year fragment, not only a bare 4-digit year", () => {
    // The first cut gated the re-join on `isLoneDateRange({allowSingle:true})`,
    // which by its own docblock admits ONLY a bare `(19|20)\d{2}`. "May 2021"
    // fell through it, opened an empty-titled block of its own and was dropped
    // by `finalizeEntries` — the credential silently lost its date on an
    // ordinary source shape. The gate is now "the segment reduces to nothing
    // but a date", which every parseable date form satisfies.
    expect(certifications(["CKA · May 2021"])).toEqual([
      { title: "CKA", year: "2021", year_separator: "·" },
    ]);
    expect(certifications(["CKA · May 2021 · AWS Certified Developer"])).toEqual(
      [
        { title: "CKA", year: "2021", year_separator: "·" },
        { title: "AWS Certified Developer" },
      ],
    );
  });

  it("keeps an apostrophe-year with its credential instead of minting one", () => {
    // No date regex in the pipeline reads a bare "'21" as a date, so it cannot
    // become a `year` — but it must not become a CREDENTIAL either. Re-joining
    // keeps it verbatim on the title it dates; splitting it off listed a
    // certification named "'21".
    const value = certifications(["CKA · '21 · AWS Certified Developer"]);
    expect(value.map((v) => v.title)).toEqual([
      "CKA · '21",
      "AWS Certified Developer",
    ]);
  });

  it("dates the credential AFTER a leading date fragment", () => {
    // A source that writes the year on the left has nothing behind the date to
    // re-join it to. Holding it for the credential that follows is what keeps
    // the year; the first cut opened a title-less block and dropped it.
    expect(certifications(["2021 · CKA · AWS Certified Developer"])).toEqual([
      { title: "CKA", year: "2021", year_separator: "·" },
      { title: "AWS Certified Developer" },
    ]);
  });

  it("reads 'Name · Issuer · Year' as ONE dated credential, not two", () => {
    // The fabrication case. Split segment-by-segment, the trailing year binds
    // to the ISSUER and the section lists a certification called "Amazon Web
    // Services, 2024" that the résumé never claimed. A trailing date after two
    // or more date-less segments is the everyday "Credential · Issuer · Date"
    // row — a shape our own exporter never emits, since it parenthesises every
    // year — so the whole line stays one entry.
    expect(
      certifications([
        "AWS Certified Solutions Architect · Amazon Web Services · 2024",
      ]),
    ).toEqual([
      {
        title: "AWS Certified Solutions Architect · Amazon Web Services",
        year: "2024",
        year_separator: "·",
      },
    ]);
  });

  it("still splits a list whose credentials each carry their own year", () => {
    // The guard that keeps the row-reading above from swallowing a genuine
    // list: an EARLIER segment carrying a date of its own means the middots are
    // list boundaries, so the trailing year dates only the credential before it.
    expect(
      certifications(["CKA · 2021 · AWS Certified Developer · 2022"]),
    ).toEqual([
      { title: "CKA", year: "2021", year_separator: "·" },
      { title: "AWS Certified Developer", year: "2022", year_separator: "·" },
    ]);
    // Same guard, the exporter's own parenthesised shape.
    expect(
      certifications([
        "AWS Certified Cloud Practitioner (2025) · CKA · 2021",
      ]).map((v) => [v.title, v.year]),
    ).toEqual([
      ["AWS Certified Cloud Practitioner", "2025"],
      ["CKA", "2021"],
    ]);
  });

  it("reads SEVERAL dated credential rows off ONE line", () => {
    // A two-column certifications block reaches line assembly as a single
    // `PdfLine`, so the "Credential · Issuer · Year" row above arrives twice
    // over. Judged whole-line, the first triple's year counts as "an earlier
    // segment carries a date", the collapse is refused for the entire line, and
    // every trailing year binds to the ISSUER beside it — fabricating "Google,
    // 2023" and "CNCF, 2021". Each date-terminated RUN is judged on its own.
    expect(
      certifications([
        "Google Cloud Architect · Google · Mar 2023 · CKA · CNCF · Jun 2021",
      ]),
    ).toEqual([
      {
        title: "Google Cloud Architect · Google",
        year: "2023",
        year_separator: "·",
      },
      { title: "CKA · CNCF", year: "2021", year_separator: "·" },
    ]);
  });

  it("never dates the ISSUER of a trailing UNDATED row", () => {
    // Same line shape, but the second triple's year is missing. The dated run
    // still collapses; the undated tail has no year to bind, so it splits per
    // credential exactly as any other date-less delimited stretch does — two
    // truthful strings rather than an invented "PMI, 2020".
    expect(
      certifications(["PMP · PMI · 2020 · CSM · Scrum Alliance"]),
    ).toEqual([
      { title: "PMP · PMI", year: "2020", year_separator: "·" },
      { title: "CSM" },
      { title: "Scrum Alliance" },
    ]);
  });

  it("keeps a per-credential year list splitting when a dated ROW precedes it", () => {
    // The two readings on ONE line: a dated row, then a list whose credentials
    // each carry their own middot-separated year. Judged per run, the row
    // collapses and the list stays a list — neither reading leaks into the
    // other's half of the line.
    expect(
      certifications([
        "AWS Certified Solutions Architect · Amazon Web Services · 2024 · CKA · 2021",
      ]),
    ).toEqual([
      {
        title: "AWS Certified Solutions Architect · Amazon Web Services",
        year: "2024",
        year_separator: "·",
      },
      { title: "CKA", year: "2021", year_separator: "·" },
    ]);
  });

  it("drops a second leading date instead of picking one of the two", () => {
    // A section opening on two bare dates has no block to re-join to and no
    // credential yet to date, and the two cannot both be the credential's year.
    // Silently keeping the last (what the held date used to do) dates "CKA" 2025
    // on a coin flip; the held date is flushed into a title-less block and
    // dropped by `finalizeEntries` instead, leaving the credential undated.
    expect(certifications(["2024 · 2025 · CKA"])).toEqual([{ title: "CKA" }]);
  });

  it("leaves a single undelimited credential exactly as it was", () => {
    // No separator anywhere in the section, so nothing splits and the flag is
    // inert — the one-certification résumé is byte-identical to pre-#899.
    expect(certifications(["Certified Kubernetes Administrator (CKA), 2021"])).toEqual([
      { title: "Certified Kubernetes Administrator (CKA)", year: "2021", year_separator: "," },
    ]);
  });

  it("still folds a genuine wrapped tail while no line carries a separator", () => {
    // The undelimited section keeps `parseFlatAwardList`'s original behaviour:
    // a lowercase-led line is a wrapped tail of the award above it (#225).
    const value = certifications([
      "Certified Information Systems Security Professional",
      "issued by ISC2, 2022",
    ]);
    expect(value).toHaveLength(1);
    expect(value[0].title).toBe(
      "Certified Information Systems Security Professional issued by ISC2",
    );
  });

  it("absorbs the spacing variance a PDF extractor hands back", () => {
    // The boundary is "middot with WHITESPACE on both sides", not one literal
    // U+0020 either side: the extractor widens or narrows the drawn gap freely.
    // `\s` is what expresses that, and it also covers the NBSP / thin spaces a
    // PDF can carry — those need no case of their own, since a class this test
    // already proves is applied cannot then exclude one of its own members.
    const value = certifications([
      "AWS Certified Developer  ·   CKA · Terraform Associate",
    ]);
    expect(value.map((v) => v.title)).toEqual([
      "AWS Certified Developer",
      "CKA",
      "Terraform Associate",
    ]);
  });

  it("does not split a middot glued inside a token", () => {
    // Whitespace is required on both sides, so a glyph carried INSIDE a
    // credential name is not a boundary.
    expect(certifications(["R·D Practitioner Certificate"])).toEqual([
      { title: "R·D Practitioner Certificate" },
    ]);
  });

  it("is OFF for achievements — a 'Type · title' header stays one award", () => {
    // The default. An achievement header uses the middot as a DISPLAY joiner
    // ("Patent · Foo", "keyword · statement · year", #307/#456), so splitting
    // one would shred a single award into fragments.
    const { value } = extractAchievements(
      mkAchievements(["Patent · System and method for ranking catalogs, 2019"]),
    );
    expect(value).toHaveLength(1);
    expect(value[0].type).toBe("Patent");
    expect(value[0].title).toBe("System and method for ranking catalogs");
  });

  it("reads an issuer middot as a boundary — the deliberate tradeoff", () => {
    // "Issuer · Credential" on a source line is genuinely ambiguous against the
    // compact list, and this reading is the one that has to win: over-segmenting
    // a source quirk splits one credential into two truthful strings, while the
    // other reading MERGES every credential of our own exported PDF into one and
    // loses N-1 of them outright. Pinned so the choice is a decision, not drift.
    expect(certifications(["AWS · Certified Solutions Architect"])).toEqual([
      { title: "AWS" },
      { title: "Certified Solutions Architect" },
    ]);
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
