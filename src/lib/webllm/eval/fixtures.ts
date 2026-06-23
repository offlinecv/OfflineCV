// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import weak from "../../../../tests/fixtures/rewrite/weak.json" with { type: "json" };
import strong from "../../../../tests/fixtures/rewrite/strong.json" with { type: "json" };
import numeric from "../../../../tests/fixtures/rewrite/numeric.json" with { type: "json" };
import redundant from "../../../../tests/fixtures/rewrite/redundant.json" with { type: "json" };

import type { FixtureKind, RewriteFixture } from "./types.ts";

/**
 * The fixture set the eval iterates. JSON files are imported directly
 * (Vite handles bundling for the browser entry; Node 20+ + Vitest both
 * resolve `with { type: "json" }` natively), so adding a fixture means
 * dropping a JSON file under `tests/fixtures/rewrite/` AND appending an
 * import here. The explicit list is deliberate — autoloading via dynamic
 * `import.meta.glob` would invert the test/code dependency and surprise
 * a reader of the file.
 *
 * Every fixture is validated by `parseFixture` at module load time so a
 * broken fixture file throws before any eval run, with a precise pointer
 * to which file is malformed.
 */

const FIXTURE_KINDS: readonly FixtureKind[] = [
  "weak",
  "strong",
  "numeric",
  "redundant",
];

function isFixtureKind(value: unknown): value is FixtureKind {
  return (
    typeof value === "string" &&
    (FIXTURE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Validate one fixture's JSON shape. Throws with the source path so a
 * malformed fixture is easy to find.
 */
export function parseFixture(raw: unknown, source: string): RewriteFixture {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`[rewrite-fixture] ${source}: not an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new Error(`[rewrite-fixture] ${source}: missing/empty 'id'`);
  }
  if (!isFixtureKind(obj.kind)) {
    throw new Error(
      `[rewrite-fixture] ${source}: 'kind' must be one of ${FIXTURE_KINDS.join(", ")}`,
    );
  }
  if (typeof obj.description !== "string") {
    throw new Error(`[rewrite-fixture] ${source}: missing 'description'`);
  }
  if (
    !Array.isArray(obj.bullets) ||
    obj.bullets.length === 0 ||
    !obj.bullets.every((b): b is string => typeof b === "string")
  ) {
    throw new Error(
      `[rewrite-fixture] ${source}: 'bullets' must be a non-empty string[]`,
    );
  }
  return {
    id: obj.id,
    kind: obj.kind,
    description: obj.description,
    bullets: obj.bullets,
  };
}

/**
 * All fixtures, parsed at module load. Order is stable and used as the
 * report's row order.
 */
export const REWRITE_FIXTURES: readonly RewriteFixture[] = [
  parseFixture(weak, "tests/fixtures/rewrite/weak.json"),
  parseFixture(strong, "tests/fixtures/rewrite/strong.json"),
  parseFixture(numeric, "tests/fixtures/rewrite/numeric.json"),
  parseFixture(redundant, "tests/fixtures/rewrite/redundant.json"),
];

/** Look up a fixture by id. */
export function getFixtureById(id: string): RewriteFixture | undefined {
  return REWRITE_FIXTURES.find((f) => f.id === id);
}
