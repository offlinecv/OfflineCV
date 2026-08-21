// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the literal-NUL gate (#787).
 *
 * The load-bearing case is `scanPaths` FAILING on a file that carries a real
 * `0x00` — a gate for this class is worth nothing unless it has been watched to
 * fail, because the defect is invisible in every rendering (an editor draws a
 * NUL as nothing, `grep` reports no match rather than an error, and the diff
 * only goes dark past a byte-offset threshold).
 *
 * Note how the fixtures below build that byte: `String.fromCharCode(0)`, never a
 * literal in this source. Writing one here would make this very file an
 * occurrence of what it tests — caught by the gate on the next run, which is
 * funny exactly once.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isBinaryPath, nulPositions, scanPaths, trackedFiles } from "./check-no-literal-nul.mjs";

const NUL = String.fromCharCode(0);

describe("nulPositions", () => {
  it("finds nothing in ordinary text", () => {
    expect(nulPositions(Buffer.from("const key = `${a}\\u0000${b}`;\n"))).toEqual([]);
  });

  it("reports the escape-shaped source as clean — that is the fix, not the defect", () => {
    // Six ASCII characters. This is what #787 replaced the four byte literals
    // with, and the gate must consider it perfectly fine or the fix is unusable.
    const escaped = Buffer.from("a.join(\"\\u0000\")");
    expect(escaped.includes(0x00)).toBe(false);
    expect(nulPositions(escaped)).toEqual([]);
  });

  it("locates a NUL by 1-indexed line and column", () => {
    const buffer = Buffer.from(`line one\nleft${NUL}right\nline three\n`);
    expect(nulPositions(buffer)).toEqual([{ line: 2, column: 5, offset: 13 }]);
  });

  it("reports every occurrence, not just the first", () => {
    const buffer = Buffer.from(`${NUL}a\nb${NUL}\n`);
    expect(nulPositions(buffer).map((p) => p.line)).toEqual([1, 2]);
  });

  it("finds a NUL past the ~8000-byte mark where git stops sniffing", () => {
    // The #786 failure mode: git only sniffs the head of the blob, so a NUL out
    // here renders a normal-looking text diff while every `grep` over the file
    // silently reports no matches. A gate that only read the head would miss
    // exactly the instance that got through review.
    const buffer = Buffer.from(`${"x".repeat(9000)}${NUL}\n`);
    expect(nulPositions(buffer)).toEqual([{ line: 1, column: 9001, offset: 9000 }]);
  });
});

describe("isBinaryPath", () => {
  it("skips the font and PDF assets that legitimately carry NULs", () => {
    expect(isBinaryPath("src/assets/fonts/LiberationSans-Bold.ttf")).toBe(true);
    expect(isBinaryPath("tests/fixtures/pdfs/latex/awesome-cv-cv.pdf")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isBinaryPath("docs/Diagram.PNG")).toBe(true);
  });

  it("does not skip source, config or markdown", () => {
    for (const path of ["src/hooks/useJobSearch.ts", "package.json", "CLAUDE.md", "scripts/x.mjs"]) {
      expect(isBinaryPath(path)).toBe(false);
    }
  });

  it("does not skip a text file whose name merely contains a binary extension", () => {
    // `.pdf` in the middle of the name is not a `.pdf` file — matching on the
    // suffix rather than a substring is what keeps `render-ats-pdf.ts` scanned.
    expect(isBinaryPath("src/lib/pdf/render-ats-pdf.ts")).toBe(false);
  });
});

describe("scanPaths", () => {
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "offlinecv-nul-gate-"));
    writeFileSync(join(dir, "clean.ts"), 'export const k = `${a}\\u0000${b}`;\n');
    writeFileSync(join(dir, "dirty.ts"), `export const k = \`\${a}${NUL}\${b}\`;\n`);
    writeFileSync(join(dir, "asset.ttf"), `binary${NUL}payload`);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("passes a tree whose only NULs live in binary paths", () => {
    expect(scanPaths(["clean.ts", "asset.ttf"], dir)).toEqual([]);
  });

  it("FAILS on a file carrying a literal NUL — the fail-before case", () => {
    const offenders = scanPaths(["clean.ts", "dirty.ts", "asset.ttf"], dir);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].relPath).toBe("dirty.ts");
    // `export const k = \`${a}` is 22 bytes, so the NUL is byte 23 of line 1.
    expect(offenders[0].positions).toEqual([{ line: 1, column: 23, offset: 22 }]);
  });

  it("ignores a path in the index that is not on disk", () => {
    // `git ls-files` reports the index, which still names a file staged for
    // deletion. Throwing there would fail the gate for a reason unrelated to it.
    expect(scanPaths(["deleted-in-worktree.ts"], dir)).toEqual([]);
  });
});

describe("the repository itself", () => {
  it("has no literal NUL in any tracked text file", () => {
    // The acceptance criterion from #787, asserted rather than described. This
    // is the test that goes red if the class ever comes back, whether or not
    // anyone remembered to run `npm run check:nul`.
    expect(scanPaths(trackedFiles())).toEqual([]);
  });
});
