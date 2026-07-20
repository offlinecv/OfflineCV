// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Integration tests for `runCascadeFromMarkdown`.
 *
 * Verifies the DOCX path produces the same `CascadeResult` shape as the
 * PDF path and that a well-structured DOCX resume clears the canonical
 * confidence threshold (no LLM needed).
 */

import { runCascadeFromMarkdown } from "./cascade.ts";
import { CANONICAL_CONFIDENCE_THRESHOLD } from "./thresholds.ts";

const CLEAN_RESUME_MARKDOWN = [
  "**Jane Q. Doe**",
  "",
  "jane.doe@example.com · (415) 555-0199 · San Francisco, CA",
  "",
  "https://linkedin.com/in/janedoe · github.com/janedoe",
  "",
  "**EXPERIENCE**",
  "",
  "**Senior Software Engineer** | Acme Corp. | Jan 2022 - Present",
  "",
  "- Led migration of payments service to Kotlin, cutting P95 by 40%.",
  "- Mentored 4 engineers; owned weekly design review cadence.",
  "",
  "**Software Engineer** | Globex Inc. | Jun 2019 - Dec 2021",
  "",
  "- Shipped v2 of analytics pipeline handling 1B events/day.",
  "- Owned the answer-bank ingestion path end-to-end.",
  "",
  "**EDUCATION**",
  "",
  "Stanford University — B.S. Computer Science — 2019",
  "",
  "**SKILLS**",
  "",
  "Kotlin, TypeScript, Go, Postgres, Kubernetes, AWS, React",
].join("\n");

const CLEAN_RESUME_RAWTEXT = CLEAN_RESUME_MARKDOWN.replace(/\*\*/g, "");

describe("runCascadeFromMarkdown — clean DOCX resume", () => {
  it("produces a canonical CascadeResult", async () => {
    const result = await runCascadeFromMarkdown(
      CLEAN_RESUME_RAWTEXT,
      CLEAN_RESUME_MARKDOWN,
    );

    expect(result.confidence).toBeGreaterThanOrEqual(
      CANONICAL_CONFIDENCE_THRESHOLD,
    );
    expect(result.triggers).toEqual([]);
    expect(result.suggestedEscalation).toBe("none");

    // Shape invariants that the dashboard relies on.
    expect(result.rawText).toBe(CLEAN_RESUME_RAWTEXT);
    expect(result.markdown).toBe(CLEAN_RESUME_MARKDOWN);
    expect(result.tiers).toContain("t1_openresume");
    expect(typeof result.timings.t1_openresume_ms).toBe("number");

    expect(result.canonical.fields.full_name).toBe("Jane Q. Doe");
    expect(result.canonical.fields.email).toBe("jane.doe@example.com");
    expect(result.canonical.fields.experience.length).toBeGreaterThanOrEqual(2);

    // markdown-native cascade always reports markdown-anchored
    // section splitting. Lets telemetry split the funnel cleanly from the
    // PDF cascade's mixed markdown/regex distribution.
    expect(result.diagnostics.sectionSource).toBe("markdown");
  });

  it("emits parse_started / tier_engaged / parse_completed events", async () => {
    const events: string[] = [];
    await runCascadeFromMarkdown(CLEAN_RESUME_RAWTEXT, CLEAN_RESUME_MARKDOWN, {
      onEvent: (e) => events.push(e.type),
    });

    expect(events[0]).toBe("parse_started");
    expect(events).toContain("tier_engaged");
    expect(events[events.length - 1]).toBe("parse_completed");
  });
});

describe("runCascadeFromMarkdown — real-world DOCX fixtures", () => {
  // Fixture mirrors the shape of the `jordan-lee-sr-software-engineer.docx`
  // file that hit 0.76 in production (below canonical threshold → LLM ran):
  // turndown-escaped email, 2-digit apostrophe years, `•` bullets,
  // italic date markers. After the cleanup fixes all these should clear
  // the canonical threshold and skip the LLM.
  const TURNDOWN_ESCAPED_EMAIL_DOCX = [
    "**Jordan Lee**",
    "",
    "Sr. Software Engineer",
    "",
    "Fairview, CA | Jordan\\_Lee@outlook.com | 408-555-0100",
    "",
    "**SUMMARY**",
    "",
    "13 years experience in complete life cycle of a software product involving the phases of requirement gathering, analysis, design and development. Extensive experience in Object Oriented Design, analysis and development using C++, C#, Java and VB.",
    "",
    "**EXPERIENCE**",
    "",
    "**Sr. Software Engineer** · NIMBUS LABS _Dec '00 - Present_",
    "",
    "• Did the initial research and development, and guided other team members building this input-method application.",
    "",
    "• Created a desktop utility using C#, Visual Studio .NET and a local database.",
    "",
    "**Sr. Consultant** · ORION SYSTEMS _Apr 1995 - Dec 2000_",
    "",
    "• Designed XML interface for doing database / LDAP operations.",
    "",
    "• Implemented the XML output mechanism using Visual C++, ATL, STL.",
    "",
    "**Sr. Software Engineer** · ACME DATA, INC. _May '94 - April '95_",
    "",
    "• Enhanced different modules of the contact management software.",
    "",
    "**Sr. Software Engineer** · CRESTLINE, INC. _Oct '92 - May '94_",
    "",
    "• While leading a team, reengineered a desktop product onto a new operating-system platform.",
    "",
    "**Software Engineer** · VERTEX LIMITED _June '89 - Aug '90_",
    "",
    "• Enhanced a COBOL compiler's Accept/Display statements for new syntax.",
    "",
    "**EDUCATION**",
    "",
    "Example Institute of Technology — Bachelor of Science - Software Engineering — 1999",
    "",
    "**SKILLS**",
    "",
    "C++, C#, Java, VB.NET, ASP.NET, PHP, MySQL, SQL Server, MS Access, ODBC, UML, Windows SDK, COBOL, Perl, JDBC",
  ].join("\n");

  it("the previously-0.76 DOCX now clears CANONICAL_CONFIDENCE_THRESHOLD", async () => {
    const result = await runCascadeFromMarkdown(
      TURNDOWN_ESCAPED_EMAIL_DOCX.replace(/\\_/g, "_"),
      TURNDOWN_ESCAPED_EMAIL_DOCX,
    );
    expect(result.canonical.fields.email).toBe("Jordan_Lee@outlook.com");
    expect(result.canonical.fields.experience.length).toBeGreaterThanOrEqual(2);
    expect(result.canonical.fields.experience[0].is_current).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(
      CANONICAL_CONFIDENCE_THRESHOLD,
    );
    expect(result.suggestedEscalation).toBe("none");
  });

  // Fixture mirrors the shape of `Resume of Jordan Lee.docx` that hit
  // 0.00 in production: split-letter section headers (`**S UMMARY**`,
  // `# E XPERIENCE`), base64 image blobs, multi-line entry headers.
  const SPLIT_LETTER_HEADER_DOCX = [
    "**Jordan Lee**",
    "",
    "**Software Engineering Leader**",
    "",
    "E **415-555-0123**",
    "",
    " [**jordan.lee@example.com**](mailto:jordan.lee@example.com)",
    "",
    "e **Brookfield, CA**",
    "",
    "**S UMMARY**",
    "",
    "A seasoned engineering leader with experience managing large cross-functional, cross-site teams to deliver scalable products. Balances technical contributions and managerial responsibilities.",
    "",
    "# E XPERIENCE",
    "",
    "## Sr. Engineering Manager (L7)",
    "",
    "### Globex / CloudWave - Customer Experience Engineering",
    "",
    "![](data:image/png;base64,iVBORw0KGgo" + "A".repeat(1000) + ") 04/2021 - Present ![](data:image/png;base64,BBBBB) Rivertown, CA",
    "",
    "- Built a 50-member team across three global sites.",
    "- Enhanced the app store rating from 1.9 to 3.8.",
    "- Launch of a new cross-functional widgetized architecture with ~10% CSAT improvement.",
    "",
    "## Sr. Engineering Manager (L6 / L7)",
    "",
    "### Globex Assistant, Assistant on SmartTV",
    "",
    "![](data:image/png;base64,CCC) 06/2017 - 04/2021 ![](data:image/png;base64,DDD) Rivertown, CA",
    "",
    "- Managed a successful team for the SmartTV assistant.",
    "- Improved yield by 44%.",
    "",
    "## IC, Technical Lead",
    "",
    "### Globex Cloud Networking, Globex Media, Accessibility",
    "",
    "![](data:image/png;base64,EEE) 11/2006 - 04/2017 ![](data:image/png;base64,FFF) Rivertown, CA",
    "",
    "- Managed a team of 5 on Control Plane for Hybrid Cloud APIs.",
    "- Improved the mail app's accessibility by adding screen-reader compatibility.",
    "",
    "# E DUCATION",
    "",
    "## Bachelor of Science in Software Engineering",
    "",
    "### Example Institute of Technology, Springfield",
    "",
    "![](data:image/png;base64,GGG) 2001 - 2005 e Springfield, Freedonia",
  ].join("\n");

  it("the previously-0.0 DOCX now extracts experience and clears basics", async () => {
    const result = await runCascadeFromMarkdown(
      SPLIT_LETTER_HEADER_DOCX,
      SPLIT_LETTER_HEADER_DOCX,
    );
    expect(result.canonical.fields.full_name).toBe("Jordan Lee");
    expect(result.canonical.fields.email).toBe("jordan.lee@example.com");
    // libphonenumber-js reformats US numbers to national form: (NXX) NXX-XXXX
    expect(result.canonical.fields.phone).toMatch(/\(415\) 555-0123/);
    // Hard-fail `zero_experience_non_student` must no longer fire.
    expect(result.canonical.fields.experience.length).toBeGreaterThanOrEqual(1);
    expect(result.confidence).toBeGreaterThan(0);
  });
});

describe("runCascadeFromMarkdown — two-column DOCX with sidebar bleedthrough", () => {
  // Faithful slim of the `Resume of Jordan Lee.docx` shape that
  // regressed on the first retry: mammoth's conversion flattens the
  // two-column DOCX (main content + right sidebar) into one stream,
  // interleaving `**S KILLS**` / `**A CHIEVEMENTS**` / `**F OCUS AREAS**`
  // sidebar labels between experience entries. The previous fix made
  // those labels visible as `**SKILLS**` which opened a new section
  // mid-experience, stranding every subsequent role.
  //
  // Additionally: these entries use `## Title` + `### Company` (modern
  // convention), which exposed a title/company swap in
  // `disambiguateCompanyTitle`. Both fixes are validated by this fixture.
  const TWO_COLUMN_SIDEBAR_DOCX = [
    "**Jordan Lee**",
    "",
    "**Software Engineering Leader**",
    "",
    "E **415-555-0123**",
    "",
    " [**jordan.lee@example.com**](mailto:jordan.lee@example.com)",
    "",
    "e **Brookfield, CA**",
    "",
    "**S UMMARY**",
    "",
    "A seasoned engineering leader with experience managing large cross-functional teams.",
    "",
    "# E XPERIENCE",
    "",
    "## Sr. Engineering Manager (L7)",
    "",
    "### Globex / CloudWave",
    "",
    "04/2021 - Present Rivertown, CA",
    "",
    "- Built a 50-member team across three global sites.",
    "- Enhanced the app store rating from 1.9 to 3.8.",
    "",
    "## Sr. Engineering Manager (L6 / L7)",
    "",
    "### Globex Assistant, Assistant on SmartTV",
    "",
    "**S TRENGTHS**",
    "",
    " **Leadership**",
    "",
    "Led diverse teams across global sites.",
    "",
    "**S KILLS**",
    "",
    "**Highly Scalable Consumer Apps Mobile Development Web**",
    "",
    "06/2017 - 04/2021 Rivertown, CA",
    "",
    "- Managed a significantly successful team for the SmartTV assistant.",
    "- Improved yield by 44%.",
    "",
    "## IC, Technical Lead, TLM (L4 / L5 / L6)",
    "",
    "### Globex Cloud Networking, Globex Media, Accessibility",
    "",
    "**A CHIEVEMENTS**",
    "",
    "**Coaching A/B Testing User Growth Java C++**",
    "",
    "11/2006 - 04/2017 Rivertown, CA",
    "",
    "- Managed a team of 5 to work on Control Plane for Hybrid Cloud APIs.",
    "- Improved the mail app's accessibility by adding screen-reader compatibility.",
    "",
    "## Sr Software Engineer",
    "",
    "### Initech / WebPortal",
    "",
    "**F OCUS AREAS**",
    "",
    " **Interviewing**",
    "",
    "Over 200+ interviews.",
    "",
    "07/2004 - 11/2006 Rivertown, CA",
    "",
    "- Architected accessibility support for an in-house UI framework.",
    "",
    "## Vendor Consultant",
    "",
    "### Soylent Corp",
    "",
    "06/2003 - 03/2004 Lakeside, WA",
    "",
    "- Built a new soft keyboard for a tablet platform.",
    "",
    "## Self Employed",
    "",
    "### Nimbus / Transliterate",
    "",
    "12/2000 - 05/2003 Fairview, CA",
    "",
    "- Built a transliteration keyboard using input hooks.",
    "",
    "# E DUCATION",
    "",
    "## Bachelor of Science in Software Engineering",
    "",
    "### Example Institute of Technology, Springfield",
    "",
    "2001 - 2005 Springfield, Freedonia",
  ].join("\n");

  it("extracts all 6 experience entries despite sidebar SKILLS/ACHIEVEMENTS labels", async () => {
    const result = await runCascadeFromMarkdown(
      TWO_COLUMN_SIDEBAR_DOCX,
      TWO_COLUMN_SIDEBAR_DOCX,
    );
    expect(result.canonical.fields.experience.length).toBeGreaterThanOrEqual(6);
    // First entry is current
    expect(result.canonical.fields.experience[0].is_current).toBe(true);
    // Education still parses from the trailing `# E DUCATION` section
    expect(result.canonical.fields.education.length).toBeGreaterThanOrEqual(1);
  });

  it("assigns title/company correctly when H2=title, H3=company (modern convention)", async () => {
    const result = await runCascadeFromMarkdown(
      TWO_COLUMN_SIDEBAR_DOCX,
      TWO_COLUMN_SIDEBAR_DOCX,
    );
    const first = result.canonical.fields.experience[0];
    expect(first.title).toMatch(/Sr\.\s*Engineering Manager/);
    expect(first.company).toMatch(/Globex.*CloudWave/);

    // Verify a few others too — the whole point of this regression test is
    // that title/company aren't swapped across entries.
    const ms = result.canonical.fields.experience.find((e) =>
      /Soylent/i.test(e.company ?? ""),
    );
    expect(ms).toBeDefined();
    expect(ms?.title).toMatch(/Consultant|Vendor/);
  });

  it("skills labels in the sidebar don't open a new top-level section", async () => {
    // Indirect verification: if a mid-experience `**S KILLS**` opened a new
    // section, only the first experience entry would survive. We already
    // assert 6+ entries above — this test pins the behaviour explicitly.
    const result = await runCascadeFromMarkdown(
      TWO_COLUMN_SIDEBAR_DOCX,
      TWO_COLUMN_SIDEBAR_DOCX,
    );
    expect(result.canonical.fields.experience.length).toBeGreaterThan(1);
  });
});

describe("runCascadeFromMarkdown — escalation path", () => {
  it("escalates to LLM when basics are missing", async () => {
    // No email, no experience — hard-fail guards trip.
    const result = await runCascadeFromMarkdown(
      "Some random text with no resume shape.",
      "Some random text with no resume shape.",
    );
    expect(result.confidence).toBe(0);
    expect(result.suggestedEscalation).toBe("llm");
  });

  it("handles missing markdown gracefully (rawText only)", async () => {
    const result = await runCascadeFromMarkdown(
      "Jane Doe\njane@example.com",
      undefined,
    );
    // Without markdown we can't do Tier 1 section detection; regex fallback
    // picks up email + name at lower confidence. The cascade should still
    // return a well-formed result (not throw).
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.rawText).toBe("Jane Doe\njane@example.com");
    expect(result.tiers).toContain("t0_layout");
  });
});
