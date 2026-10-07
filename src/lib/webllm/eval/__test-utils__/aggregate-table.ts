// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Shared Markdown-aggregate-table parsing for the eval wiring tests
 * (`adherence-reporting.test.ts`, `markdown-reporting.test.ts`) — both prove a
 * criterion survives fixture → `runEval` → `AggregateRow` → the rendered table,
 * and both need the same column-addressed read to avoid the unfalsifiable
 * substring match #714 found (a `0%` cell matching `/0%/` even when the real
 * target cell had silently become `—`).
 */

/** `| a | b |` → `["", "a", "b", ""]`. Header and row split identically, so
 *  a column's index in one is its cell's index in the other. */
export function splitRow(line: string): string[] {
  return line.split("|").map((c) => c.trim());
}

/** The aggregate table, addressed BY COLUMN NAME — see module docblock. */
export function aggregateTable(md: string): {
  header: string;
  separator: string;
  row: string;
  cell: (column: string) => string;
} {
  const lines = md.split("\n");
  const headerIdx = lines.findIndex((l) => l.startsWith("| Model | Variant |"));
  if (headerIdx < 0) throw new Error(`no aggregate table in report:\n${md}`);
  const header = lines[headerIdx]!;
  const row = lines[headerIdx + 2]!;
  const columns = splitRow(header);
  const cells = splitRow(row);
  return {
    header,
    separator: lines[headerIdx + 1]!,
    row,
    cell: (column) => {
      const i = columns.indexOf(column);
      if (i < 0) throw new Error(`no "${column}" column in: ${header}`);
      return cells[i]!;
    },
  };
}
