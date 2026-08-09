// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `@offlinecv/core/job-search` — the job-board provider adapters, and the
 * **deliberately network-bearing** half of this package.
 *
 * Everything reachable from here fetches. That is not a defect being disclosed;
 * it is the entire product of the module. A `JobProvider` exists to call a
 * public job feed over HTTPS and map the response into `JobPosting`, so a
 * consumer importing this subpath is asking for exactly one thing: outbound
 * requests to third-party job boards.
 *
 * ## Why this is a separate subpath and not part of the main barrel
 *
 * `./index.ts` — the `.` entry, this file's sibling — makes a measured
 * claim: the value-edge closure of its specifiers reaches no `fetch` /
 * `WebSocket` / `XMLHttpRequest` / `EventSource` at all. That claim is not
 * decoration. The consumer this package was cut for is a private browser
 * extension, and its `no-network.test.ts` walks the transitive import graph
 * from each of its
 * entry points — content scripts, side panel, options page, offscreen document
 * — through its single seam file `src/offlinecv-core.ts`, and asserts that the
 * network primitives it reaches are exactly an allow-list of one. A content
 * script that can reach `fetch` runs in `offlinecv.org`'s address space with a
 * network primitive in scope, which in that repo is a shipped privacy defect
 * rather than a lint finding.
 *
 * So exporting the adapters from the main barrel would not have been a wider
 * surface — it would have been a **broken gate**. The barrel's own rule 1
 * ("import the FILE, never the slice barrel") exists because
 * `src/lib/jd-match/index.ts` re-exports `fetch-jd.ts`; routing one coverage
 * function through that barrel would have dragged a network primitive onto the
 * consumer's audited graph for nothing. Adding the providers to the same entry
 * would have done it deliberately, for every importer, including the four that
 * must never have it.
 *
 * A second subpath is what lets both facts be true at once. `.` stays exactly
 * as network-free as it was; a consumer that wants the feeds names them, and
 * naming them is visible in its own import graph.
 *
 * ## What a consumer auditing its import graph has to do
 *
 * **Keep this specifier off any graph that must stay network-free.** There is no
 * subset of this module that is safe for such a graph — `getProviders` returns
 * objects whose `search` is a `fetch` — so the audit is per-entry-point, not
 * per-symbol. In the extension that means the service worker (the one context
 * where `fetch` is un-banned) and nothing else.
 *
 * Two mechanical consequences for that consumer, both worth knowing before the
 * first import rather than after the gate goes red:
 *
 *  - Its walker follows relative specifiers only, filing every bare one into an
 *    `externals` list it asserts by whole-list equality; it does not resolve
 *    `@offlinecv/core` through `exports` today, because the extension reaches
 *    this repo by relative path through its `src/offlinecv-core.ts` seam. A
 *    consumer that switches to the package specifier has to teach the walker
 *    `exports` resolution for **both** keys — a subpath is a different key from
 *    `.` — or this whole closure drops out of the graph it was added to audit,
 *    and has to add the new specifier to the externals list.
 *  - Its network allow-list is compared for equality, so the worker graph will
 *    need an explicit entry per fetching module reached here. That is the
 *    correct shape: an allow-list naming the file and the primitive, never a
 *    loosened pattern.
 *
 * ## Rule 1 still holds, and was checked rather than assumed
 *
 * `KEYLESS_PROVIDERS` and `getProviders` are taken from
 * `src/lib/job-search/providers/index.ts`, which is a barrel by filename only:
 * it contains no `export … from` statement and **defines** both symbols itself.
 * Its imports are the six adapter files (value) plus `JobProvider` and
 * `CompanyEntry` (`import type`, so erased under `verbatimModuleSyntax`). Taking
 * the symbols from that file therefore drags nothing the three named adapter
 * files below would not have dragged anyway — measured, not reasoned: the
 * value-edge closure of this entry is 11 modules, adding nothing beyond the six
 * adapters, their shared keyword helper, and the HTML-stripper those adapters
 * reach.
 *
 * ## The one import here that surprises people
 *
 * Every adapter takes `htmlToPlaintext` from `src/lib/jd-match/fetch-jd.ts`,
 * which re-exports it from `html-to-plaintext.ts` and also holds this app's live
 * ATS-hydration `fetch(` calls. On any other graph that would be rule 1's exact
 * failure. Here it changes nothing that could be changed: the adapters fetch on
 * their own account, so `fetch-jd.ts` adds no capability this closure did not
 * already have. It is named rather than quietly tolerated because a reader
 * comparing this closure against the main barrel's will find it, and should
 * find the reason next to it.
 *
 * ## Privacy: what actually leaves
 *
 * Unchanged from the in-app lane, and `src/lib/job-search/CLAUDE.md` is
 * normative for it. The keyless aggregator feeds egress a short **keyword
 * string** derived from the user-editable query title/skills
 * (`providers/keywords.ts`, the sole resume-derived egress helper in the repo) —
 * never résumé text. The company-board adapters egress only the **public company
 * slug** plus static caps. A consumer that builds a `JobQuery` out of anything
 * richer than that widens the egress this repo's copy is written against.
 */

/**
 * The fan-out registry.
 *
 * `getProviders` is the single seam that decides who participates in a search —
 * the always-on keyless feeds, plus any company-board providers the caller
 * passes in. Called with no argument it answers exactly `KEYLESS_PROVIDERS`,
 * which is the shape a poller with no company selection wants.
 *
 * `KEYLESS_PROVIDERS` is exported alongside it so a consumer can name the
 * always-on set — for a per-provider concurrency budget, say, or a degraded
 * notice — without a call whose default it would then have to trust.
 */
export { KEYLESS_PROVIDERS, getProviders } from "../../../src/lib/job-search/providers/index.ts";

/**
 * The three company ATS-board factories, one per vendor, each taking the public
 * board slug and the display name to label results with.
 *
 * The registry's own `makeCompanyProvider` dispatches to these from a
 * `CompanyEntry`, and is deliberately NOT on this surface: an entry carries a
 * `sectors` list that only means something to the in-app sector selector, so a
 * consumer holding a slug and a vendor would have to invent `sectors: []` to
 * satisfy a type it has no use for. These three take what such a consumer
 * actually has.
 *
 * `hydrateGreenhouse` and `hydrateLever` are not optional extras. Greenhouse has
 * no server-side search, so `search()` fetches the LIGHT index and every posting
 * comes back with `description: ""`; Lever's inline description is stripped on a
 * cached board. A consumer that ranks on description and skips the hydrate step
 * is ranking every company posting against an empty string — so the pair ships
 * with the factories rather than being rediscovered. Call them only for the
 * postings that survive filtering, never for a whole board; that bound is the
 * caller's to keep. Ashby has no hydrate step because it returns
 * `descriptionPlain` inline.
 *
 * **The hydrators take a job id, not a posting, so `greenhouseJobId` and
 * `leverJobId` ship with them.** A `JobPosting` from these boards carries
 * `id: "{vendor}:{slug}:{jobId}"`, and recovering the third field is the other
 * half of the hydrate contract — exporting the hydrators without it would leave
 * a consumer to rediscover the shape. It is not the one-liner it looks like:
 * `lastIndexOf(":")` is wrong on a slug that itself contains a colon, and wrong
 * again on the posting `url` these adapters fall back to when a board omits the
 * id. Both helpers return `""` on a shape mismatch, which the caller reads as
 * "not hydratable".
 *
 * **They differ on failure, and the difference decides how you batch.**
 * `hydrateGreenhouse` REJECTS on a non-ok response; `hydrateLever` never throws
 * and resolves `""`. So `Promise.all(page.map(p => hydrateGreenhouse(…)))` loses
 * a whole page of descriptions to one 404 — settle per item instead. The in-app
 * caller only avoids the trap because `hydrateDescriptions` runs them through
 * `mapWithConcurrency`, which is settle-per-item and is deliberately NOT on this
 * surface: it lives behind `company-boards.ts`, whose closure reaches the
 * IndexedDB board cache and therefore `.`'s storage modules, and pulling it here
 * would make the two entries' runtime closures overlap. A consumer batching
 * these writes its own bound.
 */
export {
  makeGreenhouseProvider,
  hydrateGreenhouse,
  greenhouseJobId,
} from "../../../src/lib/job-search/providers/greenhouse.ts";

export {
  makeLeverProvider,
  hydrateLever,
  leverJobId,
} from "../../../src/lib/job-search/providers/lever.ts";

export { makeAshbyProvider } from "../../../src/lib/job-search/providers/ashby.ts";

/**
 * The contract, `export type` for the main barrel's rule 2 reason — a type-only
 * edge erases, a value edge would put the module and everything under it on the
 * consumer's runtime graph.
 *
 * `JobProvider.search(query, signal)` MUST be given an `AbortSignal` it can
 * thread into `fetch`, and it REJECTS on transport or parse failure. The in-app
 * orchestrator runs the fan-out through `Promise.allSettled` for that reason; a
 * poller that awaits them in sequence loses every remaining feed to the first
 * unreachable one.
 *
 * `JobQuery` is re-exported from `query-builder.ts` because it is the argument
 * type and a consumer cannot call an adapter without it. `buildJobQuery` itself
 * is not here: it derives a query from a whole `HeuristicParsedResume`, which is
 * precisely the object the extension consumer is built never to hold. A
 * `JobQuery` literal — titles, skills, and the optional filters — is the whole
 * contract, and every field is documented at its source.
 *
 * `JobPosting` is on the main barrel too, and stays there. It is the shape a
 * captured posting is rated in, which a consumer needs whether or not it ever
 * searches; duplicating a type-only re-export costs nothing at runtime and
 * removing it from `.` would break every importer that has one today.
 */
export type {
  JobProvider,
  JobPosting,
} from "../../../src/lib/job-search/types.ts";

export type { JobQuery } from "../../../src/lib/job-search/query-builder.ts";
