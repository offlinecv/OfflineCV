// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * #425 — flush-right entry dates + clickable link annotations in the exported
 * ATS PDF. Inspects glyph x-positions and page `/Annots` directly (the shared
 * `extractPdfText` helper only returns text), so these assertions are separate
 * from the text-round-trip suite.
 */

import { describe, expect, it } from "vitest";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";
import type { AtsResumeModel } from "./ats-resume-model.ts";

const PAGE_WIDTH = 612;
const MARGIN = 54;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN; // 558

interface Item {
  str: string;
  x: number;
  width: number;
  y: number;
}

interface Annot {
  url: string;
  rect: number[]; // [x0, y0, x1, y1]
}

async function inspect(
  bytes: Uint8Array,
): Promise<{ items: Item[]; links: string[]; annots: Annot[] }> {
  const pdfjs = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const items: Item[] = [];
  const links: string[] = [];
  const annots: Annot[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items) {
      if ("str" in it) {
        const t = it as { str: string; transform: number[]; width: number };
        items.push({ str: t.str, x: t.transform[4], width: t.width, y: t.transform[5] });
      }
    }
    for (const a of await page.getAnnotations()) {
      const ann = a as {
        subtype?: string;
        url?: string;
        unsafeUrl?: string;
        rect?: number[];
      };
      if (ann.subtype === "Link") {
        const url = ann.url ?? ann.unsafeUrl ?? "";
        links.push(url);
        annots.push({ url, rect: ann.rect ?? [0, 0, 0, 0] });
      }
    }
  }
  return { items, links, annots };
}

const MODEL: AtsResumeModel = {
  contact: {
    name: "Jane Candidate",
    email: "jane@example.com",
    links: ["linkedin.com/in/jane", "github.com/jane"],
  },
  sections: [
    {
      heading: "Experience",
      entries: [
        {
          headerLine: "Senior PM",
          subLine: "Acme · Chicago, IL",
          subLineDate: "2020 – 2023",
          bullets: ["Shipped the thing"],
        },
      ],
    },
  ],
};

describe("renderAtsResumePdf — flush-right dates + link annotations (#425)", () => {
  it("draws the entry date flush-right against the content margin", async () => {
    const { items } = await inspect(await renderAtsResumePdf(MODEL));
    // A year token from the date range, on the right side of the page.
    const dateItems = items.filter((i) => /20(20|23)/.test(i.str) && i.x > 300);
    expect(dateItems.length).toBeGreaterThan(0);
    // The right edge of the rightmost date glyph sits at the content margin.
    const rightEdge = Math.max(...dateItems.map((i) => i.x + i.width));
    expect(Math.abs(rightEdge - RIGHT_EDGE)).toBeLessThan(6);
    // The org text is at the LEFT margin — i.e. the date really is separated far
    // to the right, not glued after it.
    const org = items.find((i) => i.str.includes("Acme"));
    expect(org).toBeDefined();
    expect(org!.x).toBeLessThan(MARGIN + 6);
  });

  it("registers clickable URI link annotations for the contact links", async () => {
    const { links } = await inspect(await renderAtsResumePdf(MODEL));
    expect(links).toContain("https://linkedin.com/in/jane");
    expect(links).toContain("https://github.com/jane");
    expect(links).toContain("mailto:jane@example.com");
  });

  it("places a link whose slug is a substring of the email over its OWN text (#425 #2)", async () => {
    // Website slug `example.com` is a substring of email `jane@example.com`, and
    // the email is drawn first. A naive `indexOf` would land the website rect on
    // the email's domain; the running search offset must put it on the standalone
    // slug — i.e. to the RIGHT of the whole email annotation.
    const model: AtsResumeModel = {
      contact: {
        name: "Jane Candidate",
        email: "jane@example.com",
        links: ["example.com"],
        linkHrefs: ["https://example.com"],
      },
      sections: [],
    };
    const { annots } = await inspect(await renderAtsResumePdf(model));
    const email = annots.find((a) => a.url === "mailto:jane@example.com");
    const site = annots.find((a) => a.url.startsWith("https://example.com"));
    expect(email).toBeDefined();
    expect(site).toBeDefined();
    // The website rect starts at or past the email rect's right edge — it is over
    // the trailing slug, not inside the email's domain.
    expect(site!.rect[0]).toBeGreaterThanOrEqual(email!.rect[2] - 0.5);
  });

  it("targets the ORIGINAL url (www./http preserved) even when the display is stripped (#425 #3)", async () => {
    // Display is `www.`-less / scheme-less; the click target must keep the
    // original `www.` and `http` so a www-only or http-only host still resolves.
    const model: AtsResumeModel = {
      contact: {
        name: "Jane Candidate",
        links: ["jane.dev", "portfolio.example"],
        linkHrefs: ["https://www.jane.dev", "http://portfolio.example"],
      },
      sections: [],
    };
    // pdfjs may normalize a bare-host URL with a trailing slash, so match on the
    // scheme+host rather than an exact string.
    const { links } = await inspect(await renderAtsResumePdf(model));
    expect(links.some((u) => u.startsWith("https://www.jane.dev"))).toBe(true);
    expect(links.some((u) => u.startsWith("http://portfolio.example"))).toBe(true);
    // The naive display-rebuilt targets (www dropped, forced https) must NOT appear.
    expect(links.some((u) => u.startsWith("https://jane.dev"))).toBe(false);
    expect(links.some((u) => u.startsWith("https://portfolio.example"))).toBe(false);
  });
});
