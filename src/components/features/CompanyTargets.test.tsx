// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * CompanyTargets + useCompanyTargets (#533). Drives the real hook through a
 * host component with raw createRoot + act (the repo's component-test pattern),
 * so the lazy registry/taxonomy imports and the selection edits are exercised
 * end to end rather than against a stubbed state object.
 *
 * The assertions that matter are the ones the fan-out depends on: what
 * `selected` contains after a toggle, and that a sector switch re-seeds it —
 * because that array is passed straight to `searchJobs`.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CompanyTargets } from "./CompanyTargets.tsx";
import {
  useCompanyTargets,
  companyKey,
  toggleKey,
  COMPANY_LIMIT,
  type CompanyTargets as CompanyTargetsState,
} from "../../hooks/useCompanyTargets.ts";
import type { HeuristicParsedResume } from "../../lib/heuristics/types.ts";
import type { CompanyEntry } from "../../lib/job-search/company-registry.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** A payments-heavy resume, so the heuristic classifier lands on fintech. */
const fintechResume: HeuristicParsedResume = {
  skills: ["payments", "ledger", "fraud detection"],
  experience: [
    { title: "Senior Backend Engineer", company: "PayCo" },
  ],
  education: [],
};

/**
 * Straddles two sectors on purpose, so the classifier reports a `runnerUp` and
 * the "not right? switch" affordance actually exists. `fintechResume` scores
 * only fintech, which would make the switch tests vacuously pass.
 */
const twoSectorResume: HeuristicParsedResume = {
  skills: ["payments", "ledger", "penetration testing", "siem"],
  experience: [{ title: "Backend Engineer", company: "X" }],
  education: [],
};

/** Captures the live hook state so assertions can read it between acts. */
let latest: CompanyTargetsState | null = null;

function Host({ parsed }: { parsed: HeuristicParsedResume }) {
  const targets = useCompanyTargets(parsed);
  latest = targets;
  return createElement(CompanyTargets, { targets });
}

async function mount(parsed: HeuristicParsedResume): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Host, { parsed }));
  });
  // The hook seeds itself from two dynamic imports, so the first render lands
  // before `ready`. A fixed number of ticks is not enough: the FIRST mount in
  // the file pays a cold module load while later ones hit the module cache, so
  // flush until the hook reports ready rather than guessing a tick count.
  for (let i = 0; i < 50 && !latest?.ready; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttons(): HTMLButtonElement[] {
  return [...(container?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
}

function companyButtons(): HTMLButtonElement[] {
  return buttons().filter((b) => b.hasAttribute("aria-pressed"));
}

describe("useCompanyTargets", () => {
  it("suggests sector-matched companies and selects them all by default", async () => {
    await mount(fintechResume);

    expect(latest?.ready).toBe(true);
    expect(latest?.sector).toBe("fintech");
    expect(latest?.suggested.length).toBeGreaterThan(0);
    expect(latest?.suggested.length).toBeLessThanOrEqual(COMPANY_LIMIT);
    // Default-on: a user who just wants to search shouldn't have to opt in.
    expect(latest?.selected).toEqual(latest?.suggested);
  });

  it("removing a company drops it from the set handed to the search", async () => {
    await mount(fintechResume);
    const dropped = latest!.suggested[0];

    await act(async () => {
      latest!.toggle(dropped);
    });

    expect(latest?.selected.map(companyKey)).not.toContain(companyKey(dropped));
    expect(latest?.selected).toHaveLength(latest!.suggested.length - 1);
    // Still suggested — off is a reversible state, not a deletion.
    expect(latest?.suggested).toContain(dropped);
  });

  it("re-adding a company restores it in registry order, not at the end", async () => {
    await mount(fintechResume);
    const first = latest!.suggested[0];

    await act(async () => latest!.toggle(first));
    await act(async () => latest!.toggle(first));

    expect(latest?.selected).toEqual(latest?.suggested);
  });

  it("deselecting everything yields an empty set (keyless-only search)", async () => {
    await mount(fintechResume);
    const all = [...latest!.suggested];

    await act(async () => {
      for (const entry of all) latest!.toggle(entry);
    });

    expect(latest?.selected).toEqual([]);
  });

  it("offers no switch when the classifier found only one sector", async () => {
    await mount(fintechResume);
    expect(latest?.runnerUp).toBeNull();
    expect(container?.textContent).not.toContain("Not right?");
  });

  it("switching to the runner-up re-suggests and re-selects for that sector", async () => {
    await mount(twoSectorResume);
    const before = latest!.suggested.map(companyKey);
    const runnerUp = latest!.runnerUp;
    expect(runnerUp).toBe("security");

    await act(async () => latest!.switchToRunnerUp());

    expect(latest?.sector).toBe(runnerUp);
    expect(latest?.suggested.map(companyKey)).not.toEqual(before);
    // Freshly seeded: every newly suggested company starts selected.
    expect(latest?.selected).toEqual(latest?.suggested);
  });

  it("makes the sector switch reversible by swapping the pair", async () => {
    await mount(twoSectorResume);
    const original = latest!.sector;
    expect(latest?.runnerUp).toBe("security");

    await act(async () => latest!.switchToRunnerUp());
    expect(latest?.sector).toBe("security");
    expect(latest?.runnerUp).toBe(original);

    await act(async () => latest!.switchToRunnerUp());
    expect(latest?.sector).toBe(original);
    expect(latest?.runnerUp).toBe("security");
  });

  it("renders the switch affordance when a runner-up exists", async () => {
    await mount(twoSectorResume);
    expect(container?.textContent).toContain("Not right?");
  });
});

describe("CompanyTargets rendering", () => {
  it("renders one toggle per suggested company, all pressed initially", async () => {
    await mount(fintechResume);
    const chips = companyButtons();
    expect(chips).toHaveLength(latest!.suggested.length);
    expect(chips.every((b) => b.getAttribute("aria-pressed") === "true")).toBe(true);
  });

  it("clicking a company toggles aria-pressed, not just its colour", async () => {
    await mount(fintechResume);
    const chip = companyButtons()[0];

    await act(async () => {
      chip.click();
    });

    expect(companyButtons()[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("says the search falls back to feeds only when nothing is selected", async () => {
    await mount(fintechResume);
    await act(async () => {
      for (const entry of [...latest!.suggested]) latest!.toggle(entry);
    });
    expect(container?.textContent).toContain("job feeds only");
  });

  it("states that only the company name is sent, never the resume", async () => {
    await mount(fintechResume);
    expect(container?.textContent).toContain("never your resume");
  });

  it("degrades to a plain explanation when no sector companies exist", async () => {
    // An unclassifiable resume falls to the "other" sector, which by design has
    // no registry entries.
    await mount({ skills: [], experience: [], education: [] });
    expect(latest?.suggested).toEqual([]);
    expect(companyButtons()).toHaveLength(0);
    expect(container?.textContent).toContain("job feeds only");
  });

  // #542
  it("notes that self-hosted-careers employers aren't reachable here", async () => {
    await mount(fintechResume);
    expect(container?.textContent).toContain("their own careers site");
  });
});

describe("selection helpers", () => {
  it("companyKey distinguishes the same slug on two vendors", () => {
    const base = { name: "Circle", slug: "circle", sectors: ["fintech"] } satisfies
      Omit<CompanyEntry, "ats">;
    expect(companyKey({ ...base, ats: "greenhouse" })).not.toBe(
      companyKey({ ...base, ats: "ashby" }),
    );
  });

  it("toggleKey adds a missing key and removes a present one", () => {
    const empty = new Set<string>();
    const added = toggleKey(empty, "a");
    expect([...added]).toEqual(["a"]);
    expect([...toggleKey(added, "a")]).toEqual([]);
    // Pure: the input set is never mutated.
    expect([...empty]).toEqual([]);
  });
});
