// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the fixture-PII gate (#478).
 *
 * The phone rule carries the weight here. `(312) 555-0123` must pass and
 * `(555) 018-2390` must fail — those two cases are the whole point of the
 * check, because the second one is the violation that actually walked into the
 * corpus while the rule was written down in three separate places.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkFixture,
  extractPdf,
  findPhoneCandidates,
  flattenInfoValues,
  flattenOutline,
  isPolicyCompliantPhone,
  normalizeForScan,
} from "./check-fixture-pii.mjs";

describe("isPolicyCompliantPhone", () => {
  it("accepts the mandated shape: real area code + 555 exchange + 0100-0199", () => {
    expect(isPolicyCompliantPhone("(312) 555-0123")).toBe(true);
  });

  it("rejects (555) 018-2390 — 555 is an invalid NANP area code", () => {
    // The founding bug. libphonenumber-js rejects an area-code-555 number, so
    // this fixture's phone was silently dropping out of the Completeness score.
    expect(isPolicyCompliantPhone("(555) 018-2390")).toBe(false);
  });

  it("rejects (555) 555-0123 — the naive-check bypass", () => {
    // Exchange and subscriber are both correct here, and 555 even satisfies the
    // NANP area-code SHAPE ([2-9][0-8][0-9]). Only the explicit area !== "555"
    // reject catches it. If this test goes green after someone "simplifies" the
    // predicate, the gate has been defeated.
    expect(isPolicyCompliantPhone("(555) 555-0123")).toBe(false);
  });

  it("rejects a real area code with a subscriber outside 0100-0199", () => {
    // 909-555-5555: fictional only by convention — 555-5555 is not in the
    // reserved block and could be assigned to a real line.
    expect(isPolicyCompliantPhone("(909) 555-5555")).toBe(false);
    expect(isPolicyCompliantPhone("(312) 555-0200")).toBe(false);
    expect(isPolicyCompliantPhone("(312) 555-0099")).toBe(false);
  });

  it("accepts both ends of the reserved 0100-0199 block", () => {
    expect(isPolicyCompliantPhone("(312) 555-0100")).toBe(true);
    expect(isPolicyCompliantPhone("(312) 555-0199")).toBe(true);
  });

  it("rejects a non-555 exchange even in a real area code", () => {
    expect(isPolicyCompliantPhone("(312) 867-0123")).toBe(false);
  });

  it("rejects structurally invalid NANP area codes", () => {
    expect(isPolicyCompliantPhone("(012) 555-0123")).toBe(false); // leading 0
    expect(isPolicyCompliantPhone("(190) 555-0123")).toBe(false); // leading 1
    expect(isPolicyCompliantPhone("(911) 555-0123")).toBe(false); // N11 service code
  });

  it("accepts the mandated shape in any punctuation, incl. a +1 country code", () => {
    for (const form of [
      "312-555-0123",
      "312.555.0123",
      "(312) 555-0123",
      "+1 (312) 555-0123",
      "+1 312 555 0123",
      "1-312-555-0123",
    ]) {
      expect(isPolicyCompliantPhone(form), form).toBe(true);
    }
  });

  it("rejects a 7-digit local number (the parser drops it — see the corpus README)", () => {
    expect(isPolicyCompliantPhone("555-0123")).toBe(false);
  });
});

describe("findPhoneCandidates", () => {
  it("finds a BAD phone, not just a good one", () => {
    // The core design constraint. A scanner that only matched the good shape
    // would find nothing here, conclude "no phone present", and pass the file.
    expect(findPhoneCandidates("call (555) 018-2390 now")).toEqual([
      "(555) 018-2390",
    ]);
  });

  it("reassembles a phone that a word processor mangled", () => {
    // Verbatim from openresume-laverne-word-quartz.pdf: Word splits the number
    // across three pdfjs text items (11-13) and separates it with
    // U+002D U+00AD U+2010, so a per-item scan sees no phone at all.
    const mangled = "(909) 555" + "-­‐" + "5555";
    const [found] = findPhoneCandidates(mangled);
    expect(found).toBeDefined();
    expect(isPolicyCompliantPhone(found)).toBe(false);
  });

  it("survives a non-breaking space between the groups", () => {
    const [found] = findPhoneCandidates("(312) 555‑0123");
    expect(isPolicyCompliantPhone(found)).toBe(true);
  });

  it("does not match prose numbers that merely look numeric", () => {
    const prose =
      "Cut p99 latency from 940ms to 210ms across 200+ services in 03/2021.";
    expect(findPhoneCandidates(prose)).toEqual([]);
  });

  // Every case below PASSED the gate before #478's review: each is a phone the
  // old candidate pattern could not see, so a fixture carrying only that phone
  // produced zero candidates, read as "no phone present", and shipped.
  describe("evasions — a phone the scanner cannot see is a phone that ships", () => {
    it("finds a CONTIGUOUS 10-digit run (no separators at all)", () => {
      // The old pattern REQUIRED a separator before the last four digits.
      const [found] = findPhoneCandidates("reach me at 2017032021 anytime");
      expect(found).toBe("2017032021");
      expect(isPolicyCompliantPhone(found)).toBe(false);
    });

    it("finds E.164", () => {
      const [found] = findPhoneCandidates("+12017032021");
      expect(found).toBeDefined();
      expect(isPolicyCompliantPhone(found)).toBe(false);
    });

    it("finds a non-NANP international number", () => {
      // The old country-code group only accepted `+1`, so any foreign number
      // was invisible. These must be FOUND (so they can be judged) and REJECTED
      // (they are not the mandated US fictional shape).
      for (const intl of ["+91 98765 43210", "+44 20 7946 0958"]) {
        const [found] = findPhoneCandidates(`call ${intl} please`);
        expect(found, intl).toBeDefined();
        expect(isPolicyCompliantPhone(found), intl).toBe(false);
      }
    });

    it("finds exotic separators, incl. the middot a real fixture's contact line uses", () => {
      // The old separator class was `[\s.\-]` only.
      for (const raw of ["201·703·2021", "201/703/2021", "201•703•2021"]) {
        const [found] = findPhoneCandidates(raw);
        expect(found, raw).toBeDefined();
        expect(isPolicyCompliantPhone(found), raw).toBe(false);
      }
    });

    it("finds a phone whose groups are separated by a WIDE run", () => {
      // The separator run is `{0,8}`, not `{0,3}`. A column-aligned or
      // multiply-punctuated number evaded the narrower bound entirely — and the
      // 3-3-4 grouping, not the run width, is what keeps date ranges out.
      for (const raw of ["312    867    5309", "312 -- - 867-5309"]) {
        const [found] = findPhoneCandidates(raw);
        expect(found, raw).toBeDefined();
        expect(isPolicyCompliantPhone(found), raw).toBe(false);
      }
    });

    it("finds a FULLWIDTH number a CJK-locale word processor emitted", () => {
      // Fullwidth digits are not `\d`, so before the fold this produced ZERO
      // candidates — read by the gate as "no phone present", and passed.
      const [found] = findPhoneCandidates("＋１ ３１２ ８６７ ５３０９");
      expect(found).toBeDefined();
      expect(isPolicyCompliantPhone(found)).toBe(false);

      // Fullwidth parens evade the pattern the same way.
      const [parens] = findPhoneCandidates("（５５５）０１８−２３９０");
      expect(parens).toBeDefined();
      expect(isPolicyCompliantPhone(parens)).toBe(false);
    });

    it("finds the area-code-555 number carried as a tel: link annotation", () => {
      // Verbatim from awesome-cv-cv.pdf's `tel:` href, which no text-only
      // scanner ever saw. The body text showed a COMPLIANT number; the hyperlink
      // did not. Both fixtures passed the gate until annotations were scanned.
      const [found] = findPhoneCandidates(" +15550100123");
      expect(found).toBeDefined();
      expect(isPolicyCompliantPhone(found)).toBe(false);
    });
  });

  // The other half of the contract. `libphonenumber-js`'s `findNumbers` folds a
  // date range into a "valid" US number (`06/2017 - 03/2021` -> +12017032021),
  // which is why it cannot be the candidate detector: four clean fixtures carry
  // ranges like these, and the gate must stay green on them. The 3-3-4 grouping
  // is what keeps them out. If these go red, the gate fails the whole corpus.
  describe("date ranges are not phones", () => {
    it("does not fold an experience date range into a phone", () => {
      for (const range of [
        "06/2017 - 03/2021",
        "06/2017 – 03/2021",
        "Jan 2019 - Mar 2021",
        "2016 - 2018",
        "01/02/2021",
      ]) {
        expect(findPhoneCandidates(range), range).toEqual([]);
      }
    });

    it("does not match a street address or ZIP", () => {
      expect(
        findPhoneCandidates("123 Example Way, Springfield, IL 62701"),
      ).toEqual([]);
    });
  });
});

describe("normalizeForScan", () => {
  it("drops invisibles and folds unicode dashes/spaces to ASCII", () => {
    expect(normalizeForScan("a​b")).toBe("ab");
    expect(normalizeForScan("a—b")).toBe("a-b");
    expect(normalizeForScan("a b")).toBe("a b");
  });
});

describe("flattenInfoValues", () => {
  it("reaches into the nested Custom object and ignores non-strings", () => {
    expect(
      flattenInfoValues({
        Title: "resume",
        IsLinearized: false, // pdfjs booleans
        Language: null,
        Trapped: { name: "False" },
        Custom: { "PTEX.FullBanner": "This is LuaHBTeX", Manager: "posquit0" },
      }).sort(),
    ).toEqual(["False", "This is LuaHBTeX", "posquit0", "resume"].sort());
  });
});

describe("checkFixture", () => {
  const clean = {
    relPath: "unknown/some-fixture.pdf",
    text: "Jane Smith\n(312) 555-0123 · jane.smith@example.com · Chicago, IL",
    author: "",
  };

  it("passes a fully synthetic persona", () => {
    expect(checkFixture(clean)).toEqual([]);
  });

  it("passes a fixture with no phone at all (absent is fine, invalid is not)", () => {
    const noPhone = { ...clean, text: "Jane Smith\njane.smith@example.com" };
    expect(checkFixture(noPhone)).toEqual([]);
  });

  it("fails a fixture whose only phone is invalid", () => {
    const bad = {
      ...clean,
      text: "Jordan Avery\n(555) 018-2390 · jordan.avery@example.com",
    };
    const failures = checkFixture(bad);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("(555) 018-2390");
  });

  it("fails a fixture with no @example.com email", () => {
    const bad = { ...clean, text: "Jane Smith\n(312) 555-0123 · jane@acme.io" };
    expect(checkFixture(bad).join("\n")).toContain("no @example.com email");
  });

  it("fails a real email even when a synthetic one is also present", () => {
    const bad = {
      ...clean,
      text: `${clean.text}\nalt: jane.smith@acme.io`,
    };
    expect(checkFixture(bad).join("\n")).toContain("jane.smith@acme.io");
  });

  it("fails a denylisted real persona from an OSS template's demo résumé", () => {
    const bad = { ...clean, text: `${clean.text}\nposquit0` };
    expect(checkFixture(bad).join("\n")).toContain("posquit0");
  });

  it("fails a metadata Author that names whoever exported the file", () => {
    const bad = { ...clean, author: "Real Person" };
    expect(checkFixture(bad).join("\n")).toContain("Real Person");
  });

  it("fails an XMP dc:creator too — body text alone is not the whole surface", () => {
    const bad = { ...clean, xmpCreator: "Real Person" };
    expect(checkFixture(bad).join("\n")).toContain("dc:creator");
  });

  it("allows an obviously synthetic Author", () => {
    expect(checkFixture({ ...clean, author: "anonymous" })).toEqual([]);
  });

  it("scopes an exception to its own file — the same value fails elsewhere", () => {
    // The exception table is the gate's only hole, so its narrowness is a
    // tested property: the excepted address must NOT become globally allowed.
    const excepted = {
      relPath: "word/openresume-laverne-word-quartz.pdf",
      text: "Leo Leopard\nlleopard@laverne.edu\n(909) 555-5555",
      author: "",
    };
    // In its own file, the two pinned values are tolerated.
    expect(checkFixture(excepted)).toEqual([]);

    // The identical content in ANY other file still fails on both counts.
    const elsewhere = { ...excepted, relPath: "unknown/other.pdf" };
    const failures = checkFixture(elsewhere).join("\n");
    expect(failures).toContain("lleopard@laverne.edu");
    expect(failures).toContain("(909) 555-5555");
  });

  it("does not let an exception excuse an UNPINNED value in the same file", () => {
    const bad = {
      relPath: "word/openresume-laverne-word-quartz.pdf",
      text: "Leo Leopard\nlleopard@laverne.edu\n(909) 555-5555\nreal.person@gmail.com",
      author: "",
    };
    expect(checkFixture(bad).join("\n")).toContain("real.person@gmail.com");
  });

  it("catches a bad phone reachable ONLY through a tel: link annotation", () => {
    // The caller folds annotation URLs into `text` with the scheme stripped.
    // Body text here is fully compliant — exactly the awesome-cv situation,
    // where the drawn number was clean and only the hyperlink leaked.
    const bad = {
      ...clean,
      text: `${clean.text}\n +15550100123`,
    };
    expect(checkFixture(bad).join("\n")).toContain("+15550100123");
  });

  it("catches PII parked in metadata the renderer never draws", () => {
    // Rule 4 judges Author/dc:creator as a NAME; this is the other half — the
    // email/phone/denylist rules run over the whole metadata blob, because
    // Title/Subject/Keywords are where Word and Google Docs stash a person.
    const badEmail = { ...clean, metadata: "Title: resume of real.person@acme.io" };
    expect(checkFixture(badEmail).join("\n")).toContain("real.person@acme.io");

    const badPhone = { ...clean, metadata: "Subject: call (555) 018-2390" };
    expect(checkFixture(badPhone).join("\n")).toContain("(555) 018-2390");

    const badPersona = { ...clean, metadata: "Keywords: posquit0" };
    expect(checkFixture(badPersona).join("\n")).toContain("posquit0");
  });

  it("catches PII parked in a NON-STANDARD Info key (pdfjs nests these under Custom)", () => {
    // pdfjs buckets every non-standard Info key into a nested `Custom` OBJECT,
    // which a `typeof value === "string"` filter drops on the floor. Word parks
    // people in exactly these keys (/Company, /Manager). Before the flatten, a
    // PDF carrying all three of these PASSED the gate — email domain, persona
    // denylist and phone shape defeated at once.
    const metadata = flattenInfoValues({
      Title: "resume",
      Custom: {
        Company: "Real Person <real.person@acme.io>",
        Manager: "posquit0",
        Contact: "(555) 018-2390",
      },
    }).join("\n");

    const failures = checkFixture({ ...clean, metadata }).join("\n");
    expect(failures).toContain("real.person@acme.io");
    expect(failures).toContain("posquit0");
    expect(failures).toContain("(555) 018-2390");
  });

  it("noText waives ONLY the email-presence rule, not the other rules", () => {
    const relPath = "unknown/scanned.pdf";

    // Without the waiver, a legitimately text-free (image-only) fixture cannot
    // pass rule 1 at all, and no re-export can give it an email to find.
    expect(checkFixture({ relPath, text: "", author: "" }).join("\n")).toContain(
      "no @example.com email",
    );

    const waived = {
      [relPath]: { noText: true, reason: "image-only scan, no text layer" },
    };
    expect(checkFixture({ relPath, text: "", author: "" }, waived)).toEqual([]);

    // The waiver is narrow: it excuses only ABSENCE. A bad value the file does
    // carry (here, in metadata) still fails.
    const stillFails = checkFixture(
      { relPath, text: "", author: "", metadata: "real.person@acme.io" },
      waived,
    );
    expect(stillFails.join("\n")).toContain("real.person@acme.io");
  });

  it("does not flag an @example.com address fused with the next glyph run", () => {
    // Tight item concatenation produces `…@example.comAustin`. That is the
    // synthetic address plus the following drawn word, not a real domain.
    const fused = { ...clean, text: "Jane Smith\njane.smith@example.comAustin, TX" };
    expect(checkFixture(fused)).toEqual([]);

    // But a genuinely different lowercase domain is still a failure.
    const real = { ...clean, text: "Jane Smith\njane.smith@example.community" };
    expect(checkFixture(real).join("\n")).toContain("example.community");
  });

  it("backstops a denylisted persona whose words got an extra space", () => {
    // The denylist is a lowercased SUBSTRING test, so `Byungjin  Park` (double
    // space — what a tight pdfjs concat or a column-aligned header produces) does
    // not contain the two-word entry. The single-token backstop is what catches
    // it, and `Debarghya Das` had one while `Byungjin Park` did not.
    for (const spelling of ["Byungjin  Park", "Debarghya\nDas"]) {
      const bad = { ...clean, text: `${clean.text}\n${spelling}` };
      expect(checkFixture(bad).length, spelling).toBeGreaterThan(0);
    }
  });
});

describe("flattenOutline", () => {
  it("walks the whole TREE, not just the top level", () => {
    expect(
      flattenOutline([
        { title: "Education", items: [] },
        {
          title: "Experience",
          items: [{ title: "Real Person", url: "mailto:real.person@acme.io" }],
        },
      ]),
    ).toEqual(["Education", "Experience", "Real Person", " real.person@acme.io"]);
  });

  it("tolerates a PDF with no outline at all", () => {
    expect(flattenOutline(null)).toEqual([]);
  });
});

// ── Integration: the REAL extractPdf, over real PDF bytes ───────────────────

/**
 * Every bug this gate has shipped lived in `extractPdf` — the I/O layer — and
 * NONE of them could have been caught by the unit tests above, which hand
 * `checkFixture` a PRE-FOLDED string and thereby ASSUME the caller folds that
 * surface in. Nothing asserted it did. Rounds 1 (link annotations), 2
 * (`info.Custom`) and 3 (annotation contents/title, AcroForm values, the outline
 * tree, embedded attachments) were all extraction misses, and all three were
 * reintroducible with the whole suite still green.
 *
 * So these tests run the real `extractPdf` against real bytes: one PDF per
 * surface, each DRAWING a fully compliant persona on the page while parking a
 * leak on the surface under test. The baseline test below pins that the drawn
 * persona alone yields ZERO failures, so any failure here can only have come
 * through the surface. Drop a surface from `extractPdf` and one of these goes
 * red — which is the property the unit tests could not have.
 *
 * The PDFs are written to a temp dir, never under `tests/fixtures/pdfs/`: the
 * gate walks that tree, and a fixture that deliberately carries PII would be a
 * self-defeating thing to commit into the corpus it exists to police.
 */
describe("extractPdf (integration — the surfaces a leak actually hides on)", () => {
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fixture-pii-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A minimal but structurally valid single-page PDF, assembled from raw object
   * bodies with a real xref table. Hand-built rather than produced with `pdf-lib`
   * because these need object-level control (an Info `/Custom` key, an outline
   * tree, an `/EmbeddedFiles` name tree) that a document-authoring API does not
   * expose. Objects 1-5 are the page; 6 is Info; extras start at 7.
   */
  function buildPdf({
    catalogExtra = "",
    pageExtra = "",
    info = "",
    extraObjects = [],
  } = {}) {
    // The drawn persona: compliant email + compliant phone. Parens are escaped
    // because they delimit a PDF string literal.
    const drawn =
      "BT /F1 12 Tf 72 720 Td (Jane Smith) Tj " +
      "0 -16 Td (\\(312\\) 555-0123 jane.smith@example.com) Tj ET";

    const objects = [
      `<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`,
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R${pageExtra} >>`,
      `<< /Length ${drawn.length} >>\nstream\n${drawn}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< ${info} >>`,
      ...extraObjects,
    ];

    let pdf = "%PDF-1.7\n";
    const offsets = [];
    for (const [i, object] of objects.entries()) {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    }

    const startxref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pdf +=
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n` +
      `startxref\n${startxref}\n%%EOF\n`;

    // latin1: byte length must equal string length or every xref offset is wrong.
    return Buffer.from(pdf, "latin1");
  }

  /** Build the PDF, run it through the REAL extractor, then the real rules. */
  async function failuresFor(name, spec) {
    const path = join(dir, name);
    writeFileSync(path, buildPdf(spec));
    return checkFixture({ relPath: `integration/${name}`, ...(await extractPdf(path)) });
  }

  it("baseline: the drawn persona alone is clean (so any failure below is the surface)", async () => {
    expect(await failuresFor("baseline.pdf", {})).toEqual([]);
  });

  it("catches a phone reachable only through a tel: LINK ANNOTATION", async () => {
    const failures = await failuresFor("link-annot.pdf", {
      pageExtra: " /Annots [7 0 R]",
      extraObjects: [
        "<< /Type /Annot /Subtype /Link /Rect [72 700 200 716] " +
          "/A << /S /URI /URI (tel:+15550182390) >> >>",
      ],
    });
    expect(failures.join("\n")).toContain("5550182390");
  });

  it("catches PII in a NON-STANDARD Info key (pdfjs nests it under Custom)", async () => {
    const failures = await failuresFor("info-custom.pdf", {
      info: "/Company (Real Person <real.person@acme.io>)",
    });
    expect(failures.join("\n")).toContain("real.person@acme.io");
  });

  it("catches PII in an ANNOTATION's contents (a sticky note's body)", async () => {
    const failures = await failuresFor("annot-contents.pdf", {
      pageExtra: " /Annots [7 0 R]",
      extraObjects: [
        "<< /Type /Annot /Subtype /Text /Rect [72 700 92 716] " +
          "/Contents (follow up: real.person@acme.io) >>",
      ],
    });
    expect(failures.join("\n")).toContain("real.person@acme.io");
  });

  it("catches PII in an ANNOTATION's title (the commenter's own name)", async () => {
    // Every PDF reviewer tool stamps /T with the real name of whoever commented.
    const failures = await failuresFor("annot-title.pdf", {
      pageExtra: " /Annots [7 0 R]",
      extraObjects: [
        "<< /Type /Annot /Subtype /Text /Rect [72 700 92 716] " +
          "/Contents (looks good) /T (Byungjin  Park) >>",
      ],
    });
    expect(failures.join("\n")).toContain("yungjin");
  });

  it("catches PII in an ACROFORM widget's value and tooltip", async () => {
    const failures = await failuresFor("acroform.pdf", {
      catalogExtra:
        " /AcroForm << /Fields [7 0 R] /DA (/Helv 0 Tf 0 g) " +
        "/DR << /Font << /Helv 5 0 R >> >> >>",
      pageExtra: " /Annots [7 0 R]",
      extraObjects: [
        "<< /Type /Annot /Subtype /Widget /FT /Tx /T (contact) /F 4 " +
          "/Rect [72 660 300 680] /DA (/Helv 0 Tf 0 g) " +
          "/V (real.person@acme.io) /TU (call \\(555\\) 018-2390) >>",
      ],
    });
    expect(failures.join("\n")).toContain("real.person@acme.io"); // fieldValue
    expect(failures.join("\n")).toContain("018-2390"); // alternativeText (/TU)
  });

  it("catches a name in the OUTLINE tree — and walks it RECURSIVELY", async () => {
    // Word builds bookmarks from Heading 1, which on a résumé is the owner's
    // name, and the outline survives a body-text scrub. The leak is on a NESTED
    // item, so only the recursive walk finds it.
    const failures = await failuresFor("outline.pdf", {
      catalogExtra: " /Outlines 7 0 R",
      extraObjects: [
        "<< /Type /Outlines /First 8 0 R /Last 8 0 R /Count 2 >>",
        "<< /Title (Experience) /Parent 7 0 R /First 9 0 R /Last 9 0 R " +
          "/Count 1 /Dest [3 0 R /Fit] >>",
        "<< /Title (Debarghya Das) /Parent 8 0 R /Dest [3 0 R /Fit] >>",
      ],
    });
    expect(failures.join("\n")).toContain("Debarghya Das");
  });

  it("catches PII in an embedded ATTACHMENT's filename", async () => {
    const failures = await failuresFor("attachment-name.pdf", {
      catalogExtra:
        " /Names << /EmbeddedFiles << /Names [(real.person@acme.io.txt) 7 0 R] >> >>",
      extraObjects: [
        "<< /Type /Filespec /F (real.person@acme.io.txt) " +
          "/UF (real.person@acme.io.txt) /EF << /F 8 0 R >> >>",
        "<< /Type /EmbeddedFile /Length 6 >>\nstream\nnotes\nendstream",
      ],
    });
    expect(failures.join("\n")).toContain("real.person@acme.io");
  });

  it("catches PII in an embedded ATTACHMENT's BYTES", async () => {
    // An attachment is a whole second document riding inside the fixture. Its
    // filename here is innocuous; the leak is only in the content.
    const body = "Byungjin Park\ncall (555) 018-2390\n";
    const failures = await failuresFor("attachment-bytes.pdf", {
      catalogExtra:
        " /Names << /EmbeddedFiles << /Names [(notes.txt) 7 0 R] >> >>",
      extraObjects: [
        "<< /Type /Filespec /F (notes.txt) /UF (notes.txt) /EF << /F 8 0 R >> >>",
        `<< /Type /EmbeddedFile /Length ${body.length} >>\nstream\n${body}\nendstream`,
      ],
    });
    expect(failures.join("\n")).toContain("018-2390");
    expect(failures.join("\n")).toContain("yungjin");
  });
});
