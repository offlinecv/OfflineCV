// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { SKILLS, getSkillIndex, skillCount } from "./skills.ts";

describe("skills dictionary", () => {
  it("ships at least 100 canonical skills (issue acceptance criterion)", () => {
    expect(skillCount()).toBeGreaterThanOrEqual(100);
  });

  it("has at least one alias per entry, including the canonical ID", () => {
    for (const entry of SKILLS) {
      expect(entry.aliases.length).toBeGreaterThan(0);
    }
  });

  it("never maps the same alias to two different canonical IDs", () => {
    const aliasToId = new Map<string, string>();
    for (const entry of SKILLS) {
      for (const alias of entry.aliases) {
        const lower = alias.toLowerCase();
        const existing = aliasToId.get(lower);
        if (existing !== undefined && existing !== entry.id) {
          throw new Error(
            `Alias "${alias}" collides between "${existing}" and "${entry.id}"`,
          );
        }
        aliasToId.set(lower, entry.id);
      }
    }
  });

  it("compiles a single regex that matches multi-word aliases longest-first", () => {
    const index = getSkillIndex();
    // 'ruby on rails' should win over 'ruby' inside a single regex sweep.
    const matches = Array.from("we love ruby on rails here".matchAll(index.pattern));
    expect(matches.length).toBeGreaterThan(0);
    const captured = matches.map((m) => m[1].toLowerCase());
    expect(captured).toContain("ruby on rails");
    expect(captured).not.toContain("ruby");
  });

  it("matches aliases case-insensitively at word boundaries", () => {
    const index = getSkillIndex();
    const re = new RegExp(index.pattern.source, index.pattern.flags);
    const matches = Array.from("Built with TypeScript, React, and K8s.".matchAll(re));
    const ids = matches.map((m) => index.aliasToId.get(m[1].toLowerCase()));
    expect(ids).toEqual(expect.arrayContaining(["typescript", "react", "kubernetes"]));
  });
});
