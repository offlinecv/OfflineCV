// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The plan card's whole value is that it cannot lie about what leaves the
 * browser, so these assert the two properties that would make it lie: the rows
 * read through `searchPhrase` / `primaryKeyword` (including their FALLBACKS, the
 * cases a hand-written "titles[0] / skills[0]" copy would get wrong), and a
 * query with nothing to send renders a reason rather than an empty term.
 */

import { describe, it, expect } from "vitest";
import { canonicalSkillLabels, type JobQuery } from "./query-builder.ts";
import { primaryKeyword, searchPhrase } from "./providers/keywords.ts";
import {
  buildSearchPlan,
  COMPANY_DETAIL,
  COMPANY_DETAIL_NONE,
  NO_TERM_DETAIL,
  promoteSkill,
  promoteTitle,
  SEARCH_PLAN_COPY,
  type SearchPlan,
} from "./search-plan.ts";

function row(plan: SearchPlan, id: "feeds" | "topic" | "companies") {
  const found = plan.rows.find((r) => r.id === id);
  if (!found) throw new Error(`no ${id} row`);
  return found;
}

describe("buildSearchPlan — the outbound rows", () => {
  it("shows the primary title on the feeds row and the primary skill on the topic row", () => {
    const query: JobQuery = {
      titles: ["Founder & CEO", "VP Engineering"],
      skills: ["cross-functional collaboration", "TypeScript"],
    };
    const plan = buildSearchPlan(query, 14);

    expect(row(plan, "feeds").term).toBe("Founder & CEO");
    expect(row(plan, "feeds").source).toBe("title");
    expect(row(plan, "topic").term).toBe("cross-functional collaboration");
    expect(row(plan, "topic").source).toBe("skill");
  });

  it("reads index 0, not any other title — a reorder moves the feeds term", () => {
    const query: JobQuery = {
      titles: ["Founder & CEO", "VP Engineering"],
      skills: [],
    };
    expect(row(buildSearchPlan(query, 0), "feeds").term).toBe("Founder & CEO");
    const promoted = promoteTitle(query, "VP Engineering");
    expect(row(buildSearchPlan(promoted, 0), "feeds").term).toBe("VP Engineering");
  });

  it("matches the egress helpers verbatim, fallbacks included", () => {
    const cases: JobQuery[] = [
      { titles: ["Staff Engineer"], skills: ["Kubernetes"] },
      { titles: [], skills: ["React", "Node.js", "TypeScript", "GraphQL"] },
      { titles: ["Staff Engineer"], skills: [] },
    ];
    for (const query of cases) {
      const plan = buildSearchPlan(query, 3);
      expect(row(plan, "feeds").term).toBe(searchPhrase(query));
      expect(row(plan, "topic").term).toBe(primaryKeyword(query));
    }
  });

  it("attributes a title-less query's feeds term to the skills it fell back to", () => {
    const query: JobQuery = { titles: [], skills: ["React", "Node.js", "TypeScript", "Go"] };
    const feeds = row(buildSearchPlan(query, 0), "feeds");
    // `searchPhrase` joins the top three skills when there is no title.
    expect(feeds.term).toBe("React Node.js TypeScript");
    expect(feeds.source).toBe("skill");
  });

  it("attributes a skill-less query's topic term to the title it fell back to", () => {
    const query: JobQuery = { titles: ["Staff Engineer"], skills: [] };
    const topic = row(buildSearchPlan(query, 0), "topic");
    expect(topic.term).toBe("Staff Engineer");
    expect(topic.source).toBe("title");
  });

  it("renders a reason, never an empty term, for a degenerate query", () => {
    const plan = buildSearchPlan({ titles: [], skills: [] }, 0);
    for (const id of ["feeds", "topic"] as const) {
      expect(row(plan, id).term).toBeUndefined();
      expect(row(plan, id).source).toBeUndefined();
      expect(row(plan, id).detail).toBe(NO_TERM_DETAIL);
    }
  });
});

describe("buildSearchPlan — the company row", () => {
  it("says only the company name is sent, and counts the boards", () => {
    expect(row(buildSearchPlan({ titles: ["X"], skills: [] }, 14), "companies")).toMatchObject({
      label: "14 company boards",
      detail: COMPANY_DETAIL,
    });
    expect(row(buildSearchPlan({ titles: ["X"], skills: [] }, 1), "companies").label).toBe(
      "1 company board",
    );
  });

  it("says none are selected at zero rather than printing '0 company boards'", () => {
    const companies = row(buildSearchPlan({ titles: ["X"], skills: [] }, 0), "companies");
    expect(companies.detail).toBe(COMPANY_DETAIL_NONE);
    expect(companies.label).not.toMatch(/^0 /);
  });
});

describe("promote reducers", () => {
  it("promoteTitle is a whole-query replacement that keeps derived siblings", () => {
    const query: JobQuery = {
      titles: ["Berlin Site Lead", "VP Engineering"],
      skills: [],
      titleNoise: ["berlin"],
    };
    const next = promoteTitle(query, "VP Engineering");
    expect(next).not.toBe(query);
    expect(next.titles).toEqual(["VP Engineering", "Berlin Site Lead"]);
    expect(next.titleNoise).toEqual(["berlin"]);
  });

  it("promoteSkill recomputes canonicalSkills so a moved chip keeps its standing", () => {
    const query: JobQuery = {
      titles: [],
      skills: ["Team Building & Mentorship", "TypeScript"],
      canonicalSkills: ["TypeScript"],
    };
    const next = promoteSkill(query, "TypeScript");
    expect(next.skills).toEqual(["TypeScript", "Team Building & Mentorship"]);
    // Recomputed from the whole reordered list through the same helper
    // `buildJobQuery` uses — the free-text phrase is still not canonical.
    expect(next.canonicalSkills).toEqual(canonicalSkillLabels(next.skills));
    expect(next.canonicalSkills).toEqual(["TypeScript"]);
  });

  it("returns the SAME object for a no-op promotion", () => {
    const query: JobQuery = { titles: ["A", "B"], skills: ["S"] };
    expect(promoteTitle(query, "A")).toBe(query);
    expect(promoteTitle(query, "missing")).toBe(query);
    expect(promoteSkill(query, "S")).toBe(query);
    expect(promoteSkill(query, "missing")).toBe(query);
  });
});

describe("search-plan copy", () => {
  // The same denylist `term-quality.test.ts` applies to `REASONS`, plus the
  // internal nouns #597 named. A user must never have to know what a token, a
  // provider or a query profile is to read this card.
  it("carries no mechanism vocabulary", () => {
    for (const text of SEARCH_PLAN_COPY) {
      expect(text).not.toMatch(/tokenizer|filter|regex|gate|profile|resolver|admission|#/i);
      expect(text).not.toMatch(/\btokens?\b|\bproviders?\b|\begress\b/i);
    }
  });

  it("states what leaves and when, exactly once", () => {
    const plan = buildSearchPlan({ titles: ["Staff Engineer"], skills: [] }, 2);
    expect(plan.privacyNote).toMatch(/only when you click Search/i);
    expect(plan.localNote).toMatch(/on your device/i);
  });
});
