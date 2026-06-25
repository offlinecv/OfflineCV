// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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

  it("aggregates allNumbersPreserved across sections", async () => {
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
    expect(result.allNumbersPreserved).toBe(false);
    expect(result.sections[0]!.kind === "experience" && result.sections[0]!.data.numbersPreserved).toBe(
      true,
    );
    expect(result.sections[1]!.kind === "experience" && result.sections[1]!.data.numbersPreserved).toBe(
      false,
    );
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
    });
    expect(sectionCompletedMock).toHaveBeenNthCalledWith(2, {
      model: TEST_MODEL,
      sectionIndex: 1,
      sectionKind: "experience",
      inputUnitCount: 1,
      outputUnitCount: 1,
      numbersPreserved: true,
    });
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
