// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for critiqueResumeWithLlm (issue #244).
 *
 * All tests mock the WebLlmEngine so no real model download happens.
 * The mock controls `engine.chat.completions.create` to return deterministic
 * JSON strings, verifying the coercion + shape of the returned `ResumeCritique`.
 */

import { describe, it, expect, vi } from "vitest";
import {
  critiqueResumeWithLlm,
  type ResumeCritique,
} from "./critique-resume.ts";
import type { WebLlmEngine } from "./types.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A minimal parsed resume with two experience bullets and a summary. */
const PARSED_WITH_BULLETS: HeuristicParsedResume = {
  full_name: "Jane Smith",
  email: "jane@example.com",
  phone: undefined,
  location: undefined,
  summary: "Experienced engineer with a passion for distributed systems.",
  skills: ["Python", "Go", "Kubernetes"],
  experience: [
    {
      company: "Acme Corp",
      title: "Senior Engineer",
      description: "Led migration to Kubernetes\nHelped the team with deployments",
    },
    {
      company: "Beta Inc",
      title: "Engineer",
      description: "Worked on various features",
    },
  ],
  education: [
    { institution: "State University", degree: "B.S. Computer Science" },
  ],
};

/** A parsed resume with no bullets, no summary, and no skills. */
const PARSED_EMPTY: HeuristicParsedResume = {
  full_name: "John Doe",
  email: undefined,
  phone: undefined,
  location: undefined,
  summary: undefined,
  skills: [],
  experience: [],
  education: [],
};

// ── Mock engine builder ───────────────────────────────────────────────────────

/**
 * Build a mock WebLlmEngine that returns `responses` in call order.
 * Each call to `engine.chat.completions.create` pops the next response.
 * If responses run out, returns an empty content string.
 */
function makeMockEngine(responses: string[]): WebLlmEngine {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          const content = responses[callIndex] ?? "";
          callIndex++;
          return { choices: [{ message: { content } }] };
        }),
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("critiqueResumeWithLlm", () => {
  it("returns correct finding shape for each bullet", async () => {
    // Pass 1 response: one JSON object per line, covering the 3 bullets.
    const bulletResponse = [
      `{"bullet":"Led migration to Kubernetes","issue":"no_quantification","suggestion":"Led migration of 12 microservices to Kubernetes, reducing deploy time by 40%"}`,
      `{"bullet":"Helped the team with deployments","issue":"weak_verb","suggestion":"Streamlined team deployment pipeline using Helm"}`,
      `{"bullet":"Worked on various features","issue":"vague","suggestion":"Implemented user authentication feature reducing login latency by 200ms"}`,
    ].join("\n");

    // Pass 2 response: meta JSON.
    const metaResponse = `{"missingSections":[],"summaryFeedback":"Summary is clear but could mention key technologies."}`;

    const engine = makeMockEngine([bulletResponse, metaResponse]);
    const result: ResumeCritique = await critiqueResumeWithLlm(
      PARSED_WITH_BULLETS,
      engine,
    );

    // Bullet findings shape
    expect(result.bulletFindings).toHaveLength(3);

    const [f0, f1, f2] = result.bulletFindings;

    expect(f0!.issue).toBe("no_quantification");
    expect(f0!.bullet).toBe("Led migration to Kubernetes");
    expect(f0!.suggestion).toContain("microservices");

    expect(f1!.issue).toBe("weak_verb");
    expect(f1!.suggestion).toContain("Streamlined");

    expect(f2!.issue).toBe("vague");
    expect(f2!.suggestion).toBeDefined();

    // Missing sections
    expect(result.missingSections).toEqual([]);

    // Summary feedback
    expect(result.summaryFeedback).toContain("key technologies");
  });

  it("returns missing sections when the model flags them", async () => {
    // Empty resume — no bullets, so bullet pass is SKIPPED and only the meta
    // pass runs. The engine is only called once (meta only).
    const metaResponse = `{"missingSections":["summary","skills","experience"],"summaryFeedback":null}`;

    const engine = makeMockEngine([metaResponse]);
    const result = await critiqueResumeWithLlm(PARSED_EMPTY, engine);

    expect(result.bulletFindings).toHaveLength(0);
    expect(result.missingSections).toEqual(["summary", "skills", "experience"]);
    expect(result.summaryFeedback).toBeUndefined();
  });

  it("pads with 'ok' findings if model returns fewer lines than bullets", async () => {
    // Only one finding returned for 3 bullets.
    const bulletResponse = `{"bullet":"Led migration to Kubernetes","issue":"no_quantification","suggestion":"Add numbers"}`;
    const metaResponse = `{"missingSections":[]}`;

    const engine = makeMockEngine([bulletResponse, metaResponse]);
    const result = await critiqueResumeWithLlm(PARSED_WITH_BULLETS, engine);

    expect(result.bulletFindings).toHaveLength(3);
    // Second + third padded to "ok"
    expect(result.bulletFindings[1]!.issue).toBe("ok");
    expect(result.bulletFindings[2]!.issue).toBe("ok");
  });

  it("degrades gracefully when engine throws on the bullet pass", async () => {
    const engine: WebLlmEngine = {
      chat: {
        completions: {
          create: vi.fn()
            .mockRejectedValueOnce(new Error("OOM"))
            .mockResolvedValueOnce({ choices: [{ message: { content: `{"missingSections":[]}` } }] }),
        },
      },
    };

    const result = await critiqueResumeWithLlm(PARSED_WITH_BULLETS, engine);

    // All bullets padded to "ok" since engine threw on pass 1
    expect(result.bulletFindings).toHaveLength(3);
    for (const f of result.bulletFindings) {
      expect(f.issue).toBe("ok");
    }
    // Meta pass still ran
    expect(result.missingSections).toEqual([]);
  });

  it("degrades gracefully when engine throws on the meta pass", async () => {
    const bulletResponse = [
      `{"bullet":"Led migration to Kubernetes","issue":"ok"}`,
      `{"bullet":"Helped the team with deployments","issue":"weak_verb"}`,
      `{"bullet":"Worked on various features","issue":"vague"}`,
    ].join("\n");

    const engine: WebLlmEngine = {
      chat: {
        completions: {
          create: vi.fn()
            .mockResolvedValueOnce({ choices: [{ message: { content: bulletResponse } }] })
            .mockRejectedValueOnce(new Error("timeout")),
        },
      },
    };

    const result = await critiqueResumeWithLlm(PARSED_WITH_BULLETS, engine);

    // Bullet findings from pass 1
    expect(result.bulletFindings[0]!.issue).toBe("ok");
    expect(result.bulletFindings[1]!.issue).toBe("weak_verb");
    // Meta pass failed — safe empty defaults
    expect(result.missingSections).toEqual([]);
    expect(result.summaryFeedback).toBeUndefined();
  });

  it("handles unknown issue values by coercing to 'ok'", async () => {
    const bulletResponse = `{"bullet":"Led migration","issue":"unknown_thing","suggestion":"hmm"}`;
    const metaResponse = `{"missingSections":[]}`;

    const engine = makeMockEngine([bulletResponse, metaResponse]);
    const result = await critiqueResumeWithLlm(PARSED_WITH_BULLETS, engine);

    expect(result.bulletFindings[0]!.issue).toBe("ok");
    // Other 2 bullets padded to ok
    expect(result.bulletFindings[1]!.issue).toBe("ok");
  });

  it("downgrades a no_quantification finding the scorer counts as metric-bearing (#1094)", async () => {
    const parsed: HeuristicParsedResume = {
      ...PARSED_EMPTY,
      experience: [
        {
          company: "Acme Corp",
          title: "Engineer",
          description: "Reduced p99 latency by 87% through caching",
        },
      ],
    };
    const bulletResponse = `{"bullet":"Reduced p99 latency by 87% through caching","issue":"no_quantification","suggestion":"Reduced p99 latency by 87% through caching."}`;
    const metaResponse = `{"missingSections":[]}`;

    const engine = makeMockEngine([bulletResponse, metaResponse]);
    const result = await critiqueResumeWithLlm(parsed, engine);

    expect(result.bulletFindings).toHaveLength(1);
    expect(result.bulletFindings[0]!.issue).toBe("ok");
    expect(result.bulletFindings[0]!.suggestion).toBeUndefined();
    expect(result.metricOverrides).toBe(1);
  });

  it("strips a numbered-list marker from the source bullet before the metric check (#1094)", async () => {
    const parsed: HeuristicParsedResume = {
      ...PARSED_EMPTY,
      experience: [
        {
          company: "Acme Corp",
          title: "Engineer",
          description: "1. Assisted with team scheduling",
        },
      ],
    };
    const bulletResponse = `{"bullet":"Assisted with team scheduling","issue":"no_quantification","suggestion":"Coordinated scheduling for a team of 5"}`;
    const metaResponse = `{"missingSections":[]}`;

    const engine = makeMockEngine([bulletResponse, metaResponse]);
    const result = await critiqueResumeWithLlm(parsed, engine);

    // "1." must not survive as the source bullet's leading digit, or
    // bulletHasMetric would treat it as a metric and mask this finding.
    expect(result.bulletFindings[0]!.bullet).toBe(
      "Assisted with team scheduling",
    );
    expect(result.bulletFindings[0]!.issue).toBe("no_quantification");
    expect(result.metricOverrides).toBe(0);
  });

  it("reconciles against the source bullet, not the model's echoed bullet field (#1094)", async () => {
    const parsed: HeuristicParsedResume = {
      ...PARSED_EMPTY,
      experience: [
        {
          company: "Acme Corp",
          title: "Engineer",
          description: "Improved onboarding",
        },
      ],
    };
    // Model copies the prompt's "1. " numbering into its own `bullet` field.
    const bulletResponse = `{"bullet":"1. Improved onboarding","issue":"no_quantification","suggestion":"Improved onboarding is now measured"}`;
    const metaResponse = `{"missingSections":[]}`;

    const engine = makeMockEngine([bulletResponse, metaResponse]);
    const result = await critiqueResumeWithLlm(parsed, engine);

    // The finding's bullet text is the true source, not the model's echo,
    // and the "no_quantification" verdict survives (no false metric).
    expect(result.bulletFindings[0]!.bullet).toBe("Improved onboarding");
    expect(result.bulletFindings[0]!.issue).toBe("no_quantification");
    expect(result.metricOverrides).toBe(0);
  });

  it("drops a suggestion that is just the bullet plus a trailing period", async () => {
    const parsed: HeuristicParsedResume = {
      ...PARSED_EMPTY,
      experience: [
        {
          company: "Acme Corp",
          title: "Engineer",
          description: "Helped the team with various tasks",
        },
      ],
    };
    const bulletResponse = `{"bullet":"Helped the team with various tasks","issue":"weak_verb","suggestion":"Helped the team with various tasks."}`;
    const metaResponse = `{"missingSections":[]}`;

    const engine = makeMockEngine([bulletResponse, metaResponse]);
    const result = await critiqueResumeWithLlm(parsed, engine);

    expect(result.bulletFindings[0]!.issue).toBe("weak_verb");
    expect(result.bulletFindings[0]!.suggestion).toBeUndefined();
    expect(result.metricOverrides).toBe(0);
  });

  it("returns empty bulletFindings when there are no bullets", async () => {
    const metaResponse = `{"missingSections":["summary","skills"],"summaryFeedback":null}`;
    // Only one call expected (meta pass); bullet pass skipped entirely.
    const engine = makeMockEngine([metaResponse]);
    const result = await critiqueResumeWithLlm(PARSED_EMPTY, engine);

    expect(result.bulletFindings).toHaveLength(0);
    expect(result.missingSections).toContain("summary");
  });
});
