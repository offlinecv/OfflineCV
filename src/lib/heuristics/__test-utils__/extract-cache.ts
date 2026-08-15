// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Test-only disk cache in front of Tier 0 extraction (#829).
 *
 * Six suites — `corpus`, `corpus-roundtrip`, `corpus-edit-roundtrip`,
 * `projections`, `sections` and `export-layout-contract` — each walk
 * `tests/fixtures/pdfs/` and push all 58 fixtures back through `runCascade`
 * from raw bytes. They run in separate `tinypool` forks, so a module-level
 * memo cannot help them; the same pdfjs work is redone several hundred times
 * per run. Extraction is ~82% of a parse (212ms of a 257ms `runCascade`) and
 * is a pure function of the bytes, so it is the one slice that is safely
 * shareable across processes. On disk it is.
 *
 * **This module is never imported by production code and never bundled.** It
 * is reached only through `test.alias` in `vite.config.ts`, which redirects the
 * literal specifier `"./pdf-extract.ts"` — the one `cascade.ts` dynamic-imports
 * — at resolve time, under vitest only. The six suites keep calling
 * `runCascade(bytes)` and are unchanged. `export *` below forwards every other
 * export of the real module unchanged, so this stays a drop-in even if
 * `pdf-extract.ts` grows exports; the local `extractFromPdfBytes` shadows the
 * star export per ESM's rules.
 *
 * **The key is the whole difficulty, and it fails closed.** A cache that hands
 * back a stale extraction for changed parser code turns the corpus green
 * against work it never did — strictly worse than the slowness it fixes. So
 * the key mixes the bytes with a fingerprint of every source file the
 * extraction actually reaches, computed by walking the relative-import closure
 * of `pdf-extract.ts` rather than from a hand-maintained list (a list goes
 * stale silently, and the failure mode of a stale list here is a green lie).
 * Non-relative imports are not walked — `pdfjs-dist` is covered by its
 * resolved version, and the test-only `legacy` alias that selects its build
 * lives in `vite.config.ts`, which is hashed whole. Any read or parse failure
 * recomputes. `UPDATE_FIXTURES=1` (i.e. `npm run bake-fixtures`) bypasses the
 * cache entirely in both directions: a bake that reads its own stale entry is
 * how a wrong golden gets committed.
 *
 * `PdfExtractResult.columnBoundaries` is a `Map`, which `JSON.stringify`
 * renders as `{}` silently — losing it degrades every two-column fixture to
 * interleaved text with no error. Hence the explicit serializer below and the
 * two-column round-trip assertion in `extract-cache.test.ts`, not a bare
 * `JSON.stringify`.
 *
 * **One field is not a pure function of the bytes: `PdfTextItem.fontName`.**
 * pdfjs labels fonts per loaded *document* (`g_d1_f4` in one process, `g_d5_f4`
 * in the next), so a cached result carries labels a fresh extraction would not
 * have produced. That is safe here, and narrowly so: the labels are opaque,
 * `dropDecorativeGlyphs` is their only consumer and groups by them rather than
 * reading them, and it has already run before anything is cached. No other
 * module in `src/` reads the field and no golden records it. `extract-cache.test.ts`
 * pins that divergence to `fontName` alone, so a second field going
 * byte-dependent fails a test instead of quietly changing what the corpus sees.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractFromPdfBytes as extractUncached } from "../pdf-extract.ts";
import type { PdfExtractResult } from "../types.ts";

export * from "../pdf-extract.ts";

const HEURISTICS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(HEURISTICS_DIR, "..", "..", "..");
const CACHE_DIR = join(REPO_ROOT, "node_modules", ".cache", "offlinecv-extract");

/** Bump when the on-disk shape below changes, so old entries are ignored. */
const SCHEMA_VERSION = 1;

/** Eviction thresholds — see `prune()`. The 58 fixtures are the working set. */
export const MAX_ENTRIES = 600;
export const KEEP_ENTRIES = 300;
/** Sweep on every Nth write in a process, not on every one. */
const PRUNE_INTERVAL = 32;

/**
 * Matches both `from "…"` and `import("…")` so a tier reached only by dynamic
 * import still lands in the fingerprint. Deliberately a scan, not a parser:
 * over-matching a specifier inside a comment or string costs one extra file in
 * the hash, which is safe. Under-matching would not be.
 */
const IMPORT_SPECIFIER_RE = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

// ── Cache key ───────────────────────────────────────────────────────────────

/**
 * Hash every source file reachable from `pdf-extract.ts` through relative
 * imports, plus `vite.config.ts` and the resolved `pdfjs-dist` version.
 *
 * Exported for `extract-cache.test.ts`, which asserts the closure actually
 * reaches the modules extraction depends on — a fingerprint that silently
 * stopped walking would be indistinguishable from a correct one until it
 * served a stale extraction.
 */
export function sourceFingerprint(entry = join(HEURISTICS_DIR, "pdf-extract.ts")): {
  files: string[];
  digest: string;
} {
  const hashes = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (hashes.has(file)) continue;
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      // A specifier we resolved to a path that isn't a file (an extensionless
      // import, a package that looked relative). Record the miss so the digest
      // still changes if it later becomes real.
      hashes.set(file, "<unreadable>");
      continue;
    }
    hashes.set(file, sha256(src));
    for (const [, spec] of src.matchAll(IMPORT_SPECIFIER_RE)) {
      if (!spec.startsWith(".")) continue;
      queue.push(resolve(dirname(file), spec));
    }
  }

  const files = [...hashes.keys()].sort();
  const h = createHash("sha256");
  for (const f of files) h.update(f).update("\0").update(hashes.get(f) as string).update("\0");
  h.update(readSafely(join(REPO_ROOT, "vite.config.ts")));
  h.update(pdfjsVersion());
  return { files, digest: h.digest("hex") };
}

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function readSafely(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return `<unreadable:${file}>`;
  }
}

function pdfjsVersion(): string {
  try {
    const pkg = readFileSync(
      join(REPO_ROOT, "node_modules", "pdfjs-dist", "package.json"),
      "utf8",
    );
    return String((JSON.parse(pkg) as { version?: unknown }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

let fingerprint: string | undefined;
function cachedFingerprint(): string {
  fingerprint ??= sourceFingerprint().digest;
  return fingerprint;
}

// ── Serialization ───────────────────────────────────────────────────────────

/**
 * On-disk shape. Identical to `PdfExtractResult` except `columnBoundaries`,
 * which is a `Map` in memory and entry pairs here — see the module docblock.
 */
interface SerializedExtract
  extends Omit<PdfExtractResult, "columnBoundaries"> {
  schemaVersion: number;
  columnBoundaries?: [number, number][];
}

export function serializeExtract(result: PdfExtractResult): string {
  const { columnBoundaries, ...rest } = result;
  const payload: SerializedExtract = {
    schemaVersion: SCHEMA_VERSION,
    ...rest,
    ...(columnBoundaries ? { columnBoundaries: [...columnBoundaries] } : {}),
  };
  return JSON.stringify(payload);
}

/** Returns `undefined` for anything this build cannot trust — see fail-closed. */
export function deserializeExtract(json: string): PdfExtractResult | undefined {
  let payload: SerializedExtract;
  try {
    payload = JSON.parse(json) as SerializedExtract;
  } catch {
    return undefined;
  }
  if (payload?.schemaVersion !== SCHEMA_VERSION) return undefined;
  const { schemaVersion: _schemaVersion, columnBoundaries, ...rest } = payload;
  return {
    ...rest,
    ...(columnBoundaries ? { columnBoundaries: new Map(columnBoundaries) } : {}),
  };
}

// ── The cached wrapper ──────────────────────────────────────────────────────

/** True when the caller must see a real extraction, not a remembered one. */
function bypassed(): boolean {
  return (
    process.env.UPDATE_FIXTURES === "1" ||
    process.env.OFFLINECV_NO_EXTRACT_CACHE === "1"
  );
}

/**
 * Where a given input's entry lives. Exported so `extract-cache.test.ts` can
 * plant a known-wrong entry and prove the cache is genuinely read — and
 * genuinely skipped under `UPDATE_FIXTURES=1`. Asserting the cached result
 * merely *equals* the uncached one proves neither, since that holds whether the
 * cache fired or not.
 */
export function cacheEntryPath(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const key = sha256(view).slice(0, 32) + "-" + cachedFingerprint().slice(0, 16);
  return join(CACHE_DIR, `${key}.json`);
}

export async function extractFromPdfBytes(
  bytes: Uint8Array | ArrayBuffer,
): Promise<PdfExtractResult> {
  if (bypassed()) return extractUncached(bytes);

  const file = cacheEntryPath(bytes);

  try {
    const hit = deserializeExtract(readFileSync(file, "utf8"));
    if (hit) {
      touch(file);
      return hit;
    }
  } catch {
    // Miss, or an entry another fork is mid-write. Fall through and extract.
  }

  const result = await extractUncached(bytes);
  writeAtomically(file, serializeExtract(result));
  return result;
}

/**
 * Mark an entry as just-used, so `prune()` evicts by least-recently-read
 * rather than by age. Without this the 58 fixture entries — the only ones with
 * any reuse value — are the oldest on disk and would be the first evicted.
 */
function touch(file: string): void {
  try {
    const now = new Date();
    utimesSync(file, now, now);
  } catch {
    // Best effort; a missed touch only costs eviction accuracy.
  }
}

/**
 * Keep the cache bounded. The round-trip suites extract PDFs they rendered
 * moments earlier, and `pdf-lib` stamps a creation date, so those bytes differ
 * every run: ~120 entries (~2 MB) per run that are written and never read
 * again. Left alone the directory grows without limit inside `node_modules`,
 * where nobody would think to look for it.
 *
 * Runs on a write, not on every call, and only every `PRUNE_INTERVAL`th one —
 * a `readdir` + `stat` sweep per extraction would cost more than the cache
 * saves.
 */
export function prune(dir = CACHE_DIR): void {
  try {
    const entries = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const path = join(dir, name);
        return { path, usedAt: statSync(path).mtimeMs };
      });
    if (entries.length <= MAX_ENTRIES) return;
    entries.sort((a, b) => a.usedAt - b.usedAt);
    for (const { path } of entries.slice(0, entries.length - KEEP_ENTRIES)) {
      try {
        unlinkSync(path);
      } catch {
        // Another fork got there first.
      }
    }
  } catch {
    // No cache dir yet, or a racing sweep. Nothing to bound.
  }
}

/**
 * Write via a per-process temp file plus `rename`, so a reader in another fork
 * sees either no entry or a complete one — never a truncated JSON that would
 * be discarded (correct, but wasted work) on every concurrent run.
 */
let writes = 0;

function writeAtomically(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(tmp, contents);
    renameSync(tmp, file);
    if (++writes % PRUNE_INTERVAL === 0) prune();
  } catch {
    // A full disk or a read-only tree must not fail a test run — the cache is
    // an optimisation, and the uncached result has already been computed.
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
  }
}
