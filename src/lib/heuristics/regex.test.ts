// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, it, expect } from "vitest";
import {
  matchSectionHeader,
  matchSectionHeaderDetailed,
  matchSectionAnchorToken,
  DATE_RANGE_RE,
  STRICT_MONTH_YEAR_RE,
} from "./regex.ts";
import {
  dateSeparator,
  parseDateRange,
  stripDateRange,
} from "./line-primitives.ts";

describe("matchSectionHeader — split-letter headers (#56)", () => {
  it("matches a clean header unchanged", () => {
    expect(matchSectionHeader("EXPERIENCE")).toBe("experience");
    expect(matchSectionHeader("Education")).toBe("education");
  });

  it("recovers a split lead letter on allowlisted sections", () => {
    // Designed templates letter-space the first glyph: pdfjs reads
    // "EXPERIENCE" as "E XPERIENCE".
    expect(matchSectionHeader("E XPERIENCE")).toBe("experience");
    expect(matchSectionHeader("e xperience")).toBe("experience");
    expect(matchSectionHeader("S UMMARY")).toBe("summary");
    expect(matchSectionHeader("E DUCATION")).toBe("education");
  });

  it("does NOT recover split-letter skills (sidebar S KILLS would strand roles)", () => {
    expect(matchSectionHeader("S KILLS")).toBeNull();
  });

  it("ignores a split-letter header that doesn't reduce to a keyword", () => {
    // "EXPERIENCE FOCUS AREAS" sidebar label — rejoins to multi-word text,
    // which is not an exact keyword.
    expect(matchSectionHeader("E XPERIENCE F OCUS AREAS")).toBeNull();
  });

  it("does not mint a section from prose with an incidental split word", () => {
    expect(matchSectionHeader("i have experience")).toBeNull();
    expect(matchSectionHeader("a summary of my work")).toBeNull();
  });
});

describe("matchSectionHeader — head-noun anchor fallback (#108 / #111)", () => {
  it("classifies qualified experience headers by their head noun", () => {
    // #108 reporter's two headings.
    expect(matchSectionHeader("Relevant Experience")).toBe("experience");
    expect(matchSectionHeader("Customer Service Experience")).toBe("experience");
    // Other open-ended qualifiers over the same closed head noun.
    expect(matchSectionHeader("Editorial Experience")).toBe("experience");
    expect(matchSectionHeader("Leadership Experience")).toBe("experience");
  });

  it("classifies qualified headers for other fallback-enabled sections", () => {
    expect(matchSectionHeader("Technical Certifications")).toBe("certifications");
    expect(matchSectionHeader("Professional Awards")).toBe("achievements");
  });

  it("does not double-classify exact aliases (first loop still wins)", () => {
    // Exact aliases still resolve via the keyword path, not the fallback.
    expect(matchSectionHeader("Experience")).toBe("experience");
    expect(matchSectionHeader("Work Experience")).toBe("experience");
  });

  describe("closed-vocabulary qualifier fold promotes to the EXACT tier (#467)", () => {
    // A closed set of qualifier words ("Relevant / Additional / Performance /
    // Involvement / …" + Experience) folds to the bare "experience" anchor so it
    // matches the EXACT-alias tier (viaAnchorFallback:false), NOT the softer L2
    // anchor-fallback tier the splitter suppresses on a repeat open (#258 Layer B).
    // Without this a SECOND qualified experience header is swallowed as a content
    // line and the roles beneath it lose their entry boundary.
    it.each([
      "Relevant Experience",
      "Additional Experience",
      "Performance Experience",
      "Involvement Experience",
      "Leadership Experience",
    ])("routes %s via the exact tier (not anchor-fallback)", (header) => {
      expect(matchSectionHeaderDetailed(header)).toEqual({
        section: "experience",
        viaAnchorFallback: false,
      });
    });

    it("leaves an OPEN-ended qualifier on the soft anchor-fallback tier", () => {
      // "Customer Service Experience" is a genuine heading but its qualifier is not
      // in the closed set, so it stays a soft L2 match — unchanged by #467.
      expect(matchSectionHeaderDetailed("Customer Service Experience")).toEqual({
        section: "experience",
        viaAnchorFallback: true,
      });
    });

    it("does not fold prose or a non-experience anchor", () => {
      // The fold only fires on "<closed-qualifier…> experience"; a lowercase prose
      // fragment or a different trailing anchor is untouched.
      expect(matchSectionHeader("i have relevant experience")).toBeNull();
      expect(matchSectionHeaderDetailed("Relevant Coursework")?.viaAnchorFallback).toBe(
        false, // exact education alias, not the experience fold
      );
    });
  });

  it("rejects prose: long-form sentence with an incidental head noun", () => {
    // FP #1: over the 40-char length gate AND head noun is not the last token.
    expect(
      matchSectionHeader("5 years of relevant experience leading teams"),
    ).toBeNull();
  });

  it("rejects prose: head noun present but not the last token", () => {
    // FP #2: "Experience" appears but does not END the line — head-noun-LAST,
    // not substring contains. Title-cased so only the last-token guard rejects.
    expect(matchSectionHeader("Experience In Marketing")).toBeNull();
  });

  it("rejects lowercase prose ending in a head noun", () => {
    // FP #3: a lowercase sentence fragment that ends in an anchor is prose, not
    // a heading — the header-casing guard separates "Relevant Experience" from
    // "i have experience" (the #56 regression this would otherwise reopen).
    expect(matchSectionHeader("i have experience")).toBeNull();
    expect(matchSectionHeader("looking for new employment")).toBeNull();
  });

  it("rejects numeric-qualifier prose ending in a head noun", () => {
    // FP #3b: a digit/symbol lead char is neither lower- nor uppercase, so the
    // casing guard must require uppercase (not merely "not lowercase"), else
    // "5 Years Experience" opens an experience boundary mid-summary.
    expect(matchSectionHeader("5 Years Experience")).toBeNull();
    expect(matchSectionHeader("10+ Years Experience")).toBeNull();
    expect(matchSectionHeader("3 Years Experience")).toBeNull();
    // AC pin (#117): the text-only path stays unchanged when the L3 visual
    // recovery lands — "20% Experience" must remain null here. The recovery
    // for "20% Projects" lives in classifyLine's font-gated visual branch via
    // matchSectionAnchorToken, never on this path.
    expect(matchSectionHeader("20% Experience")).toBeNull();
  });

  it("rejects an institution name ending in an anchor word (acronym + Title-case)", () => {
    // FP #8: "ACME Professional Education" is a SCHOOL name, not an education
    // header. A mixed ALL-CAPS-acronym + Title-case line reads as an org entity
    // whose trailing anchor word is part of the name; eating it as a header drops
    // the whole entry. ALL-CAPS headers and plain Title-case headers still match.
    expect(matchSectionHeader("ACME Professional Education")).toBeNull();
    // Trailing anchor is "Academics" — would match without Guard 8.
    expect(matchSectionHeader("QSU Graduate Academics")).toBeNull();
    // Genuine headers are unaffected: wholly ALL CAPS, or wholly Title-case.
    expect(matchSectionHeader("PROFESSIONAL EXPERIENCE")).toBe("experience");
    expect(matchSectionHeader("Professional Experience")).toBe("experience");
    // A domain-qualified header pairs the acronym DIRECTLY with the head noun
    // (no proper-noun modifier between) and is a real heading, not an org name.
    expect(matchSectionHeader("IT Experience")).toBe("experience");
    expect(matchSectionHeader("HR Experience")).toBe("experience");
  });

  it("rejects a wholly-Title-case institution name ending in an anchor word (#258)", () => {
    // #258 residual hole 1: a wholly Title-case institution whose trailing word
    // is a section anchor carries NO acronym, so Guard 8 never fires — yet the
    // line is an org entity ("Harvard University Education"), not a header. The
    // institution-type word ("University"/"College") sitting BEFORE the head noun
    // is the line-local tell a genuine header never carries.
    expect(matchSectionHeader("Harvard University Education")).toBeNull();
    expect(matchSectionHeader("Riverside College Academics")).toBeNull();
    // Genuine qualified headers carry no institution-type *name* word and still
    // match, including a real L2 education header ("Academic Qualifications").
    expect(matchSectionHeader("Relevant Experience")).toBe("experience");
    expect(matchSectionHeader("Academic Qualifications")).toBe("education");
    expect(matchSectionHeader("IT Experience")).toBe("experience");
    // "School" is an interior header *qualifier*, not an org-name tell — Guard 9
    // must not reject these common student-résumé headers (it uses the narrower
    // INSTITUTION_NAME_HINTS set that drops "School").
    expect(matchSectionHeader("High School Coursework")).toBe("education");
    expect(matchSectionHeader("Business School Experience")).toBe("experience");
    expect(matchSectionHeader("Law School Experience")).toBe("experience");
    expect(matchSectionHeader("Summer School Projects")).toBe("projects");
  });

  it("rejects a header-shaped line ending in terminal punctuation", () => {
    // FP #4: terminal sentence punctuation marks prose, not a heading.
    expect(matchSectionHeader("Gained Relevant Experience.")).toBeNull();
  });

  it("rejects a Title-Case phrase over the 4-word count guard", () => {
    // FP #5: last token is a valid anchor and the phrase is header-cased, but
    // too many words (5) to be a section header.
    expect(matchSectionHeader("My Many Years Of Experience")).toBeNull();
  });

  it("rejects a bullet line whose last token is an anchor", () => {
    // FP #5: a bullet glyph means content, not a heading.
    expect(matchSectionHeader("• Relevant Experience")).toBeNull();
    expect(matchSectionHeader("- Customer Service Experience")).toBeNull();
  });

  it("keeps skills OFF the raw-line anchor path (anchorFallback false)", () => {
    // FP #6: a flattened two-column "Core Skills" / "Technical Skills" sidebar
    // label must NOT open a section via the anchor fallback — it would strand
    // every following experience role. (Bare "Skills" still matches via the
    // exact-alias keyword path; "Core Skills" is the qualified anchor case.)
    expect(matchSectionHeader("Core Skills")).toBeNull();
    expect(matchSectionHeader("Cloud Technologies")).toBeNull();
  });

  it("keeps the 'other' family OFF the anchor path", () => {
    // "other" has no anchors and anchorFallback false; qualified forms over its
    // aliases stay unclassified.
    expect(matchSectionHeader("Spoken Languages")).toBeNull();
  });
});

describe("DATE_RANGE_RE — separator-less month-year pairs (#119)", () => {
  // Awesome-CV / LaTeX templates: pdfjs drops the dash glyph entirely, leaving
  // a bare space between the two month-year anchors. Branch (b) of DATE_RANGE_RE
  // must match without any – / — / - / to / through separator.

  it("matches a bare space-separated month-year pair", () => {
    expect(DATE_RANGE_RE.test("Sep. 2023 Mar. 2024")).toBe(true);
    DATE_RANGE_RE.lastIndex = 0;
  });

  it("matches additional separator-less cases", () => {
    expect(DATE_RANGE_RE.test("Mar. 2021 Jun. 2023")).toBe(true);
    DATE_RANGE_RE.lastIndex = 0;
    expect(DATE_RANGE_RE.test("Jun. 2017 May. 2018")).toBe(true);
    DATE_RANGE_RE.lastIndex = 0;
  });

  it("matches a separator-less range embedded in a title-bearing line", () => {
    // e.g. "Site Reliability Engineer Feb. 2021 Mar. 2021"
    expect(DATE_RANGE_RE.test("Site Reliability Engineer Feb. 2021 Mar. 2021")).toBe(
      true,
    );
    DATE_RANGE_RE.lastIndex = 0;
  });

  it("parseDateRange extracts correct start and end dates (sep-less)", () => {
    const result = parseDateRange("Sep. 2023 Mar. 2024");
    expect(result.start_date).toBe("Sep. 2023");
    expect(result.end_date).toBe("Mar. 2024");
    expect(result.is_current).toBeUndefined();
  });

  it("parseDateRange extracts is_current when end is Present (sep-less)", () => {
    const result = parseDateRange("Feb. 2022 Present");
    expect(result.start_date).toBe("Feb. 2022");
    expect(result.is_current).toBe(true);
  });

  it("does NOT match bare adjacent years (too weak a signal)", () => {
    // "shipped 2020 2021 release" must not fire the separator-less branch.
    const m = DATE_RANGE_RE.exec("shipped 2020 2021 release");
    DATE_RANGE_RE.lastIndex = 0;
    expect(m).toBeNull();
  });

  it("existing dash-separator ranges still parse correctly (branch a)", () => {
    // Regression guard: classic dash branch must be byte-identical.
    const result = parseDateRange("Jan 2019 – Dec 2021");
    expect(result.start_date).toBe("Jan 2019");
    expect(result.end_date).toBe("Dec 2021");
  });

  it("existing 'to'-separator ranges still parse correctly (branch a)", () => {
    const result = parseDateRange("Mar. 2020 to Jun. 2023");
    expect(result.start_date).toBe("Mar. 2020");
    expect(result.end_date).toBe("Jun. 2023");
  });

  it("existing Present ranges still parse correctly (branch a)", () => {
    const result = parseDateRange("Apr 2021 – Present");
    expect(result.start_date).toBe("Apr 2021");
    expect(result.is_current).toBe(true);
  });
});

describe("parseDateRange — unfilled template placeholders (music_resume25)", () => {
  // Word/Office templates ship the date slot as the literal words "Month Year"
  // when unfilled. DATE_RANGE_RE recognizes them so the role still anchors and
  // the placeholder strips off the title — but parseDateRange must NOT report
  // "Month Year" as a real date, or completeness would stop flagging the dates
  // as missing.
  it("anchors a placeholder range but reports no dates (both placeholders)", () => {
    expect(DATE_RANGE_RE.test("Month Year - Month Year")).toBe(true);
    DATE_RANGE_RE.lastIndex = 0;
    expect(parseDateRange("Music Camp Counselor Month Year - Month Year")).toEqual(
      {},
    );
  });

  it("anchors a placeholder-to-Present range but reports no dates", () => {
    expect(DATE_RANGE_RE.test("Month Year - Present")).toBe(true);
    DATE_RANGE_RE.lastIndex = 0;
    expect(parseDateRange("Production Intern Month Year - Present")).toEqual({});
  });

  it("keeps a real start when only the end is a placeholder", () => {
    expect(parseDateRange("Jan 2020 - Month Year")).toEqual({
      start_date: "Jan 2020",
    });
  });

  it("does not let the bare word 'Year' anchor a date on its own", () => {
    expect(DATE_RANGE_RE.test("Five Year Plan, Member")).toBe(false);
    DATE_RANGE_RE.lastIndex = 0;
  });
});

describe("matchSectionAnchorToken — visual-path trailing anchor (#117)", () => {
  it("recovers a section from a sidebar artifact glued onto the header", () => {
    // The two-column flatten that motivates #117: a sidebar value `20%` is
    // glued onto the real `Projects` header. The trailing token is the anchor,
    // so the unguarded lookup recovers `projects`. (The font signal at the call
    // site is what licenses skipping the prose guards.)
    expect(matchSectionAnchorToken("20% Projects")).toBe("projects");
  });

  it("recovers past a leading noise-prefix glyph", () => {
    // A leading bullet/box glyph is a sidebar/list artifact, not a prose marker
    // on this font-gated path; the trailing anchor still wins.
    expect(matchSectionAnchorToken("▪ Experience")).toBe("experience");
  });

  it("does NOT match a section whose anchorFallback is false (skills)", () => {
    // `skills` has anchorFallback:false in the config, so even though `skills`
    // is its anchor, the trailing-token lookup must reject it — matching the
    // text-only path's treatment.
    expect(matchSectionAnchorToken("Random Skills")).toBeNull();
  });

  it("returns null when the last token is not an anchor", () => {
    expect(matchSectionAnchorToken("just some prose")).toBeNull();
  });

  it("recovers a glyph glued onto a single-token header (#414)", () => {
    // A mis-decoded icon-font glyph glued to a lone header token; the column
    // gate at the call site licenses stripping it here (same as #117's noise
    // prefix). skills stays excluded via anchorFallback:false.
    expect(matchSectionAnchorToken("¥Projects")).toBe("projects");
    expect(matchSectionAnchorToken("¥Skills")).toBeNull();
  });
});

describe("stripDateRange — bracket/paren residue (#236)", () => {
  it("strips a bare year in brackets, leaving no [] residue", () => {
    expect(stripDateRange("Patent · Improved caching. [2019]")).toBe(
      "Patent · Improved caching.",
    );
  });

  it("strips a bare year in parens, leaving no () residue", () => {
    expect(stripDateRange("Web Accessibility initiative. (2021)")).toBe(
      "Web Accessibility initiative.",
    );
  });

  it("strips a bare year with no brackets (existing behaviour preserved)", () => {
    expect(stripDateRange("Acquired by NASDAQ-listed company. 2020")).toBe(
      "Acquired by NASDAQ-listed company.",
    );
  });

  it("strips a full date range in brackets", () => {
    expect(stripDateRange("Open-source contribution [Jan 2018 – Mar 2020]")).toBe(
      "Open-source contribution",
    );
  });

  it("leaves text untouched when there is no date", () => {
    expect(stripDateRange("Outstanding Performer Award")).toBe(
      "Outstanding Performer Award",
    );
  });
});

describe("parseDateRange — season-comma dates (#250)", () => {
  // "Summer 2013, 2014" = branch (c): Season YYYY, YYYY.
  it("recognises 'Summer 2013, 2014' as a date range", () => {
    expect(DATE_RANGE_RE.test("Summer 2013, 2014")).toBe(true);
    DATE_RANGE_RE.lastIndex = 0;
  });

  it("parses 'Summer 2013, 2014' — start is season+year, end is second year", () => {
    const result = parseDateRange("Summer 2013, 2014");
    expect(result.start_date).toBe("Summer 2013");
    expect(result.end_date).toBe("2014");
    expect(result.is_current).toBeUndefined();
  });

  it("parses a role line containing 'Summer 2013, 2014'", () => {
    const result = parseDateRange("Volunteer Swim Coach Summer 2013, 2014");
    expect(result.start_date).toBe("Summer 2013");
    expect(result.end_date).toBe("2014");
  });

  it("recognises other season words (Spring, Fall, Winter, Autumn)", () => {
    for (const season of ["Spring", "Fall", "Winter", "Autumn"]) {
      const text = `${season} 2022, 2023`;
      expect(DATE_RANGE_RE.test(text)).toBe(true);
      DATE_RANGE_RE.lastIndex = 0;
      const result = parseDateRange(text);
      expect(result.start_date).toBe(`${season} 2022`);
      expect(result.end_date).toBe("2023");
    }
  });

  it("recognises 'Summer 2013 – 2014' via the classic dash separator (branch a)", () => {
    // Season YYYY is now in DATE_ANCHOR, so branch (a) fires too.
    const result = parseDateRange("Summer 2013 – 2014");
    expect(result.start_date).toBe("Summer 2013");
    expect(result.end_date).toBe("2014");
  });

  it("does NOT match a bare season word without a year", () => {
    expect(DATE_RANGE_RE.test("Summer internship")).toBe(false);
    DATE_RANGE_RE.lastIndex = 0;
  });

  it("strips a season-comma date from a role line", () => {
    expect(stripDateRange("Volunteer Swim Coach Summer 2013, 2014")).toBe(
      "Volunteer Swim Coach",
    );
  });
});

describe("matchSectionHeader — leading decorative glyph (#414)", () => {
  it("recognizes a skills header carrying a leading icon-font glyph", () => {
    // The repro: a mis-decoded icon-font glyph U+00A5 `¥` glued to `Skills`
    // (no space) survives the trailing-punct normalizer and blocks the exact
    // keyword match. Strip the leading glyph run and the section is recovered.
    expect(matchSectionHeader("¥Skills")).toBe("skills");
  });

  it("recognizes other leading-glyph variants and section words", () => {
    expect(matchSectionHeader("§Experience")).toBe("experience");
    expect(matchSectionHeader("★ Education")).toBe("education");
    // Glyph + no space in front of a split-letter header still rejoins.
    expect(matchSectionHeader("¥E XPERIENCE")).toBe("experience");
  });

  it("leaves an ordinary header untouched", () => {
    expect(matchSectionHeader("Skills")).toBe("skills");
    expect(matchSectionHeader("SKILLS")).toBe("skills");
  });

  it("does NOT coerce a symbol-led non-header line into a section", () => {
    // A leading bullet is content, not a heading — stripping it must not mint a
    // skills section from a bullet line.
    expect(matchSectionHeader("• Skills you should learn")).toBeNull();
    expect(matchSectionHeader("- Skills")).toBeNull();
    // A numeric/currency-lead line is not a header: LEADING_GLYPH_RE stops at
    // the first alphanumeric, so nothing is stripped and no keyword matches.
    expect(matchSectionHeader("$100k skills budget")).toBeNull();
    expect(matchSectionHeader("20% skills")).toBeNull();
    // Glyph-led prose whose stripped remainder is not a bare keyword.
    expect(matchSectionHeader("¥ proficient in typescript and go")).toBeNull();
  });
});

describe("matchSectionHeader — compound X & Y headers (#462)", () => {
  it("routes 'Certifications & Activities' to certifications (left-side wins)", () => {
    expect(matchSectionHeader("Certifications & Activities")).toBe(
      "certifications",
    );
    expect(matchSectionHeader("CERTIFICATIONS & ACTIVITIES")).toBe(
      "certifications",
    );
  });

  it("routes 'X and Y' word-form to the left side's section", () => {
    expect(matchSectionHeader("Certifications and Activities")).toBe(
      "certifications",
    );
  });

  it("falls through to the right side when the left side is not an alias", () => {
    // "Personal" is not an alias; "achievements" is — the compound router
    // splits on ` and ` and takes the RIGHT side once the left fails. The
    // literal ` and ` (or ` & `) connective IS required — a bare
    // "Personal Achievements" would hit the pre-existing head-noun anchor-
    // fallback tier instead, so the compound router itself must be tested
    // through a real connective to cover its right-side path.
    expect(matchSectionHeader("Personal and Achievements")).toBe(
      "achievements",
    );
    expect(matchSectionHeader("Personal & Achievements")).toBe(
      "achievements",
    );
  });

  it("keeps existing 'awards & honors' behavior (achievements, either tier)", () => {
    // Was pre-#462 covered by explicit compound aliases in sections.config.json;
    // now the compound router alone would also route it. Behavior unchanged.
    expect(matchSectionHeader("Awards & Honors")).toBe("achievements");
    expect(matchSectionHeader("Honors & Awards")).toBe("achievements");
  });

  it("routes 'Skills & Interests' to skills (left side wins over 'other')", () => {
    expect(matchSectionHeader("Skills & Interests")).toBe("skills");
  });

  it("does not mint a section when neither side is an alias", () => {
    expect(matchSectionHeader("Head Coach & Assistant")).toBeNull();
  });

  it("rejects a leading-bullet compound line (PR #483 review)", () => {
    // A `•`-led bullet like "• Public speaking and leadership" splits on ` and `
    // to `• Public speaking` / `leadership`. `leadership` is a single-word
    // `experience` alias — without the LEADING_BULLET_RE guard the compound
    // tier would open an `experience` section mid-body from an ordinary bullet
    // (verified on the reviewer's four repro strings).
    expect(matchSectionHeader("• Public speaking and leadership")).toBeNull();
    expect(matchSectionHeader("• Committee member and volunteer")).toBeNull();
    expect(matchSectionHeader("• Dean's List and Honors")).toBeNull();
    expect(matchSectionHeader("• Mentored juniors and interests")).toBeNull();
  });
});

describe("parseDateRange — lone (un-paired) dates (#380)", () => {
  // A project/award dated with a single "Mon. YYYY" and no end date never
  // matches the PAIRED DATE_RANGE_RE, so it falls to the loose fallback. That
  // fallback used to keep only the bare year, which left the month word stuck in
  // the entry title ("tinylm | Link Jan." · "2026"). Start and strip must move
  // together: whatever the date captures, the title must lose.
  it("captures a lone 'Mon. YYYY' whole — month AND year", () => {
    expect(parseDateRange("tinylm | Link Jan. 2026")).toEqual({
      start_date: "Jan. 2026",
    });
  });

  it("strips the month with the year, leaving a clean title", () => {
    expect(stripDateRange("tinylm | Link Jan. 2026")).toBe("tinylm | Link");
  });

  it("captures a lone month spelled in full, and without a period", () => {
    expect(parseDateRange("Portfolio site January 2026").start_date).toBe(
      "January 2026",
    );
    expect(parseDateRange("Portfolio site May 2023").start_date).toBe("May 2023");
    expect(stripDateRange("Portfolio site May 2023")).toBe("Portfolio site");
  });

  it("still parses a lone BARE year exactly as before (no month to absorb)", () => {
    expect(parseDateRange("Best Paper Award 2021")).toEqual({
      start_date: "2021",
    });
    expect(stripDateRange("Best Paper Award 2021")).toBe("Best Paper Award");
  });

  it("keeps the EARLIEST date token when a bare year precedes a month-year", () => {
    // The fallback has always taken the FIRST date token in the line; absorbing
    // the month must not reorder that. Here the bare year comes first, so it
    // still wins.
    expect(parseDateRange("2019 cohort, revisited Jan. 2026").start_date).toBe(
      "2019",
    );
  });

  it("leaves PAIRED ranges untouched (the fallback never runs)", () => {
    expect(parseDateRange("Jan. 2020 – Mar. 2021")).toEqual({
      start_date: "Jan. 2020",
      end_date: "Mar. 2021",
    });
    expect(parseDateRange("2019 - 2021")).toEqual({
      start_date: "2019",
      end_date: "2021",
    });
    expect(parseDateRange("Jan 2020 - Present")).toEqual({
      start_date: "Jan 2020",
      is_current: true,
    });
    expect(parseDateRange("Sep. 2023 Mar. 2024")).toEqual({
      start_date: "Sep. 2023",
      end_date: "Mar. 2024",
    });
    expect(stripDateRange("Acme Corp Jan. 2020 – Mar. 2021")).toBe("Acme Corp");
  });

  it("records no date for an unfilled 'Month Year' template placeholder", () => {
    // The word placeholders live only in the PAIRED anchors, so the lone
    // fallback must not resurrect them as a real date.
    expect(parseDateRange("Production Intern Month Year")).toEqual({});
  });

  it("reports no date when the line carries none", () => {
    expect(parseDateRange("Outstanding Performer Award")).toEqual({});
  });
});

describe("dateSeparator — the punctuation a date was set off by (#380)", () => {
  it("returns the comma a flat award list used", () => {
    expect(dateSeparator("Globex Engineering Excellence, 2021")).toBe(",");
  });

  it("returns undefined when whitespace alone set the date off", () => {
    expect(dateSeparator("Best Paper Award 2021")).toBeUndefined();
  });

  it("returns undefined when the date LEADS the line (nothing to set off)", () => {
    expect(dateSeparator("2021 2nd Place, AWS GameDay")).toBeUndefined();
  });

  it("returns undefined when the line carries no date", () => {
    expect(dateSeparator("Dean's List")).toBeUndefined();
  });

  it("reads the separator in front of a month-year date too", () => {
    expect(dateSeparator("tinylm – Jan. 2026")).toBe("–");
  });
});

describe("month regexes — loose for POSITION, strict for VALUE", () => {
  it("STRICT_MONTH_YEAR_RE does not match a word that merely starts with a month", () => {
    for (const word of ["Marketing", "Marathon", "Mayor", "Junior", "Decathlon", "Sepsis"]) {
      STRICT_MONTH_YEAR_RE.lastIndex = 0;
      expect(STRICT_MONTH_YEAR_RE.test(`${word} 2020`)).toBe(false);
      STRICT_MONTH_YEAR_RE.lastIndex = 0;
    }
  });

  it("STRICT_MONTH_YEAR_RE matches every real month spelling it must", () => {
    for (const m of [
      "Jan", "January", "Feb", "February", "Mar", "March", "Apr", "April",
      "May", "Jun", "June", "Jul", "July", "Aug", "August", "Sep", "Sept",
      "September", "Oct", "October", "Nov", "November", "Dec", "December",
    ]) {
      STRICT_MONTH_YEAR_RE.lastIndex = 0;
      expect(STRICT_MONTH_YEAR_RE.test(`${m} 2020`), m).toBe(true);
      STRICT_MONTH_YEAR_RE.lastIndex = 0;
      expect(STRICT_MONTH_YEAR_RE.test(`${m}. '20`), `${m}. '20`).toBe(true);
      STRICT_MONTH_YEAR_RE.lastIndex = 0;
    }
  });

  it("parseDateRange does not read a false month as the date", () => {
    // Loose MONTH_YEAR_RE reads "Marketing 2020" as a month-year, so the lone-date
    // fallback recorded start_date "Marketing 2020" and stripDateRange ate the word.
    expect(parseDateRange("Head of Marketing 2020")).toEqual({ start_date: "2020" });
    expect(parseDateRange("Boston Marathon 2021")).toEqual({ start_date: "2021" });
    expect(parseDateRange("Deputy Mayor 2021")).toEqual({ start_date: "2021" });
  });

  it("parseDateRange still captures a real lone month-year whole", () => {
    expect(parseDateRange("tinylm | Link Jan. 2026")).toEqual({
      start_date: "Jan. 2026",
    });
  });

  it("stripDateRange leaves a false month in the title", () => {
    expect(stripDateRange("Head of Marketing 2020")).toBe("Head of Marketing");
    expect(stripDateRange("Sepsis 2020")).toBe("Sepsis");
  });

  it("leaves a remainder for a header that is ONLY a false month + year", () => {
    // `startsNewAnchor` (entry-blocks.ts) decides "is this line a NEW entry?" by
    // asking whether anything SURVIVES stripDateRange. Over-stripping reduced
    // "Marketing 2021 - 2022" to "" — so the header stopped being an anchor and
    // was silently merged into the previous entry. The remainder is the contract.
    expect(stripDateRange("Marketing 2021 - 2022")).toBe("Marketing");
    expect(stripDateRange("Marathon 2019 - 2020")).toBe("Marathon");
    // A genuine bare date tail still strips to nothing — that is what lets a
    // wrapped "… Jan 2022 -" / "Present" reassemble instead of opening a role.
    expect(stripDateRange("Jan 2020 - Present")).toBe("");
  });
});

describe("stripDateRange — trailing separator trim", () => {
  // Every glyph `dateSeparator` reports EXCEPT `·`. A glyph that is reported but
  // not trimmed is kept twice — once on the title, once re-emitted by the
  // consumer that was told about it — and the doubling grows on every
  // parse→export→re-parse cycle ("Tech Lead: 2020" → "Tech Lead:: 2020" → …).
  // `;` and `:` were exactly that case (#380).
  it.each([",", ";", ":", "|", "–", "—", "-"])(
    "removes %s along with the date it held",
    (sep) => {
      expect(stripDateRange(`Tech Lead${sep} 2020`)).toBe("Tech Lead");
    },
  );

  // `·` is the deliberate exception, and it must STAY one. The middot is the
  // org-signature marker the anchor-position tiebreak keys on: a location-less
  // reconstructed role emits "Company · Dates", and the gate has to SEE that
  // marker to know the anchor line is the company rather than the title — it
  // strips the marker itself, after firing. Trimming the middot here destroys the
  // evidence before the gate can read it, and the role's title and company swap
  // (extract/experience.anchor-tiebreak.test.ts, #298).
  //
  // It cannot double the way `;`/`:` did, because `splitAchievementType` consumes
  // the " · " boundary before a middot can ever end up trailing a title.
  it("preserves · — it is the org-signature marker, not date punctuation", () => {
    expect(stripDateRange("Northern Trust · Jan 2019 - Mar 2021")).toBe(
      "Northern Trust ·",
    );
  });
});
