// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * render-ats-pdf.fonts.test.ts — Poppins font-embed behavior (#314).
 *
 * Split from render-ats-pdf.test.ts because these tests need to control
 * `global.fetch` (the mechanism `loadPoppinsBytes()` uses to read the
 * bundled Poppins TTFs) and reset the module registry between cases — the
 * module-scoped `poppinsBytesPromise` cache means a rejected fetch would
 * otherwise "stick" for the rest of the file. Each case stubs `fetch`, then
 * `vi.resetModules()` + a fresh dynamic `import()` so it starts from a clean
 * cache.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPdfText } from "./render-ats-pdf.test-utils.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";

const FONTS_DIR = fileURLToPath(
  new URL("../../assets/fonts/", import.meta.url),
);
const REGULAR_BYTES = readFileSync(`${FONTS_DIR}Poppins-Regular.ttf`);
const BOLD_BYTES = readFileSync(`${FONTS_DIR}Poppins-Bold.ttf`);

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Stub `fetch` to serve the real vendored TTF bytes for any local asset URL. */
function stubFetchSucceeds() {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    // Zero-egress guard (#314 AC): the URL loadPoppinsBytes() fetches must be
    // a local/bundled asset path, never an external host or font CDN.
    expect(url).not.toMatch(/^https?:\/\//);
    expect(url.toLowerCase()).not.toContain("fonts.gstatic.com");
    const bytes = url.includes("Bold") ? BOLD_BYTES : REGULAR_BYTES;
    // `ok: true` is not decoration — `fetchFontBytes` rejects a non-ok response
    // (#664), and a mock that omits `ok` reads as `undefined`/falsy, which would
    // send every case in this file down the Helvetica path while claiming to
    // test the embedded one.
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

/** Stub `fetch` to fail at the network layer, forcing the Helvetica fallback. */
function stubFetchFails() {
  const fetchMock = vi.fn(async () => {
    throw new Error("network unavailable (simulated)");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Stub `fetch` to RESOLVE with an HTTP error — the case `fetch` itself does not
 * reject on (#664). Before the status check this reached the Helvetica fallback
 * anyway, but only because fontkit choked on the error page's bytes.
 */
function stubFetchHttpError(status = 404) {
  // The body reader is a spy, because it is the ONLY observable difference the
  // status check makes. Without the check the fallback is still reached — via
  // fontkit failing on the error page's bytes — so asserting "we fell back"
  // passes either way. Asserting the body was never read is what distinguishes
  // "rejected on the status" from "rejected on corrupt bytes".
  const arrayBuffer = vi.fn(
    async () => new TextEncoder().encode("<html>nope</html>").buffer,
  );
  const fetchMock = vi.fn(async () => {
    return { ok: false, status, statusText: "Not Found", arrayBuffer } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, arrayBuffer };
}

/**
 * Inspect the produced PDF's own object graph (via pdf-lib, already a
 * dependency) for a `/FontFile2` key — the PDF-spec entry for an embedded
 * TrueType font program, which StandardFonts (Helvetica) never emit. Newer
 * pdf-lib output uses compressed cross-reference/object streams, so a raw
 * text search over the bytes is unreliable; re-parsing with `PDFDocument` and
 * walking every indirect object is the robust check.
 */
async function hasEmbeddedFontFile2(bytes: Uint8Array): Promise<boolean> {
  const { PDFDocument, PDFDict, PDFName } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of("FontFile2"))) {
      return true;
    }
  }
  return false;
}

const model = (text: string): AtsResumeModel => ({
  contact: { name: "Jane Candidate", links: [] },
  summary: text,
  sections: [],
});

// Each case does a real fontkit Poppins-embed render (the failing glyph case
// renders twice); slow under a coverage-instrumented full-suite `verify` run,
// so scope a higher timeout to just this suite rather than bumping vitest's
// global default (#360).
describe("Poppins font embed (#314)", { timeout: 20000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("embeds Poppins (a /FontFile2 TrueType program is present) when the local asset fetch succeeds", async () => {
    const fetchMock = stubFetchSucceeds();
    vi.resetModules();
    const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

    const bytes = await renderAtsResumePdf(model("Poppins embed check"));
    expect(fetchMock).toHaveBeenCalled();
    await expect(hasEmbeddedFontFile2(bytes)).resolves.toBe(true);
  });

  it("falls back to Helvetica (no /FontFile2, no throw) when the font fetch fails", async () => {
    stubFetchFails();
    vi.resetModules();
    const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

    const bytes = await renderAtsResumePdf(model("fallback check"));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(500);
    await expect(hasEmbeddedFontFile2(bytes)).resolves.toBe(false);
  });

  it("renders a Latin-Extended glyph (ł) under embedded Poppins that the Helvetica fallback degrades to '?'", async () => {
    // Embedded path: Poppins' cmap covers "ł" (verified via fontkit).
    stubFetchSucceeds();
    vi.resetModules();
    const { renderAtsResumePdf: renderEmbedded } = await import(
      "./render-ats-pdf.ts"
    );
    const embeddedBytes = await renderEmbedded(model("Łukasz, Wrocław"));
    const embeddedText = await extractPdfText(embeddedBytes);
    expect(embeddedText).toContain("ł");

    // Fallback path: StandardFonts can only encode WinAnsi, so toWinAnsi()
    // degrades "ł" (no WinAnsi representation) to "?".
    stubFetchFails();
    vi.resetModules();
    const { renderAtsResumePdf: renderFallback } = await import(
      "./render-ats-pdf.ts"
    );
    const fallbackBytes = await renderFallback(model("Łukasz, Wrocław"));
    const fallbackText = await extractPdfText(fallbackBytes);
    expect(fallbackText).not.toContain("ł");
    expect(fallbackText).toContain("?");
  });

  // An embedded font is not a licence to skip sanitization. pdf-lib does not
  // throw on a code point the font lacks — it draws `.notdef`, which extracts
  // back as U+0000. Found by exporting a real résumé in the browser: the role
  // title "Software Engineer Intern → Junior Engineer" came back out of the
  // downloaded PDF with a NUL where the arrow had been.
  //
  // A NUL is strictly worse than the WinAnsi path's "?": it is invisible on
  // screen, and it rides into every downstream consumer of the re-parsed field.
  describe("a glyph the embedded font lacks (#664, embedded half)", () => {
    // Verified against the vendored Poppins-Regular.ttf via fontkit's
    // `hasGlyphForCodePoint`: Poppins covers "ś"/"ł" but NOT these three.
    const UNCOVERED = [
      { ch: "→", name: "rightwards arrow", want: "->" },
      { ch: "★", name: "black star", want: "?" },
      { ch: "✓", name: "check mark", want: "?" },
    ];

    for (const { ch, name, want } of UNCOVERED) {
      it(`never emits a NUL for ${name} (${ch}) — degrades to "${want}"`, async () => {
        stubFetchSucceeds();
        vi.resetModules();
        const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

        const bytes = await renderAtsResumePdf(model(`Alpha ${ch} Omega`));
        const text = await extractPdfText(bytes);

        // The defect, stated directly.
        expect(text).not.toContain("\0");
        // And the degradation is readable, not a silent deletion — the
        // surrounding text must survive intact.
        expect(text).toContain("Alpha");
        expect(text).toContain("Omega");
        expect(text).toContain(want);
      });
    }

    it("still embeds Poppins — the fix sanitizes, it does not fall back to Helvetica", async () => {
      // Guards the conservative fallback in `makePoppinsSanitizer`: if the
      // coverage probe silently failed we would sanitize with `toWinAnsi`, the
      // "→" case above would STILL pass, and every Latin-Extended glyph would
      // regress unnoticed. Pin that the embedded font is genuinely in use and
      // that both properties hold at once.
      stubFetchSucceeds();
      vi.resetModules();
      const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

      const bytes = await renderAtsResumePdf(model("Łukasz → Wrocław"));
      const text = await extractPdfText(bytes);

      await expect(hasEmbeddedFontFile2(bytes)).resolves.toBe(true);
      expect(text).not.toContain("\0");
      expect(text).toContain("->");
      // The whole point of the embedded path, still true after the fix.
      expect(text).toContain("ł");
    });
  });

  // A NUL already IN the input is a distinct class from an uncovered glyph, and
  // the one the coverage probe cannot be trusted for: Poppins reports a real
  // glyph for U+0000 (`hasGlyphForCodePoint(0) === true` in both vendored
  // faces), so a probe-first sanitizer emits it verbatim.
  //
  // Reachable without any new bug: export on a pre-fix build, re-upload that
  // PDF, and the re-parsed field now holds a NUL — which then rides out through
  // every later export. Both font paths must eat it.
  describe("a NUL already in the input (#664, the probe's blind spot)", () => {
    for (const { label, stub } of [
      { label: "embedded Poppins", stub: stubFetchSucceeds },
      { label: "Helvetica fallback", stub: stubFetchFails },
    ]) {
      it(`drops a NUL under ${label}`, async () => {
        stub();
        vi.resetModules();
        const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

        const bytes = await renderAtsResumePdf(model("Alpha \0 Omega"));
        const text = await extractPdfText(bytes);

        expect(text).not.toContain("\0");
        // Dropped, not turned into a visible "?" — a NUL has no meaning to
        // transliterate, and the surrounding text must survive.
        expect(text).toContain("Alpha");
        expect(text).toContain("Omega");
      });
    }

    it("drops a NUL from a BOLD run, which uses the other embedded face", async () => {
      // `groupRunsIntoWords` draws section headings and role titles with
      // `fonts.bold` — a different TTF from `fonts.regular`. Both faces are
      // probed, so this holds independently of the two files' coverage
      // matching; without that, a Regular-only probe would be right by
      // accident and a Poppins bump could silently reinstate the NUL here.
      stubFetchSucceeds();
      vi.resetModules();
      const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

      const bytes = await renderAtsResumePdf({
        contact: { name: "Jane Candidate", links: [] },
        sections: [
          {
            kind: "experience",
            heading: "Experience",
            entries: [
              { headerLine: "Engineer \0 Acme", bullets: ["Shipped things"] },
            ],
          },
        ],
      });
      const text = await extractPdfText(bytes);

      await expect(hasEmbeddedFontFile2(bytes)).resolves.toBe(true);
      expect(text).not.toContain("\0");
      expect(text).toContain("Engineer");
      expect(text).toContain("Acme");
    });
  });

  // The two failure-handling defects behind #664's refusal. Both are about the
  // LOAD path, not the sanitizers — a refusal the user cannot clear is worse
  // than the silent degradation it replaces.
  describe("font-load failure handling (#664)", () => {
    it("rejects an HTTP error response without reading its body, which `fetch` alone does not do", async () => {
      const { fetchMock, arrayBuffer } = stubFetchHttpError(404);
      vi.resetModules();
      const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

      const bytes = await renderAtsResumePdf(model("http error check"));

      expect(fetchMock).toHaveBeenCalled();
      // The load bailed on the status. Without the check we would have read the
      // error page and handed it to fontkit — reaching the same fallback, but
      // reporting a font-parse failure instead of a 404.
      expect(arrayBuffer).not.toHaveBeenCalled();
      // The fallback is still intact: a bad status must not break the download.
      await expect(hasEmbeddedFontFile2(bytes)).resolves.toBe(false);
    });

    it("re-fetches after a failure instead of replaying the cached rejection", async () => {
      // The defect: `poppinsBytesPromise` is memoized and the guard is
      // `!poppinsBytesPromise`, so a REJECTED promise used to stay cached for
      // the life of the page. Every later download replayed it without issuing
      // a request, which silently made "check your connection and try again"
      // impossible to satisfy.
      const failing = stubFetchFails();
      vi.resetModules();
      const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

      const first = await renderAtsResumePdf(model("attempt one"));
      await expect(hasEmbeddedFontFile2(first)).resolves.toBe(false);
      const callsWhileFailing = failing.mock.calls.length;
      expect(callsWhileFailing).toBeGreaterThan(0);

      // Network recovers. NOTE: no `vi.resetModules()` here — that is the whole
      // point. The same module instance, with its cache already poisoned by the
      // failure above, must issue a fresh request.
      const recovered = stubFetchSucceeds();
      const second = await renderAtsResumePdf(model("attempt two"));

      expect(recovered).toHaveBeenCalled();
      await expect(hasEmbeddedFontFile2(second)).resolves.toBe(true);
    });

    it("keeps memoizing a SUCCESSFUL fetch — only the failure path is cleared", async () => {
      const fetchMock = stubFetchSucceeds();
      vi.resetModules();
      const { renderAtsResumePdf } = await import("./render-ats-pdf.ts");

      await renderAtsResumePdf(model("first"));
      const afterFirst = fetchMock.mock.calls.length;
      await renderAtsResumePdf(model("second"));

      // Two assets, fetched once between them — clearing the memo on success
      // too would turn every repeat download into a re-download.
      expect(afterFirst).toBe(2);
      expect(fetchMock.mock.calls.length).toBe(2);
    });
  });

  // The probe behind the refusal. It must be silent for the common case and
  // specific for the rare one.
  describe("findExportGlyphLosses (#664)", () => {
    const polish = (): AtsResumeModel => ({
      contact: { name: "ANNA WIŚNIEWSKA", links: [] },
      sections: [],
    });

    it("reports nothing when the embedded font loads, even with Latin-Extended text", async () => {
      // Poppins covers ś/ł, so there is no loss to refuse over — the whole
      // reason this issue's original framing stopped being accurate.
      stubFetchSucceeds();
      vi.resetModules();
      const { findExportGlyphLosses } = await import("./render-ats-pdf.ts");

      await expect(findExportGlyphLosses(polish())).resolves.toEqual([]);
    });

    it("reports nothing for a pure-ASCII résumé even when the font fetch fails", async () => {
      // The gate that keeps a font hiccup from blocking every user: Helvetica
      // draws ASCII perfectly, so there is nothing to warn about.
      stubFetchFails();
      vi.resetModules();
      const { findExportGlyphLosses } = await import("./render-ats-pdf.ts");

      await expect(
        findExportGlyphLosses({
          contact: {
            name: "Jane Candidate",
            email: "jane@example.com",
            links: ["linkedin.com/in/jane"],
          },
          summary: "Shipped things. Cut deploy time from 42 minutes to 9.",
          sections: [
            {
              kind: "experience",
              heading: "Experience",
              entries: [
                { headerLine: "Engineer · Acme", bullets: ["Did the work"] },
              ],
            },
          ],
        }),
      ).resolves.toEqual([]);
    });

    it("names the contact field when the fallback would mangle the candidate's name", async () => {
      stubFetchFails();
      vi.resetModules();
      const { findExportGlyphLosses } = await import("./render-ats-pdf.ts");

      const losses = await findExportGlyphLosses(polish());

      expect(losses).toEqual([
        {
          where: "Name",
          original: "ANNA WIŚNIEWSKA",
          degraded: "ANNA WI?NIEWSKA",
        },
      ]);
    });

    it("labels a loss inside a section by that section's own heading", async () => {
      // The label is shown to the user, so it must be their heading — not an
      // index into a model they have never seen.
      stubFetchFails();
      vi.resetModules();
      const { findExportGlyphLosses } = await import("./render-ats-pdf.ts");

      const losses = await findExportGlyphLosses({
        contact: { name: "Jane Candidate", links: [] },
        sections: [
          {
            kind: "experience",
            heading: "Work History",
            entries: [
              {
                headerLine: "Engineer · Acme",
                bullets: ["Migrated ★ to ✓"],
              },
            ],
          },
        ],
      });

      expect(losses.map((l) => l.where)).toEqual(["Work History"]);
      expect(losses[0].degraded).toBe("Migrated ? to ?");
    });

    it("does not report a WinAnsi-representable glyph that merely looks exotic", async () => {
      // An em dash, curly quotes and a bullet ARE valid WinAnsi (cp1252's upper
      // range assigns them), so refusing over them would be a false positive on
      // text the fallback draws correctly.
      stubFetchFails();
      vi.resetModules();
      const { findExportGlyphLosses } = await import("./render-ats-pdf.ts");

      await expect(
        findExportGlyphLosses({
          contact: { name: "Jane “Jay” Candidate — Engineer", links: [] },
          summary: "Led • owned • shipped … end",
          sections: [],
        }),
      ).resolves.toEqual([]);
    });
  });
});
