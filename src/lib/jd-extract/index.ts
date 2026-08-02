// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// The public surface of the JD-extraction lane, and the entry point that gets
// bundled for injection into a live page.
//
// **This barrel is deliberately partial: it does not re-export `./ats-api.ts`.**
// That module imports `src/lib/jd-match/fetch-jd.ts`, which owns live `fetch()`
// calls — and this file is bundled and injected into whatever page the user is
// looking at. Re-exporting it would pull a network primitive into the injected
// payload, breaking the boundary #704 established and adding weight to a bundle
// that crosses a tool boundary on every single posting. App code that wants the
// full ladder imports `./ats-api` directly and gets a compile-time-obvious
// dependency on the network for doing so.
//
// The skill and the extension inject this bundle and call `extract()`, so both run
// the same code the app runs — one implementation, three consumers, which is the
// whole reason this lane exists (`src/lib/storage/job-url.ts` makes the same
// argument for id derivation).
//
// Build it with:
//
//   node_modules/.bin/esbuild src/lib/jd-extract/index.ts \
//     --bundle --format=iife --global-name=JD --minify \
//     --outfile="$SCRATCH/jd-extract.js" --log-level=error
//
// then, in the page:
//
//   <bundle>;
//   JSON.stringify(await JD.extract(document, new URL(location.href)))
//
// Injecting rather than shipping the page's HTML back out is a deliberate cost
// decision: a LinkedIn job page is 1–2 MB of HTML, and moving that across a tool
// boundary per posting dwarfs the ~21 KB bundle. The injected form returns ~1 KB.

// The surface below is kept deliberately small. It is a contract with a caller
// that is NOT type-checked against it — the skill injects this bundle as a string
// and calls `JD.extract(...)`, so every name here is one a compiler will never
// verify for anyone. Re-exporting the lane's internals would multiply that
// unchecked surface for no gain: app code in this repo imports lib modules by
// path (`../jd-extract/html-to-markdown`), and only the injected caller needs a
// barrel at all.

/** The primary call: a document and its URL in, a posting or `null` out. */
export { extractPostingFromDocument as extract } from "./detect";

/**
 * Canonical-URL discovery on its own, for a caller that wants to collapse an
 * aggregator listing onto its ATS original without paying for a full extraction.
 */
export { extractApplyLink, extractApplyLinkAsync } from "./apply-link";
export type { ApplyLinkResult } from "./apply-link";

export { EXTRACTION_ALGORITHM_VERSION } from "./types";
export type { ATSExtractor, ExtractedPosting, ExtractionTier } from "./types";
