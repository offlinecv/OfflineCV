// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// @vitest-environment jsdom

/**
 * The barrel's public surface.
 *
 * This file is the entry point esbuild bundles for injection into a live page, so
 * its exports are a contract with code that is *not* type-checked against it: the
 * `job-hunt` skill calls `JD.extract(...)` from a string injected through a browser
 * tool. Renaming or dropping an export here breaks that caller silently, and no
 * compiler anywhere would notice — hence asserting the surface directly.
 *
 * It also pins the boundary that keeps the bundle injectable: nothing reachable
 * from here may pull in `fetch()`. That is why `./ats-api.ts` is deliberately
 * absent from the barrel.
 */

import * as JD from "./index";
import { EXTRACTION_ALGORITHM_VERSION } from "./types";

describe("the injected entry point", () => {
  it("exposes extract() as the primary call", () => {
    expect(typeof JD.extract).toBe("function");
  });

  it("extracts a posting through the barrel, the way the skill calls it", async () => {
    const html =
      `<html><head><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "JobPosting",
        title: "Staff Engineer",
        hiringOrganization: { "@type": "Organization", name: "Acme" },
        description: "<p>Build things.</p><ul><li>5 years TypeScript</li></ul>",
      })}</script></head><body></body></html>`;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const result = await JD.extract(doc, new URL("https://careers.acme.com/jobs/1"));

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Staff Engineer");
    expect(result!.body).toContain("- 5 years TypeScript");
    expect(result!.algorithmVersion).toBe(EXTRACTION_ALGORITHM_VERSION);
  });

  // The result crosses a tool boundary as JSON, so it must survive a round trip —
  // no functions, no cycles, no undefined-only payload.
  it("returns a JSON-serializable result", async () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><h1>Platform Engineer</h1><main><p>Job description. Responsibilities and requirements. Equal opportunity employer. Build reliable systems at scale.</p><ul><li>Kubernetes</li></ul></main></body></html>`,
      "text/html",
    );
    const result = await JD.extract(doc, new URL("https://careers.acme.com/jobs/9"));

    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped.title).toBe("Platform Engineer");
    expect(roundTripped.body).toContain("- Kubernetes");
  });
});

describe("the barrel's export surface", () => {
  it.each(["extract", "extractApplyLink", "extractApplyLinkAsync", "toJobRecord"])(
    "exports %s as a function",
    (name) => {
      expect(typeof (JD as unknown as Record<string, unknown>)[name]).toBe("function");
    },
  );

  it("exports the algorithm version", () => {
    expect(JD.EXTRACTION_ALGORITHM_VERSION).toBe(EXTRACTION_ALGORITHM_VERSION);
  });

  // The surface is intentionally minimal — it is unchecked by any compiler for
  // the injected caller, so every extra name is unverified surface for no gain.
  it("keeps the runtime surface to the documented names", () => {
    expect(Object.keys(JD).sort()).toEqual([
      "EXTRACTION_ALGORITHM_VERSION",
      "POSTING_FACT_FIELDS",
      "extract",
      "extractApplyLink",
      "extractApplyLinkAsync",
      "toJobRecord",
    ]);
  });

  // `ats-api.ts` imports `fetch-jd.ts`, which owns live fetch() calls. Re-exporting
  // it here would pull a network primitive into the injected payload and break the
  // boundary #704 established.
  it("does not re-export the network-bound ats_api tier", () => {
    const surface = JD as unknown as Record<string, unknown>;
    expect(surface.extractPosting).toBeUndefined();
    expect(surface.extractPostingFromAtsApi).toBeUndefined();
    expect(surface.isAtsApiUrl).toBeUndefined();
  });
});
