// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Unit tests for the pure `toJsonResume` adapter (#334): basics (incl. profiles
 * and location), work, education, skills, projects, date normalization, and a
 * fixture round-trip (parse → model → toJsonResume) that asserts SHAPE only (no
 * PII values dumped — the fixture is a synthetic persona regardless).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import {
  toJsonResume,
  normalizeJsonResumeDate,
  toJsonResumeLocation,
  formatJsonResumeLocation,
  JSON_RESUME_SCHEMA,
} from "./to-json-resume.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { runCascade } from "../heuristics/cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import { APP_VERSION } from "../version.ts";

// A structurally complete model covering every mapped section kind.
const FULL_MODEL: AtsResumeModel = {
  contact: {
    name: "Jane Candidate",
    email: "jane@example.com",
    phone: "(312) 555-0123",
    location: "Chicago, IL",
    links: ["linkedin.com/in/jane"],
    profiles: [
      { url: "https://linkedin.com/in/jane", network: "LinkedIn", kind: "social" },
      { url: "https://github.com/JaneC", network: "GitHub", kind: "code" },
      { url: "https://jane.dev", network: "jane.dev", kind: "other" },
    ],
  },
  summary: "A summary.",
  summaryHeading: "Summary",
  sections: [
    {
      heading: "Experience",
      kind: "experience",
      entries: [
        {
          headerLine: "Senior Engineer",
          bullets: ["Shipped X", "Led Y"],
          fields: {
            organization: "Acme Corp",
            position: "Senior Engineer",
            startDate: "Jan 2020",
            endDate: "March 2022",
          },
        },
        {
          headerLine: "Engineer",
          bullets: [],
          fields: {
            organization: "Startup Inc",
            position: "Engineer",
            startDate: "2022",
            isCurrent: true,
            endDate: "2099", // must be dropped because isCurrent
          },
        },
      ],
    },
    {
      heading: "Projects",
      kind: "projects",
      entries: [
        {
          headerLine: "Cool Project",
          bullets: ["Built a thing"],
          fields: {
            organization: "Cool Project",
            url: "https://github.com/JaneC/cool",
            startDate: "Summer 2021",
          },
        },
      ],
    },
    {
      heading: "Education",
      kind: "education",
      entries: [
        {
          headerLine: "B.S., Computer Science",
          bullets: ["Coursework: Algorithms, Databases"],
          fields: {
            organization: "State University",
            studyType: "B.S.",
            area: "Computer Science",
            endDate: "2019",
            courses: ["Algorithms", "Databases"],
          },
        },
      ],
    },
    {
      heading: "Skills",
      kind: "skills",
      entries: [
        {
          headerLine: "TypeScript · React · Node.js",
          bullets: [],
          atomicSegments: true,
          fields: { skills: ["TypeScript", "React", "Node.js"] },
        },
      ],
    },
  ],
};

describe("toJsonResume — top-level shape", () => {
  const doc = toJsonResume(FULL_MODEL);

  it("stamps the schema URL and meta.version", () => {
    expect(doc.$schema).toBe(JSON_RESUME_SCHEMA);
    expect(doc.meta.version).toBe(APP_VERSION);
  });

  it("always emits the four arrays", () => {
    expect(Array.isArray(doc.work)).toBe(true);
    expect(Array.isArray(doc.education)).toBe(true);
    expect(Array.isArray(doc.skills)).toBe(true);
    expect(Array.isArray(doc.projects)).toBe(true);
  });
});

describe("toJsonResume — basics", () => {
  const { basics } = toJsonResume(FULL_MODEL);

  it("maps scalar contact fields", () => {
    expect(basics.name).toBe("Jane Candidate");
    expect(basics.email).toBe("jane@example.com");
    expect(basics.phone).toBe("(312) 555-0123");
  });

  it("structures location by the last comma (lossless)", () => {
    expect(basics.location).toEqual({ city: "Chicago", region: "IL" });
  });

  it("maps profiles to {network,url,username} with a path-tail username", () => {
    expect(basics.profiles).toEqual([
      {
        network: "LinkedIn",
        url: "https://linkedin.com/in/jane",
        username: "jane",
      },
      { network: "GitHub", url: "https://github.com/JaneC", username: "JaneC" },
      { network: "jane.dev", url: "https://jane.dev" }, // no path ⇒ no username
    ]);
  });

  it("picks basics.url from portfolio/website (the 'other' personal site)", () => {
    expect(basics.url).toBe("https://jane.dev");
  });
});

describe("toJsonResume — work", () => {
  const { work } = toJsonResume(FULL_MODEL);

  it("maps company→name, title→position, normalizes dates", () => {
    expect(work[0]).toEqual({
      name: "Acme Corp",
      position: "Senior Engineer",
      startDate: "2020-01",
      endDate: "2022-03",
      highlights: ["Shipped X", "Led Y"],
    });
  });

  it("drops endDate for a current role and omits empty highlights", () => {
    expect(work[1].name).toBe("Startup Inc");
    expect(work[1].startDate).toBe("2022");
    expect(work[1].endDate).toBeUndefined();
    expect(work[1].highlights).toBeUndefined();
  });
});

describe("toJsonResume — education, skills, projects", () => {
  const doc = toJsonResume(FULL_MODEL);

  it("maps education institution/studyType/area/courses", () => {
    expect(doc.education[0]).toEqual({
      institution: "State University",
      studyType: "B.S.",
      area: "Computer Science",
      startDate: undefined,
      endDate: "2019",
      courses: ["Algorithms", "Databases"],
    });
  });

  it("maps each skill to { name }", () => {
    expect(doc.skills).toEqual([
      { name: "TypeScript" },
      { name: "React" },
      { name: "Node.js" },
    ]);
  });

  it("maps projects, keeping an unparseable date raw", () => {
    expect(doc.projects[0]).toEqual({
      name: "Cool Project",
      url: "https://github.com/JaneC/cool",
      startDate: "Summer 2021", // raw — never fabricated
      endDate: undefined,
      highlights: ["Built a thing"],
    });
  });
});

describe("toJsonResume — never fabricates data", () => {
  it("emits no work/education/skills for an empty model, basics minimal", () => {
    const doc = toJsonResume({
      contact: { name: "No One", links: [] },
      sections: [],
    });
    expect(doc.work).toEqual([]);
    expect(doc.education).toEqual([]);
    expect(doc.skills).toEqual([]);
    expect(doc.projects).toEqual([]);
    expect(doc.basics.name).toBe("No One");
    expect(doc.basics.profiles).toBeUndefined();
    expect(doc.basics.url).toBeUndefined();
    expect(doc.basics.location).toBeUndefined();
  });

  // #421 Secondary #12: achievements map to JSON Resume `awards[]` (title +
  // optional date), so the machine-readable copy no longer silently drops the
  // candidate's patents/publications/exits that the text layer still shows.
  it("maps achievement entries (with structured fields) to awards[]", () => {
    const doc = toJsonResume({
      contact: { name: "X", links: [] },
      sections: [
        {
          heading: "Achievements",
          kind: "achievements",
          entries: [
            {
              headerLine: "Patent US1234 · 2021",
              bullets: [],
              fields: { title: "Patent US1234", startDate: "2021" },
            },
          ],
        },
      ],
    });
    expect(doc.awards).toEqual([{ title: "Patent US1234", date: "2021" }]);
    // Still nothing in the ATS-core arrays.
    expect(doc.work).toEqual([]);
    expect(doc.projects).toEqual([]);
    expect(doc.education).toEqual([]);
  });

  it("omits awards entirely when there is no achievements section", () => {
    const doc = toJsonResume({ contact: { name: "X", links: [] }, sections: [] });
    expect(doc.awards).toBeUndefined();
    expect("awards" in doc).toBe(false);
  });
});

describe("normalizeJsonResumeDate", () => {
  it("passes ISO-ish dates through", () => {
    expect(normalizeJsonResumeDate("2020")).toBe("2020");
    expect(normalizeJsonResumeDate("2020-05")).toBe("2020-05");
    expect(normalizeJsonResumeDate("2020-05-01")).toBe("2020-05-01");
  });

  it("normalizes month-name and numeric forms to YYYY-MM", () => {
    expect(normalizeJsonResumeDate("January 2020")).toBe("2020-01");
    expect(normalizeJsonResumeDate("Jan 2020")).toBe("2020-01");
    expect(normalizeJsonResumeDate("Sept. 2019")).toBe("2019-09");
    expect(normalizeJsonResumeDate("05/2020")).toBe("2020-05");
    expect(normalizeJsonResumeDate("2020/5")).toBe("2020-05");
  });

  it("emits the raw string when unparseable (never fabricates)", () => {
    expect(normalizeJsonResumeDate("Summer 2022")).toBe("Summer 2022");
    expect(normalizeJsonResumeDate("Present")).toBe("Present");
    expect(normalizeJsonResumeDate("13/2020")).toBe("13/2020"); // invalid month
  });

  it("returns undefined for empty/absent", () => {
    expect(normalizeJsonResumeDate(undefined)).toBeUndefined();
    expect(normalizeJsonResumeDate("  ")).toBeUndefined();
  });
});

describe("toJsonResumeLocation", () => {
  it("splits US 'City, ST' into city + region (no country)", () => {
    expect(toJsonResumeLocation("San Francisco, CA")).toEqual({
      city: "San Francisco",
      region: "CA",
    });
  });

  it("splits US 'City, ST, USA' into city + region + countryCode (#429)", () => {
    expect(toJsonResumeLocation("San Francisco, CA, USA")).toEqual({
      city: "San Francisco",
      region: "CA",
      countryCode: "US",
    });
  });

  it("maps a 'City, Country' trailing country to countryCode (#429)", () => {
    expect(toJsonResumeLocation("London, UK")).toEqual({
      city: "London",
      countryCode: "GB",
    });
    expect(toJsonResumeLocation("Paris, France")).toEqual({
      city: "Paris",
      countryCode: "FR",
    });
  });

  it("splits 'City, Region, Country' with a non-US region (#429)", () => {
    expect(toJsonResumeLocation("Toronto, ON, Canada")).toEqual({
      city: "Toronto",
      region: "ON",
      countryCode: "CA",
    });
  });

  it("keeps a bare 2-letter US state as region, never a country (CA = California)", () => {
    // "CA" (California) must not resolve to Canada; a spelled-out country does.
    expect(toJsonResumeLocation("Sacramento, CA")).toEqual({
      city: "Sacramento",
      region: "CA",
    });
    // A full US state name is also kept as region, not the same-named country.
    expect(toJsonResumeLocation("Atlanta, Georgia")).toEqual({
      city: "Atlanta",
      region: "Georgia",
    });
  });

  it("keeps a comma-less string as the whole city", () => {
    expect(toJsonResumeLocation("Remote")).toEqual({ city: "Remote" });
  });

  it("is case- and space-insensitive on the country token", () => {
    expect(toJsonResumeLocation("berlin , germany")).toEqual({
      city: "berlin",
      countryCode: "DE",
    });
  });

  it("returns undefined for empty/absent", () => {
    expect(toJsonResumeLocation(undefined)).toBeUndefined();
    expect(toJsonResumeLocation("")).toBeUndefined();
  });
});

describe("formatJsonResumeLocation (round-trip)", () => {
  const cases = [
    "San Francisco, CA",
    "San Francisco, CA, USA",
    "London, UK",
    "Paris, France",
    "Toronto, ON, Canada",
    "Remote",
  ];
  it.each(cases)("round-trips %s losslessly", (loc) => {
    expect(formatJsonResumeLocation(toJsonResumeLocation(loc))).toBe(loc);
  });

  it("returns undefined for an absent location", () => {
    expect(formatJsonResumeLocation(undefined)).toBeUndefined();
  });

  it("falls back to the raw code for an unrecognized countryCode", () => {
    expect(
      formatJsonResumeLocation({ city: "Somewhere", countryCode: "ZZ" }),
    ).toBe("Somewhere, ZZ");
  });
});

// ── Fixture round-trip: parse → model → toJsonResume (shape only) ───────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/latex/awesome-cv-resume.pdf",
);

describe("toJsonResume — fixture round-trip (synthetic persona)", () => {
  it("produces a well-formed JSON Resume from a parsed fixture", async () => {
    const cascade = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const score = computeAnonymousAtsScore({
      parsed: { ...cascade.parsed },
      fieldConfidence: cascade.fieldConfidence,
      triggers: cascade.triggers,
      rawText: cascade.rawText,
      sections: cascade.sections,
    });
    const doc = toJsonResume(buildAtsResumeModel(cascade, score));

    expect(doc.$schema).toBe(JSON_RESUME_SCHEMA);
    expect(typeof doc.meta.version).toBe("string");
    expect(typeof doc.basics.name).toBe("string");
    expect(doc.basics.name!.length).toBeGreaterThan(0);

    // Work/education arrays are present; every entry carries at least one mapped
    // field (never an empty object) and any emitted date is a non-empty string.
    expect(doc.work.length).toBeGreaterThan(0);
    for (const w of doc.work) {
      expect(Boolean(w.name || w.position)).toBe(true);
      for (const d of [w.startDate, w.endDate])
        if (d !== undefined) expect(d.length).toBeGreaterThan(0);
    }
    for (const e of doc.education) {
      expect(Boolean(e.institution || e.studyType || e.area)).toBe(true);
    }
    // Skills entries are always { name: <non-empty> }.
    for (const s of doc.skills) expect(s.name.length).toBeGreaterThan(0);

    // The whole document serializes cleanly (this is exactly what the PDF embeds).
    expect(() => JSON.stringify(doc)).not.toThrow();
  });
});
