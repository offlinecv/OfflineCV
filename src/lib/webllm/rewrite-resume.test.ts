// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  startedMock,
  sectionCompletedMock,
  completedMock,
  firstResumeMock,
} = vi.hoisted(() => ({
  startedMock: vi.fn(),
  sectionCompletedMock: vi.fn(),
  completedMock: vi.fn(),
  firstResumeMock: vi.fn(),
}));
vi.mock("../analytics.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../analytics.ts")>();
  return {
    ...actual,
    trackWebllmResumeRewriteStarted: startedMock,
    trackWebllmResumeRewriteSectionCompleted: sectionCompletedMock,
    trackWebllmResumeRewriteCompleted: completedMock,
    trackWebllmFirstResumeRewrite: firstResumeMock,
  };
});

import {
  _resetResumeRewriteFlagsForTesting,
  buildResumeContext,
  rewriteResumeWithLlm,
  type ResumeRewriteProgress,
  type SectionInput,
  type SectionOutcome,
} from "./rewrite-resume.ts";
import { _resetSectionRewriteFlagsForTesting } from "./rewrite-section.ts";
import { findingsKey, type RewriteSteering } from "./steering.ts";
import { findingsFromCritique } from "./rewrite-findings.ts";
import type { ResumeCritique } from "./critique-resume.ts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  WebLlmEngine,
} from "./types.ts";

const TEST_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const OTHER_MODEL = "gemma-2-2b-it-q4f16_1-MLC";

function makeEngine(
  reply: (req: ChatCompletionRequest) => Promise<ChatCompletionResponse>,
): {
  engine: WebLlmEngine;
  calls: ChatCompletionRequest[];
} {
  const calls: ChatCompletionRequest[] = [];
  const spy = vi.fn(async (req: ChatCompletionRequest) => {
    calls.push(req);
    return reply(req);
  });
  const engine: WebLlmEngine = { chat: { completions: { create: spy } } };
  return { engine, calls };
}

function reply(content: string | null): ChatCompletionResponse {
  return { choices: [{ message: { content } }] };
}

const summarySection = (
  text: string,
): Extract<SectionInput, { kind: "summary" }> => ({
  kind: "summary",
  id: "summary",
  label: "Summary",
  text,
});

const experienceSection = (
  id: string,
  label: string,
  bullets: string[],
): Extract<SectionInput, { kind: "experience" }> => ({
  kind: "experience",
  id,
  label,
  bullets,
});

describe("buildResumeContext", () => {
  it("returns undefined when nothing has completed yet and no verbs/phrases accumulated", () => {
    expect(buildResumeContext([], new Set(), new Set())).toBeUndefined();
  });

  it("returns a verb brief once verbs have accumulated", () => {
    const usedVerbs = new Set<string>(["built", "led"]);
    const out = buildResumeContext([], usedVerbs, new Set());
    expect(out).toContain("Verbs already used in prior bullets");
    expect(out).toContain("built");
    expect(out).toContain("led");
  });

  it("returns a phrase brief once strong phrases have accumulated", () => {
    const usedPhrases = new Set<string>(["distributed systems"]);
    const out = buildResumeContext([], new Set(), usedPhrases);
    expect(out).toContain("Phrases already used in prior bullets");
    expect(out).toContain("distributed systems");
  });

  it("includes a prior-section preview when at least one section has completed", () => {
    const completed: SectionOutcome[] = [
      {
        kind: "experience",
        input: experienceSection("experience:0", "Engineer", ["x"]),
        data: {
          bullets: ["Shipped Foo to 10M users."],
          numbersPreserved: true,
          reverted: false,
          droppedNumbers: [],
          addedNumbers: [],
        },
      },
    ];
    const out = buildResumeContext(completed, new Set(["shipped"]), new Set());
    expect(out).toContain("Earlier section's first bullet was:");
    expect(out).toContain("Shipped Foo to 10M users.");
  });

  it("truncates long preview lines with an ellipsis", () => {
    const long = "Shipped " + "a".repeat(200);
    const completed: SectionOutcome[] = [
      {
        kind: "experience",
        input: experienceSection("experience:0", "Engineer", ["x"]),
        data: {
          bullets: [long],
          numbersPreserved: true,
          reverted: false,
          droppedNumbers: [],
          addedNumbers: [],
        },
      },
    ];
    const out = buildResumeContext(completed, new Set(), new Set());
    expect(out).toMatch(/…/);
  });
});

describe("rewriteResumeWithLlm", () => {
  beforeEach(() => {
    _resetResumeRewriteFlagsForTesting();
    _resetSectionRewriteFlagsForTesting();
    startedMock.mockClear();
    sectionCompletedMock.mockClear();
    completedMock.mockClear();
    firstResumeMock.mockClear();
  });

  it("processes summary first, then each experience role in order", async () => {
    const { engine, calls } = makeEngine(async () => reply("Built X."));
    const sections: SectionInput[] = [
      summarySection("Engineer with 10 years."),
      experienceSection("experience:0", "Acme", ["worked on X"]),
      experienceSection("experience:1", "Foo", ["managed Y"]),
    ];
    const result = await rewriteResumeWithLlm(
      sections,
      engine,
      TEST_MODEL,
      () => {},
    );
    expect(calls).toHaveLength(3);
    expect(result.sections).toHaveLength(3);
    expect(result.sections[0]!.kind).toBe("summary");
    expect(result.sections[1]!.kind).toBe("experience");
    expect(result.sections[2]!.kind).toBe("experience");
    expect(result.sections[1]!.input.id).toBe("experience:0");
    expect(result.sections[2]!.input.id).toBe("experience:1");
  });

  it("skips empty sections defensively (no model call for an empty bullet array)", async () => {
    const { engine, calls } = makeEngine(async () => reply("Built X."));
    const sections: SectionInput[] = [
      summarySection(""),
      experienceSection("experience:0", "Acme", []),
      experienceSection("experience:1", "Foo", ["managed Y"]),
    ];
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {});
    expect(calls).toHaveLength(1);
  });

  it("fires onProgress before each step AND once with currentIndex === totalSections at the end", async () => {
    const { engine } = makeEngine(async () => reply("Built X."));
    const sections: SectionInput[] = [
      summarySection("Engineer."),
      experienceSection("experience:0", "Acme", ["a"]),
    ];
    const progress: ResumeRewriteProgress[] = [];
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, (p) => {
      progress.push({ ...p, completed: [...p.completed] });
    });
    // 2 sections → 3 progress events: index 0 pre-step, index 1 pre-step, index 2 final.
    expect(progress).toHaveLength(3);
    expect(progress[0]!.currentIndex).toBe(0);
    expect(progress[0]!.completed).toHaveLength(0);
    expect(progress[1]!.currentIndex).toBe(1);
    expect(progress[1]!.completed).toHaveLength(1);
    expect(progress[2]!.currentIndex).toBe(2);
    expect(progress[2]!.completed).toHaveLength(2);
  });

  it("threads the in-flight section's label through onProgress so the UI can name the current step", async () => {
    const { engine } = makeEngine(async () => reply("Built X."));
    const sections: SectionInput[] = [
      summarySection("Engineer."),
      experienceSection("experience:0", "Acme", ["a"]),
    ];
    const progress: ResumeRewriteProgress[] = [];
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, (p) => {
      progress.push({ ...p });
    });
    expect(progress[0]!.currentLabel).toBe("Summary");
    expect(progress[1]!.currentLabel).toBe("Acme");
    // Final completion event has no in-flight section — null is the explicit
    // sentinel the UI watches for to swap into the "Finishing…" fallback.
    expect(progress[2]!.currentLabel).toBeNull();
  });

  it("threads accumulated context into calls 2+ via the SYSTEM message (verb constraint visible)", async () => {
    const { engine, calls } = makeEngine(async () => reply("Built a thing."));
    const sections: SectionInput[] = [
      experienceSection("experience:0", "Acme", ["a"]),
      experienceSection("experience:1", "Foo", ["b"]),
    ];
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {});
    // First call: no context — neither the system NOR user message carries
    // the verb-brief sentence.
    expect(calls[0]!.messages[0]?.content).not.toContain(
      "Verbs already used in prior bullets",
    );
    expect(calls[0]!.messages[1]?.content).not.toContain(
      "Verbs already used in prior bullets",
    );
    // Second call: context built from call 1's output ("Built a thing.") MUST
    // land in the SYSTEM message (and never leak into the user message —
    // that was the bug the system-placement fix closes).
    expect(calls[1]!.messages[0]?.content).toContain(
      "Verbs already used in prior bullets",
    );
    expect(calls[1]!.messages[0]?.content).toContain("built");
    expect(calls[1]!.messages[1]?.content).not.toContain(
      "Verbs already used in prior bullets",
    );
  });

  it("reverts the one section that dropped a metric, leaving the others rewritten (#778)", async () => {
    const { engine } = makeEngine(async (req: ChatCompletionRequest) => {
      // Drop a metric on the second call only.
      const ord = req.messages[1]!.content;
      if (ord.includes("$5K")) return reply("Drove revenue.");
      return reply("Drove $1.2M ARR.");
    });
    const sections: SectionInput[] = [
      experienceSection("experience:0", "Acme", ["Drove $1.2M in ARR"]),
      experienceSection("experience:1", "Foo", ["Saved $5K per quarter"]),
    ];
    const result = await rewriteResumeWithLlm(
      sections,
      engine,
      TEST_MODEL,
      () => {},
    );
    const [first, second] = result.sections;
    expect(first!.kind === "experience" && first!.data.reverted).toBe(false);
    expect(first!.kind === "experience" && first!.data.bullets).toEqual([
      "Drove $1.2M ARR.",
    ]);
    // The dropping section keeps the user's own bullet — one bad section does
    // not cost them the rest of the run.
    expect(second!.kind === "experience" && second!.data.reverted).toBe(true);
    expect(second!.kind === "experience" && second!.data.bullets).toEqual([
      "Saved $5K per quarter",
    ]);
    // Every number reached the user, so the aggregate is true — which is why
    // the UI reads `reverted` and not this flag alone.
    expect(result.allNumbersPreserved).toBe(true);
  });

  it("reverts a section that invents a metric, and still reports the token", async () => {
    // Invention is gated too since the #778 widening, so the aggregate reads
    // true (the original invents nothing) and `reverted` is what carries the
    // story — the same pairing the drop case already had.
    const { engine } = makeEngine(async () =>
      reply("Drove revenue with 99.9% availability."),
    );
    const sections: SectionInput[] = [
      experienceSection("experience:0", "Acme", ["Drove revenue"]),
    ];
    const result = await rewriteResumeWithLlm(
      sections,
      engine,
      TEST_MODEL,
      () => {},
    );
    expect(result.sections[0]!.data.reverted).toBe(true);
    const section = result.sections[0]!;
    expect(section.kind === "experience" && section.data.bullets).toEqual([
      "Drove revenue",
    ]);
    expect(result.sections[0]!.data.addedNumbers).toEqual(["99.9%"]);
    expect(result.allNumbersPreserved).toBe(true);
  });

  it("fires webllm_resume_rewrite_started and _completed exactly once per run", async () => {
    const { engine } = makeEngine(async () => reply("Built X."));
    const sections: SectionInput[] = [
      experienceSection("experience:0", "Acme", ["a"]),
    ];
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {});
    expect(startedMock).toHaveBeenCalledTimes(1);
    expect(startedMock).toHaveBeenCalledWith({
      model: TEST_MODEL,
      sectionCount: 1,
    });
    expect(completedMock).toHaveBeenCalledTimes(1);
    expect(completedMock).toHaveBeenCalledWith({
      model: TEST_MODEL,
      sectionCount: 1,
      allNumbersPreserved: true,
      anyReverted: false,
    });
  });

  it("fires webllm_resume_rewrite_section_completed per section with its kind", async () => {
    const { engine } = makeEngine(async () => reply("Built X."));
    const sections: SectionInput[] = [
      summarySection("Engineer."),
      experienceSection("experience:0", "Acme", ["a"]),
    ];
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {});
    expect(sectionCompletedMock).toHaveBeenCalledTimes(2);
    expect(sectionCompletedMock).toHaveBeenNthCalledWith(1, {
      model: TEST_MODEL,
      sectionIndex: 0,
      sectionKind: "summary",
      inputUnitCount: 1,
      outputUnitCount: 1,
      numbersPreserved: true,
      reverted: false,
    });
    expect(sectionCompletedMock).toHaveBeenNthCalledWith(2, {
      model: TEST_MODEL,
      sectionIndex: 1,
      sectionKind: "experience",
      inputUnitCount: 1,
      outputUnitCount: 1,
      numbersPreserved: true,
      reverted: false,
    });
  });

  it("reports the MODEL's number preservation, not the delivered outcome, on a revert", async () => {
    // The delivered bullets are the user's own after a revert, so
    // `data.numbersPreserved` is true by construction. Passing that through
    // would flip what `numbers_preserved` measures mid-release; the series has
    // to keep describing the model. `reverted` is the new dimension that says
    // the gate fired. Mirrors `rewrite-section.ts`.
    const { engine } = makeEngine(async () => reply("Drove revenue."));
    const sections: SectionInput[] = [
      experienceSection("experience:0", "Acme", ["Drove $1.2M in ARR"]),
    ];
    const result = await rewriteResumeWithLlm(
      sections,
      engine,
      TEST_MODEL,
      () => {},
    );
    expect(result.sections[0]!.data.reverted).toBe(true);
    expect(sectionCompletedMock).toHaveBeenCalledWith(
      expect.objectContaining({ numbersPreserved: false, reverted: true }),
    );
    expect(completedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allNumbersPreserved: false,
        anyReverted: true,
      }),
    );
    // The value the UI reads is unchanged — it is a property of what shipped.
    expect(result.allNumbersPreserved).toBe(true);
  });

  it("fires webllm_first_resume_rewrite exactly once per model", async () => {
    const { engine } = makeEngine(async () => reply("Built X."));
    const sections: SectionInput[] = [
      experienceSection("experience:0", "Acme", ["a"]),
    ];
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {});
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {});
    expect(firstResumeMock).toHaveBeenCalledTimes(1);
    expect(firstResumeMock).toHaveBeenCalledWith({ model: TEST_MODEL });
  });

  it("fires webllm_first_resume_rewrite once per model — a different model id re-arms", async () => {
    const { engine } = makeEngine(async () => reply("Built X."));
    const sections: SectionInput[] = [
      experienceSection("experience:0", "Acme", ["a"]),
    ];
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {});
    await rewriteResumeWithLlm(sections, engine, OTHER_MODEL, () => {});
    expect(firstResumeMock).toHaveBeenCalledTimes(2);
    expect(firstResumeMock).toHaveBeenNthCalledWith(1, { model: TEST_MODEL });
    expect(firstResumeMock).toHaveBeenNthCalledWith(2, { model: OTHER_MODEL });
  });

  it("does NOT fire webllm_first_resume_rewrite when every section returned empty", async () => {
    const { engine } = makeEngine(async () => reply(null));
    const sections: SectionInput[] = [
      experienceSection("experience:0", "Acme", ["a"]),
    ];
    await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {});
    expect(firstResumeMock).not.toHaveBeenCalled();
  });

  it("propagates engine errors to the caller without firing _completed", async () => {
    const boom = new Error("OOM");
    const { engine } = makeEngine(async () => {
      throw boom;
    });
    const sections: SectionInput[] = [
      experienceSection("experience:0", "Acme", ["a"]),
    ];
    await expect(
      rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {}),
    ).rejects.toBe(boom);
    expect(completedMock).not.toHaveBeenCalled();
  });
});

// ── The app's own findings reach the prompt, scoped per section (#608) ────────
//
// Phase 0 of #608: the reproduction runs entirely on synthetic literals — no
// PDF, no persona, no personal résumé. `SectionInput[]` plus a hand-built
// findings map is the whole input, and the assertion is on the prompt string
// `runOne` produces, which is a pure function of them.

describe("app findings reach the rewrite prompt (#608)", () => {
  /** Two roles plus a summary, each with one FLAGGED and one clean bullet. */
  const multiSection = (): SectionInput[] => [
    summarySection("Engineer with a decade of backend work."),
    experienceSection("exp-0", "Staff Engineer — Globex", [
      "Worked on the payments API",
      "Cut deploy time from 42 minutes to 9 minutes",
    ]),
    experienceSection("exp-1", "Senior Engineer — Initech", [
      "Helped with the ingest pipeline",
      "Mentored four engineers on the on-call rotation",
    ]),
  ];

  const findings = new Map<string, readonly string[]>([
    [findingsKey("Worked on the payments API"), ["ROLE-ZERO-NOTE"]],
    [findingsKey("Helped with the ingest pipeline"), ["ROLE-ONE-NOTE"]],
    [
      findingsKey("Engineer with a decade of backend work."),
      ["SUMMARY-NOTE"],
    ],
  ]);

  async function run(steering?: RewriteSteering) {
    const { engine, calls } = makeEngine(async () => reply("Rewritten line"));
    await rewriteResumeWithLlm(
      multiSection(),
      engine,
      TEST_MODEL,
      () => {},
      steering,
    );
    // calls[0] = summary, calls[1] = exp-0, calls[2] = exp-1.
    return calls.map((c) => String(c.messages[0]?.content ?? ""));
  }

  it("puts each section's OWN findings in that section's system prompt", async () => {
    const [summaryPrompt, roleZero, roleOne] = await run({ findings });
    expect(summaryPrompt).toContain("SUMMARY-NOTE");
    expect(roleZero).toContain("ROLE-ZERO-NOTE");
    expect(roleOne).toContain("ROLE-ONE-NOTE");
  });

  it("does NOT leak one section's findings into another's prompt", async () => {
    // The assertion the whole design turns on. Dumping every finding into
    // every prompt would satisfy the presence test above and still be the
    // prompt-balloon failure mode `PRIOR_PREVIEW_CHAR_CAP` warns about.
    const [summaryPrompt, roleZero, roleOne] = await run({ findings });

    expect(roleZero).not.toContain("ROLE-ONE-NOTE");
    expect(roleZero).not.toContain("SUMMARY-NOTE");

    expect(roleOne).not.toContain("ROLE-ZERO-NOTE");
    expect(roleOne).not.toContain("SUMMARY-NOTE");

    expect(summaryPrompt).not.toContain("ROLE-ZERO-NOTE");
    expect(summaryPrompt).not.toContain("ROLE-ONE-NOTE");
  });

  it("numbers a note to match the bullet's position in the user message", async () => {
    const { engine, calls } = makeEngine(async () => reply("Rewritten line"));
    await rewriteResumeWithLlm(
      [
        experienceSection("exp-0", "Staff Engineer", [
          "Cut deploy time from 42 minutes to 9 minutes",
          "Worked on the payments API",
        ]),
      ],
      engine,
      TEST_MODEL,
      () => {},
      { findings },
    );
    const system = String(calls[0]!.messages[0]?.content ?? "");
    const user = String(calls[0]!.messages[1]?.content ?? "");
    // The flagged bullet is second in the input, so it is `2.` in the user
    // message and must be "Bullet 2" in the note — an off-by-one here would
    // aim every note at the wrong line.
    expect(user).toContain("2. Worked on the payments API");
    expect(system).toContain("- Bullet 2: ROLE-ZERO-NOTE");
  });

  it("leaves the prompt BYTE-IDENTICAL when findings are absent", async () => {
    // Not "behaves the same" — the same string. This is the contract that lets
    // a user who never ran a critique be unaffected by #608 entirely.
    const withFindings = await run({ userInstructions: "target staff" });
    const without = await run({ userInstructions: "target staff" });
    expect(withFindings).toEqual(without);

    const baseline = await run(undefined);
    const withEmptyMap = await run({ findings: new Map() });
    expect(withEmptyMap).toEqual(baseline);
  });

  it("keeps every guardrail, and keeps it BEFORE the findings block", async () => {
    const [summaryPrompt, roleZero] = await run({ findings });

    // The number-preservation + no-fabrication rules are what the suffix
    // design exists to protect (steering.ts docblock): user- and app-supplied
    // text is appended AFTER them so a small model cannot drop one.
    const guardrail = "Preserve every concrete number from the input EXACTLY";
    expect(roleZero).toContain(guardrail);
    expect(roleZero).toContain("Do not invent new numbers or metrics.");
    expect(roleZero.indexOf(guardrail)).toBeLessThan(
      roleZero.indexOf("ROLE-ZERO-NOTE"),
    );

    // The summary prompt carries its own guardrail wording.
    expect(summaryPrompt).toContain("Do not invent");
    expect(summaryPrompt.indexOf("Do not invent")).toBeLessThan(
      summaryPrompt.indexOf("SUMMARY-NOTE"),
    );
  });

  it("still catches a fabricated number when a finding names one", async () => {
    // A finding is allowed to mention a number (a critique suggestion routinely
    // does). If the model copies it into the résumé, the gate must still see
    // and reject the invention — a finding must not become a fabrication
    // vector that the deterministic checker stops seeing.
    const numeric = new Map<string, readonly string[]>([
      [
        findingsKey("Worked on the payments API"),
        ["add a concrete metric or outcome (suggested: cut latency 40%)"],
      ],
    ]);
    const { engine } = makeEngine(async () =>
      // The model took the bait and copied the suggested figure.
      reply("Cut payments API latency 40%"),
    );
    const result = await rewriteResumeWithLlm(
      [experienceSection("exp-0", "Staff Engineer", ["Worked on the payments API"])],
      engine,
      TEST_MODEL,
      () => {},
      { findings: numeric },
    );
    expect(result.sections[0]!.data.reverted).toBe(true);
    // `checkNumbersPreserved` tokenizes the percent with its unit, so the
    // invented token is "40%" — the point is that it is reported as ADDED.
    expect(result.sections[0]!.data.addedNumbers).toContain("40%");
    // And the fabrication never reaches the résumé.
    const section = result.sections[0]!;
    expect(section.kind === "experience" && section.data.bullets).toEqual([
      "Worked on the payments API",
    ]);
  });
});

// ── The full seam: a real ResumeCritique through to the prompt (#608) ─────────
//
// The tests above build the findings Map by hand, which verifies SCOPING but
// not that `findingsFromCritique` produces a map those lookups can find. The
// mapper has its own unit tests, which verify the map but not the scoping.
// Neither notices if the two stop composing — a change to `findingsKey` on one
// side, or to how the critique echoes a bullet back, would leave both suites
// green and every finding silently missing from every prompt. This drives the
// real adapter end to end, as the #608 AC words it ("with a `ResumeCritique` in
// hand").

describe("a real ResumeCritique reaches the prompt end-to-end (#608)", () => {
  const SUMMARY = "Engineer with a decade of backend work.";
  const FLAGGED = "Worked on the payments API";
  const CLEAN = "Cut deploy time from 42 minutes to 9 minutes";

  const critique: ResumeCritique = {
    // The critique echoes bullets back through the model, which routinely
    // re-adds a marker and re-wraps whitespace — so the fixture states them
    // that way rather than byte-identical to the résumé's copy.
    bulletFindings: [
      {
        bullet: "•  Worked   on the payments API",
        issue: "no_quantification",
        suggestion: "name the throughput",
      },
      { bullet: CLEAN, issue: "ok" },
      { bullet: "Helped with the ingest pipeline", issue: "vague" },
    ],
    missingSections: [],
    summaryFeedback: "Too generic — name a specialism.",
  };

  it("joins the critique's own wording to the résumé's copy of the line", async () => {
    const { engine, calls } = makeEngine(async () => reply("Rewritten line"));
    await rewriteResumeWithLlm(
      [
        summarySection(SUMMARY),
        experienceSection("exp-0", "Staff Engineer", [FLAGGED, CLEAN]),
        experienceSection("exp-1", "Senior Engineer", [
          "Helped with the ingest pipeline",
        ]),
      ],
      engine,
      TEST_MODEL,
      () => {},
      { findings: findingsFromCritique(critique, SUMMARY) },
    );
    const [summaryPrompt, roleZero, roleOne] = calls.map((c) =>
      String(c.messages[0]?.content ?? ""),
    );

    // Marker + whitespace differences did not lose the join.
    expect(roleZero).toContain("add a concrete metric or outcome");
    expect(roleZero).toContain("name the throughput");
    // The `ok` finding contributes nothing — it would spend prompt budget to
    // say a bullet is fine, and teach the model the list is ignorable.
    expect(roleZero).not.toContain("Bullet 2");

    expect(summaryPrompt).toContain("Too generic");
    expect(roleOne).toContain("make this specific");

    // Still scoped, through the real adapter.
    expect(roleZero).not.toContain("make this specific");
    expect(roleZero).not.toContain("Too generic");
  });

  it("changes nothing when the user never ran a critique", async () => {
    // `findingsFromCritique(undefined)` is `undefined`, which is the single
    // "contributes nothing" signal the byte-identical guarantee keys on.
    const sections = [
      summarySection(SUMMARY),
      experienceSection("exp-0", "Staff Engineer", [FLAGGED, CLEAN]),
    ];
    const run = async (steering?: RewriteSteering) => {
      const { engine, calls } = makeEngine(async () => reply("Rewritten line"));
      await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {}, steering);
      return calls.map((c) => String(c.messages[0]?.content ?? ""));
    };

    const noCritique = await run({
      userInstructions: "target staff",
      findings: findingsFromCritique(undefined),
    });
    const preChange = await run({ userInstructions: "target staff" });
    expect(noCritique).toEqual(preChange);
  });

  it("changes nothing when every finding is `ok`", async () => {
    const allOk: ResumeCritique = {
      bulletFindings: [
        { bullet: FLAGGED, issue: "ok" },
        { bullet: CLEAN, issue: "ok" },
      ],
      missingSections: [],
    };
    const sections = [experienceSection("exp-0", "Staff", [FLAGGED, CLEAN])];
    const run = async (steering?: RewriteSteering) => {
      const { engine, calls } = makeEngine(async () => reply("Rewritten line"));
      await rewriteResumeWithLlm(sections, engine, TEST_MODEL, () => {}, steering);
      return calls.map((c) => String(c.messages[0]?.content ?? ""));
    };
    expect(
      await run({ findings: findingsFromCritique(allOk) }),
    ).toEqual(await run(undefined));
  });
});
