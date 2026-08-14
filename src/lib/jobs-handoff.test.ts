// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * Round-trip + rejection coverage for the `/` → `/jobs/` résumé handoff.
 *
 * The load-bearing assertion: reading is NON-destructive, so a reload of
 * `/jobs/` still finds the parse. `/jobs/` has no DropZone to fall back to,
 * so a one-shot read would strand the user on a dead page.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  JOBS_HANDOFF_KEY,
  readJobsHandoff,
  writeJobsHandoff,
} from "./jobs-handoff.ts";
import type { HeuristicParsedResume } from "./heuristics/types.ts";

const parsed: HeuristicParsedResume = {
  full_name: "Dana Fixture",
  skills: ["React", "TypeScript"],
  experience: [{ company: "Acme", title: "Staff Engineer" }],
  education: [],
};

beforeEach(() => {
  sessionStorage.clear();
});

describe("jobs handoff", () => {
  it("round-trips the parsed résumé", () => {
    writeJobsHandoff({ parsed });
    const read = readJobsHandoff();
    expect(read?.parsed.full_name).toBe("Dana Fixture");
    expect(read?.parsed.skills).toEqual(["React", "TypeScript"]);
    expect(read?.parsed.experience[0]?.title).toBe("Staff Engineer");
  });

  it("carries the journey-ledger key across (#826)", () => {
    // `/jobs/` cannot re-derive it: the key is `fingerprintParse` of the
    // PRISTINE parse and what arrives here is the edit-folded one, which
    // hashes differently by design. So it travels or it does not exist.
    writeJobsHandoff({ parsed, journeyKey: "a1b2c3d4" });
    expect(readJobsHandoff()?.journeyKey).toBe("a1b2c3d4");
  });

  it("keeps the résumé when the journey key is absent or malformed", () => {
    // A session with no key records no completions — fewer ✓ than the truth,
    // never a wrong one — but the résumé is the thing `/jobs/` cannot work
    // without, so a bad key must never cost it.
    writeJobsHandoff({ parsed });
    expect(readJobsHandoff()?.parsed.full_name).toBe("Dana Fixture");
    expect(readJobsHandoff()?.journeyKey).toBeUndefined();

    sessionStorage.setItem(
      JOBS_HANDOFF_KEY,
      JSON.stringify({ parsed, journeyKey: 42 }),
    );
    expect(readJobsHandoff()?.parsed.full_name).toBe("Dana Fixture");
    expect(readJobsHandoff()?.journeyKey).toBeUndefined();
  });

  it("is NOT consumed on read — a reload of /jobs/ still finds the parse", () => {
    writeJobsHandoff({ parsed });
    expect(readJobsHandoff()).not.toBeNull();
    expect(readJobsHandoff()).not.toBeNull();
    expect(sessionStorage.getItem(JOBS_HANDOFF_KEY)).not.toBeNull();
  });

  it("a second launch overwrites the stashed parse", () => {
    writeJobsHandoff({ parsed });
    writeJobsHandoff({
      parsed: { ...parsed, full_name: "Robin Fixture", skills: ["Go"] },
    });
    const read = readJobsHandoff();
    expect(read?.parsed.full_name).toBe("Robin Fixture");
    expect(read?.parsed.skills).toEqual(["Go"]);
  });

  it("returns null when absent", () => {
    expect(readJobsHandoff()).toBeNull();
  });

  it("rejects malformed JSON rather than throwing", () => {
    sessionStorage.setItem(JOBS_HANDOFF_KEY, "{not json");
    expect(readJobsHandoff()).toBeNull();
  });

  it("rejects a payload missing the guaranteed array fields", () => {
    // `HeuristicParsedResume` guarantees skills/experience/education as arrays;
    // ranking against a payload without them would throw downstream instead.
    sessionStorage.setItem(
      JOBS_HANDOFF_KEY,
      JSON.stringify({ parsed: { full_name: "Dana Fixture", skills: ["React"] } }),
    );
    expect(readJobsHandoff()).toBeNull();

    sessionStorage.setItem(JOBS_HANDOFF_KEY, JSON.stringify({}));
    expect(readJobsHandoff()).toBeNull();
  });
});
