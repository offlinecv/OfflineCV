/**
 * Guards the three ways the #829 extraction cache could quietly lie:
 *
 *   1. The serializer drops `columnBoundaries` (a `Map`, which
 *      `JSON.stringify` renders `{}` with no error), degrading every
 *      two-column fixture to interleaved text while the corpus stays green.
 *   2. The source fingerprint stops descending, so an edit to a module the
 *      extraction actually reaches leaves a stale entry servable.
 *   3. The alias in `vite.config.ts` stops taking effect, so the cache is
 *      simply never used and the issue silently reopens.
 *
 * The two-column fixture is not incidental — case 1 is invisible on a
 * single-column one, where `columnBoundaries` is absent to begin with.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  cacheEntryPath,
  deserializeExtract,
  extractFromPdfBytes as cachedExtract,
  KEEP_ENTRIES,
  MAX_ENTRIES,
  prune,
  serializeExtract,
  sourceFingerprint,
} from "./extract-cache.ts";
// NOT aliased: the redirect matches the literal specifier "./pdf-extract.ts",
// and this one starts with "../". That asymmetry is the whole mechanism, and it
// is what lets this file hold the real extraction and the cached one side by
// side. See the alias comment in vite.config.ts.
import { extractFromPdfBytes as uncachedExtract } from "../pdf-extract.ts";
import type { PdfExtractResult } from "../types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const TWO_COLUMN_FIXTURE = join(
  REPO_ROOT,
  "tests/fixtures/pdfs/google-docs/google-docs-skia-proxy-two-column.pdf",
);

const POISON = "planted by extract-cache.test.ts";

const twoColumnBytes = () => new Uint8Array(readFileSync(TWO_COLUMN_FIXTURE));

/**
 * The two-column fixture plus ignorable trailing bytes. Anything after `%%EOF`
 * is ignored by a PDF reader, so this parses like the fixture but hashes to a
 * key nothing else looks up — which is what lets these tests write to, and
 * plant wrong entries in, a cache the six corpus suites share across forks.
 * One `tag` per test keeps them from colliding with each other.
 */
const probeBytes = (tag: string) =>
  new Uint8Array([
    ...twoColumnBytes(),
    ...new TextEncoder().encode(`\n% offlinecv extract-cache probe ${tag}\n`),
  ]);

/**
 * Rewrite pdfjs's per-document font labels to their first-occurrence index, so
 * two extractions of the same bytes compare on what the labels *partition* —
 * which is all `dropDecorativeGlyphs` uses them for — rather than on the
 * arbitrary strings. See "diverges from a fresh extraction in fontName ALONE".
 */
function canonicalFontNames(result: PdfExtractResult): PdfExtractResult {
  const seen = new Map<string, string>();
  return {
    ...result,
    items: result.items.map((item) => {
      let label = seen.get(item.fontName);
      if (label === undefined) {
        label = `font#${seen.size}`;
        seen.set(item.fontName, label);
      }
      return { ...item, fontName: label };
    }),
  };
}

const scratchDirs: string[] = [];
const scratchEntries: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const entry of scratchEntries) rmSync(entry, { force: true });
});

describe("extract-cache serialization", () => {
  it("round-trips a two-column extraction without losing columnBoundaries", async () => {
    const original = await uncachedExtract(twoColumnBytes());

    // Fail loudly if the fixture stops being two-column — otherwise this whole
    // test degrades into the single-column case it exists to avoid.
    expect(original.columnBoundaries).toBeInstanceOf(Map);
    expect(original.columnBoundaries?.size).toBeGreaterThan(0);

    const restored = deserializeExtract(serializeExtract(original));

    expect(restored?.columnBoundaries).toBeInstanceOf(Map);
    expect([...(restored?.columnBoundaries ?? [])]).toEqual([
      ...(original.columnBoundaries ?? []),
    ]);
    expect(restored).toEqual(original);
  });

  it("round-trips a single-column extraction, leaving columnBoundaries absent", () => {
    const single: PdfExtractResult = {
      items: [],
      pages: [{ page: 1, width: 612, height: 792, charCount: 0 }],
      text: "",
      rawCharCount: 0,
      linkAnnotations: [],
    };

    const restored = deserializeExtract(serializeExtract(single));

    expect(restored).toEqual(single);
    expect(restored && "columnBoundaries" in restored).toBe(false);
  });

  it("preserves extractionFailureReason", () => {
    const failed: PdfExtractResult = {
      items: [],
      pages: [],
      text: "",
      rawCharCount: 0,
      linkAnnotations: [],
      extractionFailureReason: "fonts_unmappable",
    };

    expect(deserializeExtract(serializeExtract(failed))).toEqual(failed);
  });

  it("refuses malformed JSON rather than throwing", () => {
    expect(deserializeExtract("{not json")).toBeUndefined();
  });

  it("refuses an entry written by a different schema version", () => {
    expect(
      deserializeExtract(JSON.stringify({ schemaVersion: 0, items: [] })),
    ).toBeUndefined();
  });
});

describe("extract-cache source fingerprint", () => {
  it("descends into what extraction actually reaches, not just the entry module", () => {
    const named = sourceFingerprint().files.map((f) =>
      f.replace(`${REPO_ROOT}/`, ""),
    );

    // `pdf-extract` imports the first two directly; `line-assembly` pulls in
    // the third. A walk that stopped at the entry module would still LOOK
    // correct until it served a stale extraction, so assert the closure.
    expect(named).toContain("src/lib/heuristics/pdf-extract.ts");
    expect(named).toContain("src/lib/heuristics/line-assembly.ts");
    expect(named).toContain("src/lib/heuristics/pdf-layout.ts");
    expect(named).toContain("src/lib/heuristics/line-primitives.ts");
  });

  it("changes when a TRANSITIVELY imported file's contents change", () => {
    const dir = mkdtempSync(join(tmpdir(), "offlinecv-fingerprint-"));
    scratchDirs.push(dir);
    const entry = join(dir, "entry.ts");
    const leaf = join(dir, "leaf.ts");
    writeFileSync(entry, `import { x } from "./leaf.ts";\nexport const y = x;\n`);
    writeFileSync(leaf, `export const x = 1;\n`);

    const before = sourceFingerprint(entry).digest;
    writeFileSync(leaf, `export const x = 2;\n`);
    const after = sourceFingerprint(entry).digest;

    // The entry module is byte-identical across both calls. If the digest is
    // unchanged, the walk never descended and every leaf edit is invisible.
    expect(after).not.toEqual(before);
  });

  it("is stable when nothing changed", () => {
    expect(sourceFingerprint().digest).toEqual(sourceFingerprint().digest);
  });
});

describe("extract-cache eviction", () => {
  it("keeps the recently READ entries and drops the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "offlinecv-prune-"));
    scratchDirs.push(dir);

    // Written oldest-first, which is how the real cache fills: the fixtures go
    // in on the first run and the throwaway round-trip renders pile up after.
    // Evicting by age alone would therefore drop exactly the entries worth
    // keeping, so age and recency are set in opposite orders here.
    const total = MAX_ENTRIES + 50;
    for (let i = 0; i < total; i++) {
      const file = join(dir, `entry-${String(i).padStart(4, "0")}.json`);
      writeFileSync(file, "{}");
      const usedAt = new Date(1_700_000_000_000 + (total - i) * 1000);
      utimesSync(file, usedAt, usedAt);
    }

    prune(dir);

    const left = readdirSync(dir).sort();
    expect(left).toHaveLength(KEEP_ENTRIES);
    // The first-written entries were read most recently, so they survive.
    expect(left[0]).toBe("entry-0000.json");
    expect(left.at(-1)).toBe(`entry-${String(KEEP_ENTRIES - 1).padStart(4, "0")}.json`);
  });

  it("leaves a cache under the cap untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "offlinecv-prune-"));
    scratchDirs.push(dir);
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `e-${i}.json`), "{}");

    prune(dir);

    expect(readdirSync(dir)).toHaveLength(10);
  });
});

describe("extract-cache wiring", () => {
  // These tests assert the cache FIRES, so they have to own both switches that
  // turn it off — otherwise a run that sets either one globally (a bake, or the
  // `OFFLINECV_NO_EXTRACT_CACHE=1` control run used to measure the cache's
  // effect) fails them for doing exactly what it asked for.
  const SWITCHES = ["OFFLINECV_NO_EXTRACT_CACHE", "UPDATE_FIXTURES"] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
    for (const k of SWITCHES) delete process.env[k];
  });

  afterEach(() => {
    for (const k of SWITCHES) {
      const previous = saved[k];
      if (previous === undefined) delete process.env[k];
      else process.env[k] = previous;
    }
  });

  it("is what runCascade's Tier 0 actually reaches", async () => {
    // The end-to-end proof, and the only one that matters: the redirect exists
    // to intercept `cascade.ts`'s `import("./pdf-extract.ts")`. Asserted by
    // side effect rather than by module identity, because a cache entry
    // appearing for bytes only `runCascade` was handed cannot happen any other
    // way — and because tsc cannot resolve a specifier that only vitest aliases.
    const bytes = probeBytes("cascade-wiring");
    const entry = cacheEntryPath(bytes);
    scratchEntries.push(entry);
    rmSync(entry, { force: true });

    const { runCascade } = await import("../cascade.ts");
    await runCascade(bytes);

    expect(existsSync(entry)).toBe(true);
  });

  it("keeps forwarding the real module's other exports", async () => {
    // `export *`, not a hand-listed re-export set: the stand-in has to stay a
    // drop-in when `pdf-extract.ts` grows an export, and a list would go stale
    // as a resolution failure in whichever module imported the missing name.
    const self = await import("./extract-cache.ts");
    expect(typeof self.assembleTextFromLines).toBe("function");
    expect(typeof self.dropDecorativeGlyphs).toBe("function");
  });

  it("serves a second call from disk with a result equal to the uncached one", async () => {
    // Fresh bytes per call, deliberately: pdfjs TRANSFERS the buffer it is
    // handed to its worker, so a second `getDocument` over the same array
    // throws `DataCloneError` on a detached buffer. A cache hit never detaches,
    // which is why reusing one array here would pass and fail by turns.
    const first = await cachedExtract(twoColumnBytes());
    const second = await cachedExtract(twoColumnBytes()); // read back off disk
    const uncached = await uncachedExtract(twoColumnBytes());

    expect(second).toEqual(first);
    expect(canonicalFontNames(second)).toEqual(canonicalFontNames(uncached));
    expect(second.columnBoundaries).toBeInstanceOf(Map);
  });

  it("diverges from a fresh extraction in fontName ALONE", async () => {
    // pdfjs labels fonts per loaded-document, not per file: the same bytes come
    // back as `g_d1_f4` in one process and `g_d5_f4` in another. So a cached
    // result carries labels a fresh extraction would not have produced.
    //
    // That is safe only because `fontName` is opaque — `dropDecorativeGlyphs`
    // is its one consumer, it groups by the label rather than reading it, and
    // it has already run by the time a result is cached. Nothing else in `src/`
    // touches the field and no golden records it. This test is what makes that
    // narrow: if any OTHER field ever stops being a pure function of the bytes,
    // it fails here instead of the cache quietly serving a diverging result.
    const fresh = await uncachedExtract(twoColumnBytes());
    const alsoFresh = await uncachedExtract(twoColumnBytes());

    expect(canonicalFontNames(alsoFresh)).toEqual(canonicalFontNames(fresh));
    const labels = (r: PdfExtractResult) => r.items.map((i) => i.fontName);
    expect(labels(alsoFresh)).not.toEqual(labels(fresh));
  });

  it("reads the entry it wrote, and skips it entirely under UPDATE_FIXTURES", async () => {
    // Probe bytes, not a fixture's: this plants a deliberately WRONG entry, and
    // the six corpus suites share this cache across forks. Trailing bytes after
    // %%EOF are ignored by any PDF reader, so this parses like the fixture but
    // hashes to a key nothing else will ever look up.
    const entry = cacheEntryPath(probeBytes("poison"));
    const real = await uncachedExtract(probeBytes("poison"));
    scratchEntries.push(entry);

    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, serializeExtract({ ...real, text: POISON }));

    // Cache live: the planted entry comes back, which is the only way to know
    // the read path fired at all rather than silently re-extracting.
    expect((await cachedExtract(probeBytes("poison"))).text).toBe(POISON);

    // Restored by the afterEach above.
    process.env.UPDATE_FIXTURES = "1";
    const baked = await cachedExtract(probeBytes("poison"));
    expect(baked.text).not.toBe(POISON);
    expect(baked.text).toEqual(real.text);
    expect(baked.columnBoundaries).toBeInstanceOf(Map);
  });
});
