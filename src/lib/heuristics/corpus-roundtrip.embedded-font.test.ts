// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Corpus round-trip on the EMBEDDED Liberation Sans font path (#1009).
 *
 * `corpus-roundtrip.test.ts` (#293) renders every corpus fixture through
 * `renderAtsResumePdf`, but under Node `fetchFontBytes()`
 * (`src/lib/pdf/render-ats-pdf.ts`) cannot resolve the bundled Liberation Sans
 * asset URL, so `loadFonts()` catches that failure and every fixture there
 * renders on the **Helvetica fallback**. The shipped path — embedded
 * Liberation Sans with the coverage-aware sanitizer
 * (`makeEmbeddedFontSanitizer`) — gets no corpus-wide coverage there; only the
 * targeted cases in `render-ats-pdf.fonts.test.ts` reach it.
 *
 * That made #617's invariant ("no exported PDF's text layer ever contains
 * U+0000") untestable at corpus scale: the Helvetica path goes through
 * `toWinAnsi()`, which cannot emit a NUL, so the assertion would pass whether
 * or not the embedded path regressed.
 *
 * This suite stubs `fetch` to serve the real vendored Liberation Sans TTFs —
 * the same technique `render-ats-pdf.fonts.test.ts`'s `stubFetchSucceeds`
 * uses — so every fixture actually exercises `makeEmbeddedFontSanitizer` end
 * to end, and asserts:
 *   - the re-parsed text never contains a NUL (the #617 invariant), and
 *   - the embed genuinely happened — no silent Helvetica fallback, which
 *     would make the NUL assertion above pass VACUOUSLY (Helvetica can't
 *     emit a NUL either way).
 *
 * Deliberately a SEPARATE suite from the main ratchet, not a migration of it
 * (#1009's own open question): Liberation Sans and Helvetica have different
 * metrics, so moving `corpus-roundtrip.test.ts` onto this path would shift
 * line wraps and could change `corpus-roundtrip.known-failures.json` entries
 * — that needs its own baseline pass and is a follow-up only if this suite
 * shows the two paths diverge. This suite proves the embedded path is clean
 * today without touching that ratchet.
 *
 * PII-free: asserts render/parse success and glyph identity (NUL vs not,
 * fallback vs not), never dumps a fixture's parsed value.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCascade } from "./cascade.ts";
import { runRoundtripHop } from "./roundtrip-hop.ts";
import { FIXTURE_ROOT, walkPdfs, relKey } from "./corpus-gate.test-utils.ts";

const FONTS_DIR = fileURLToPath(
  new URL("../../assets/fonts/", import.meta.url),
);
const REGULAR_BYTES = readFileSync(`${FONTS_DIR}LiberationSans-Regular.ttf`);
const BOLD_BYTES = readFileSync(`${FONTS_DIR}LiberationSans-Bold.ttf`);

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Stub `fetch` to serve the real vendored TTF bytes for any local asset URL —
 * same shape as `render-ats-pdf.fonts.test.ts`'s `stubFetchSucceeds`. Must be
 * (re-)installed in `beforeEach`, not at module scope: a module-level
 * `vi.stubGlobal` is undone before the first test runs, which would make the
 * very first fixture silently fall back to Helvetica without `fetch` ever
 * having been called.
 */
function stubFetchSucceeds() {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const bytes = url.includes("Bold") ? BOLD_BYTES : REGULAR_BYTES;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => toArrayBuffer(bytes),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The exact message `loadFonts()` logs on the Helvetica fallback
 *  (`src/lib/pdf/render-ats-pdf.ts`). Its presence is what distinguishes a
 *  fixture that genuinely round-tripped clean on the embedded path from one
 *  that silently fell back and passed the NUL check for the wrong reason. */
const FALLBACK_WARNING = "Body font embed failed, falling back to Helvetica:";

// Fixture-read + full runCascade→render→runCascade round-trip per fixture is
// slow under a coverage-instrumented full-suite `verify` run; scope a higher
// timeout to just this suite rather than bumping vitest's global default,
// matching `corpus-roundtrip.test.ts` (#360).
describe(
  "corpus round-trip on the embedded font path (#1009)",
  { timeout: 20000 },
  () => {
    const fixtures = walkPdfs(FIXTURE_ROOT);
    let fetchMock: ReturnType<typeof stubFetchSucceeds>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = stubFetchSucceeds();
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      warnSpy.mockRestore();
    });

    it("finds fixtures to round-trip", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });

    // Declared BEFORE the per-fixture loop so it is the first test in this
    // file to actually render — the one whose `fetchMock` call count proves
    // the embed genuinely fetched the font, rather than some earlier state
    // (a stale success cached from another file) making the fallback check
    // below pass by accident. `loadBodyFontBytes()` memoizes a SUCCESSFUL
    // fetch module-wide, so this also warms that cache for the rest of the
    // suite — the fixtures below don't re-fetch, matching the issue's own
    // probe evidence ("2 calls, memoized after the first").
    it("actually fetches the embedded font, not a silent Helvetica fallback", async () => {
      const [first] = fixtures;
      const p1 = await runCascade(new Uint8Array(readFileSync(first)));
      const { renderError } = await runRoundtripHop(p1);

      expect(renderError).toBeUndefined();
      // Both faces (regular + bold) are fetched once.
      expect(fetchMock).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(
        FALLBACK_WARNING,
        expect.anything(),
      );
    });

    for (const fixture of fixtures) {
      const rel = relKey(fixture);
      it(`round-trips on the embedded font with no NUL: ${rel}`, async () => {
        const p1 = await runCascade(new Uint8Array(readFileSync(fixture)));
        const { after: p3, renderError } = await runRoundtripHop(p1);

        expect(
          renderError,
          `${rel}: render/re-parse failed: ${renderError}`,
        ).toBeUndefined();
        expect(p3, `${rel}: runRoundtripHop returned no re-parse`).toBeDefined();

        // The #617 invariant: no exported PDF's text layer ever contains
        // U+0000.
        expect(
          p3!.rawText.includes("\0"),
          `${rel}: re-parsed text contains a NUL — the embedded font path silently dropped a glyph`,
        ).toBe(false);

        // Guards against the assertion above passing VACUOUSLY: the
        // Helvetica fallback goes through toWinAnsi(), which can never emit
        // a NUL, so a silent fallback on THIS fixture would make the check
        // above pass whether or not the embedded path
        // (makeEmbeddedFontSanitizer) actually ran.
        expect(
          warnSpy,
          `${rel}: font embed fell back to Helvetica — this fixture never actually exercised the embedded path`,
        ).not.toHaveBeenCalledWith(FALLBACK_WARNING, expect.anything());
      });
    }
  },
);
