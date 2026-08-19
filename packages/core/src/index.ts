// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * `@offlinecv/core` — the public, headless surface of this repo.
 *
 * Everything here already exists under `src/lib/`. This file adds no behaviour;
 * it names the subset of `src/lib/` that a downstream consumer is allowed to
 * depend on, so that consumer can write `@offlinecv/core` instead of reaching
 * into this repo's source tree by relative path.
 *
 * This file is the **`.` entry point**, and the distinction now matters: the
 * package has a second one, `@offlinecv/core/job-search` (`src/job-search.ts`),
 * carrying the job-board provider adapters. Every claim below is about THIS
 * entry unless it says otherwise, and the network-free one is about this entry
 * *because* the other entry is not — see "Two entry points, and only one of them
 * is network-free" below before quoting either.
 *
 * The surface is deliberately narrow: the job-capture contract, the local
 * library's CRUD and replication primitives, the JD term/coverage pair, and the
 * fit-rating chain. It is what a *producer* of `JobRecord`s and a *replica* of
 * the local library need, and nothing else — no React, no parser cascade entry
 * point, no network client.
 *
 * ## Why this re-exports rather than relocates
 *
 * The obvious alternative — physically move these modules into `packages/core/`
 * — was rejected. `src/lib/` is not settled code: it took 33 commits in five
 * weeks, and the storage layer was rewritten wholesale in #761. Moving 49
 * modules would put a rename collision on top of every one of those commits, in
 * exchange for a directory layout. A re-export barrel defines exactly the same
 * public surface at zero conflict cost, and leaves the physical carve as a later
 * decision that can be made on its own merits.
 *
 * So: **no file under `src/` moves, and none has to know this package exists.**
 * If a symbol below is renamed at its source, this file is the one place that
 * breaks, and `tsc` says so.
 *
 * ## Two mechanical rules, both load-bearing
 *
 * **1. Import the FILE, never the slice barrel.** `src/lib/jd-match/index.ts`
 * re-exports `fetch-jd.ts`, which holds this app's live `fetch(` calls for the
 * ATS platforms it hydrates. A consumer that audits its own import graph — and
 * the consumer this package was cut for does exactly that, because it runs in a
 * browser extension where a network primitive on the wrong graph is a shipped
 * privacy defect — sees a whole file the moment anything imports it, not just
 * the one export it used. Routing `computeCoverageFromCorpus` through the barrel
 * would drag a network primitive onto that graph for nothing. Measured: the
 * value-edge closure of the specifiers below is 27 modules and reaches no
 * `fetch`/`WebSocket`/`XMLHttpRequest`/`EventSource` at all. That is a statement
 * about **this entry's** value-edge closure, and not about the tarball's file
 * list, which is larger — see "The tarball ships more files than the graph
 * reaches" below.
 *
 * **2. Types are re-exported with `export type`.** Not a style preference. A
 * type-only edge erases at build time, so `export type { JobRecord } from …`
 * costs the consumer nothing, while a value `export { … }` of the same name
 * makes the module a runtime import and puts its whole file — and everything it
 * pulls in — on the consumer's graph. `src/lib/storage/types.ts` and
 * `src/lib/job-search/types.ts` are re-exported for their types only and must
 * stay `export type` statements.
 *
 * This entry's full transitive closure, `import type` edges included, is 49
 * modules / ~17.5k LOC across `lib/storage`, `lib/job-search`, `lib/jd-match`,
 * `lib/heuristics`, `lib/score` and `webllm`, with exactly one external runtime
 * dependency: `idb`. The `heuristics`, `score` and `webllm` modules are reached
 * only through `import type` edges, so they erase from the runtime graph — but
 * not from the tarball.
 *
 * ## Two entry points, and only one of them is network-free
 *
 * `@offlinecv/core/job-search` is the second, and it is the deliberately
 * network-BEARING half: the provider adapters call public job feeds, so every
 * one of them holds a `fetch(`. It is a separate subpath precisely so that fact
 * cannot arrive here by accident. Read `src/job-search.ts`'s own docblock for
 * the full argument; the two facts that belong on this side of the seam are:
 *
 *   - **The two runtime closures are disjoint.** Measured: 27 modules from this
 *     entry, 11 from `./job-search`, zero modules in common. Importing one
 *     cannot pull the other in, in either direction, which is what makes the
 *     network-free claim above survive the subpath's existence rather than merely
 *     coexist with it.
 *   - **The separation is a consumer's gate, not a preference.** The extension
 *     this package was cut for walks the import graph of each of its entry
 *     points and asserts the network primitives it reaches are exactly an
 *     allow-list of one. Four of its five surfaces must reach none. A consumer
 *     doing that audit must keep `./job-search` off every graph that has to stay
 *     network-free, and there is no safe subset of it to reach for instead.
 *
 * ## The tarball ships more files than the graph reaches
 *
 * `tsc` emits a `.js` for every file in the program, the ones reached only by
 * `import type` included, and `files` ships all of them. So `npm pack` produces
 * 62 modules, of which 38 are reachable — 27 from this barrel and 11 from
 * `./job-search` — and two of the unreachable 24 read exactly like the thing
 * this file says is absent:
 *
 *   - `dist/src/lib/analytics.js` — `import.meta.env`, `await import("posthog-js")`
 *   - `dist/src/lib/webllm/web-llm.js` — `await import("@mlc-ai/web-llm")`
 *
 * (`dist/src/lib/jd-match/fetch-jd.js` used to head that list. It is now
 * genuinely loadable — the provider adapters take `htmlToPlaintext` from it — so
 * it moved off the dead-JS list and onto `./job-search`'s closure, where its
 * `fetch(` is neither a surprise nor a capability that closure lacked.)
 *
 * Neither dynamic import is in `dependencies`, and nothing can load either file:
 * `exports` declares two subpaths and no wildcard, so a consumer reaching for
 * any other path — including a `dist/…` one — gets
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` (verified, and asserted by `check:core`), and
 * no reachable module imports them. Unreachable dead JS a reader can open — not
 * an egress path.
 *
 * The network-free claim above is therefore about **this entry's** RUNTIME GRAPH
 * rather than about the file list, and on that graph it holds exactly: 27
 * modules, no network primitive, one bare import (`idb`). Which means grepping
 * the tarball for `fetch(` is the wrong audit twice over — it finds the seven
 * modules that legitimately fetch on the OTHER entry, plus prose mentions in
 * comments, and says nothing about which entry a consumer imported. Walk the
 * value edges out of `dist/packages/core/src/index.js` instead; that is the
 * graph a consumer of `.` actually loads, and what `check:core`'s probe
 * exercises when it imports the package by specifier.
 *
 * `idb` **is** in this package's `dependencies`, and #772 is the reason it now
 * is. While this was a bare re-export barrel the omission was right: nothing
 * under `packages/core/` imported `idb`, it was reached from
 * `src/lib/storage/db.ts` which belongs to the root package, and declaring it
 * would have claimed a dependency this package did not have. Building the
 * package changed the fact rather than the reasoning — the tarball now carries
 * its own emitted copy of that closure, so `dist/…/storage/db.js` holds the
 * `import … from "idb"` with nothing above it to resolve from. It became a real
 * dependency at BUILD time, not on the day these files physically move.
 * `check:core` is what keeps that honest: it imports the packed tarball with
 * only the declared dependencies symlinked in, so dropping `idb` fails with
 * `ERR_MODULE_NOT_FOUND` naming `storage/db.js`.
 *
 * ## Status
 *
 * `private: true` and unpublished, on purpose, and #772 did not change that.
 * The storage layer is the youngest part of this surface and publishing a
 * version number is a promise not to change it; that promise gets made once the
 * layer has been quiet for a while.
 *
 * What #772 did change is that the package is now BUILDABLE, which it was not.
 * `exports` used to point at this very file — correct for a bundler resolving a
 * workspace link, and unpublishable in a second sense: `private: true` was all
 * that stood between that `exports` map and a publish, and dropping that one
 * line would have handed every Node consumer a file full of type annotations
 * and `.ts` specifiers. `npm run build -w @offlinecv/core` now emits JS and
 * declarations (`tsconfig.build.json`), `exports` points at the emitted entry,
 * and `prepare` runs the build — which is what keeps a workspace/`file:` link
 * consumer working now that `exports` no longer names `src/`.
 *
 * The build has two steps and the second is not decoration.
 * `rewriteRelativeImportExtensions` turns this repo's explicit `./foo.ts`
 * specifiers into `./foo.js` in the JavaScript — but **not** in the `.d.ts`
 * output (verified on TypeScript 5.8.3, under both `bundler` and `nodenext`).
 * The tarball ships no `.ts`, so a per-file declaration tree would dangle on
 * every internal import and a consumer would silently get `any`.
 * `rollup.dts.config.mjs` bundles the declarations into one specifier-free
 * file per entry point — `dist/index.d.ts` and `dist/job-search.d.ts` — and
 * `files` ships those instead of the tree.
 *
 * ## What a third entry point costs
 *
 * Six edits, across five files, that no single tool checks together — the same list
 * is written out in `tsconfig.build.json`, `.fallowrc.jsonc` and
 * `check-core-package.mjs`'s `THIRD_ENTRY_CHECKLIST`, and they used to be three
 * different, shorter lists:
 *
 *   1. `package.json` → `exports` (the subpath, with `types` + `default`)
 *   2. `package.json` → `files` (its `dist/<name>.d.ts`)
 *   3. `tsconfig.build.json` → `include`, or `tsc` emits no `.js` for it
 *   4. `rollup.dts.config.mjs` → a declaration bundle
 *   5. `scripts/check-core-package.mjs` → `EXPECTED_EXPORTS`, `ENTRY_CLOSURES`,
 *      and a `PROBE` static import
 *   6. `.fallowrc.jsonc` → `entry`, unless the new file is called `index.ts`
 *
 * `check:core` is what turns a missed one into a pack-time failure rather than a
 * consumer's silent `any` — including a missed (5), which is the one that used
 * to pass: it cross-checks the subpaths `exports` publishes against both
 * hand-written tables, in both directions, and fails by subpath name.
 *
 * `npm run check:core` (`scripts/check-core-package.mjs`, wired into `verify`)
 * is what makes any of this checkable from in here. Everything else in this
 * repo is a bundler, so a broken tarball stayed invisible until the registry,
 * where the fix costs a version bump rather than a commit. It packs the
 * package, imports it under plain Node with ONLY its declared dependencies
 * present, and typechecks a generated consumer against it under `nodenext`
 * with `skipLibCheck: false`.
 *
 * So what is left before the registry is the decision about the version
 * promise — no longer an unbuilt prerequisite underneath it.
 */

/**
 * The job-capture contract. `docs/job-capture-contract.md` is normative for
 * third-party producers, and these are the symbols it tells them to use rather
 * than reimplement: a second copy of the canonicaliser that drifts by one query
 * parameter forks the id space and turns every re-capture into a duplicate row.
 *
 * `validateJobRecord` and `deriveJobId` are pure — no IndexedDB, no DOM — so a
 * producer can validate a capture anywhere, including a context that has no
 * access to the library at all.
 */
export {
  validateJobRecord,
  JOB_CAPTURE_CONTRACT_VERSION,
  type JobRecordValidation,
  type JobRecordIssue,
} from "../../../src/lib/storage/job-record-contract.ts";

export { deriveJobId, canonicalJobUrl } from "../../../src/lib/storage/job-url.ts";

/**
 * The capture door. Unlike the two above, `captureJob` opens IndexedDB, so it
 * only runs where the app's own origin is. That single fact shapes any consumer
 * that captures from elsewhere: it must hand the record to something running in
 * this app's origin rather than write the library itself.
 */
export {
  captureJobIntoExisting as captureJob,
  type JobCaptureResult,
} from "../../../src/lib/storage/capture.ts";

export type { JobRecord, JobStatus, JobOrigin } from "../../../src/lib/storage/types.ts";

/**
 * The replication primitives (#730). These are the read/write half of syncing
 * the local library to somewhere else, and they carry the same IndexedDB
 * constraint `captureJob` does.
 *
 * A replicating writer wants `putRecord`, **not** `captureJob`. The two jobs
 * genuinely differ: capture strips `deletedAt` and treats a re-capture of a
 * tombstoned posting as a revival — correct for a producer asserting "this
 * posting exists", wrong for a replica carrying the user's own deletion, which
 * is precisely the resurrection `StoredRecord.deletedAt` exists to prevent. It
 * also preserves the local `status`/`notes` over incoming values, right for a
 * producer that knows nothing about the user's application and wrong for a copy
 * of the user's own row edited on another device. `capture.ts`'s docblock draws
 * the same line: a producer replicating a deletion is doing replication, not
 * capture. `backup.ts`'s import path is the in-tree precedent — it writes
 * through `putRecord` with `touch: false`, tombstones included.
 *
 * `getRecord` rather than `getJob`/`getLetter` for the same reason: those two
 * read a tombstone as absent, which is correct for every UI and wrong for
 * last-writer-wins, where a deletion has to be compared against the tombstone's
 * own `updatedAt` or it looks like a record that never existed.
 *
 * `deleteRecord` is the hard delete, and it is here deliberately. `resumes` does
 * not tombstone — a résumé's bytes are the bulk of the database and keeping them
 * after a delete is the opposite of what the user asked for — so a replica of
 * that store has to delete the same way. For a store that DOES tombstone, this
 * is a purge and `softDeleteRecord` is the right call; that one is not on this
 * surface.
 */
/**
 * Re-exported under their app-facing names, but bound to the `…FromExisting`/
 * `…IntoExisting` variant of each: every consumer of THIS package is a content
 * script in the sense `src/lib/storage/db.ts`'s `getExistingDB()` docblock
 * describes, and the plain `getRecord`/`putRecord`/`deleteRecord`/
 * `listRecordsUpdatedSince` open at this repo's pinned `DB_VERSION`, which can
 * hang a content script when a bump lands here ahead of a stale, still-open app
 * tab. Renaming on the way out — rather than the consumer importing a
 * differently-named function — keeps the rebinding invisible to it.
 *
 * ⚠️ **This does not reach the extension in `extension/`.** That checkout
 * (`116-Ideas/recruidea-extension`, pinned by `extension/offlinecv-pin.json`)
 * predates this package and does not import it: its own barrel,
 * `extension/src/offlinecv-core.ts`, re-exports these same symbols directly
 * from `../../src/lib/storage/*.ts` by relative path, so it still binds the
 * `getDB()`-backed originals and is still exposed to the hang. Repointing that
 * barrel at the `…Existing` variants is a change in the extension's own repo;
 * nothing in this file can make it from here.
 */
export {
  getRecordFromExisting as getRecord,
  putRecordIntoExisting as putRecord,
  deleteRecordIntoExisting as deleteRecord,
  listRecordsUpdatedSinceFromExisting as listRecordsUpdatedSince,
} from "../../../src/lib/storage/crud.ts";

export {
  getSyncCursorFromExisting as getSyncCursor,
  setSyncCursorIntoExisting as setSyncCursor,
} from "../../../src/lib/storage/sync-cursor.ts";

export type {
  LetterRecord,
  ResumeRecord,
  StoredRecord,
  SyncableStoreName,
  SyncCursorRecord,
} from "../../../src/lib/storage/types.ts";

/**
 * The letter contract's validator, sibling of `validateJobRecord` and normative
 * for the same reason. `letters` is the first store this build never writes at
 * all (see `docs/cover-letter-contract.md`), so every writer is a producer
 * outside this repo — and the gate their records pass has to be this one rather
 * than a shape check invented at the far end.
 */
export {
  validateLetterRecord,
  type LetterRecordValidation,
} from "../../../src/lib/storage/letter-contract.ts";

/**
 * The résumé picker's list (#712). Answers `{ id, filename, updatedAt }[]`,
 * newest first — no blob, no parse, nothing that makes a picker built on this a
 * second corpus channel. Same IndexedDB constraint as `captureJob`.
 */
export {
  listResumeChoicesFromExisting as listResumeChoices,
  type ResumeChoice,
} from "../../../src/lib/storage/resumes.ts";

/**
 * The compensation parser. A posting's pay range is free-text prose, and this is
 * the one place this codebase parses it; a consumer that writes its own is the
 * duplicate-implementation problem the contract modules above exist to prevent.
 * Zero-dependency and pure.
 */
export {
  extractCompensation,
  formatCompensationRange,
  isBelowFloor,
  type Compensation,
} from "../../../src/lib/job-search/compensation.ts";

/**
 * The fitness chain. A consumer rating one posting uses the same code `/jobs/`
 * ranks a whole feed with — two scoring implementations mean two numbers for one
 * posting and no way to tell which is wrong.
 *
 * `computeCoverageFromCorpus` rather than `computeCoverage`: the latter wants a
 * whole `HeuristicParsedResume`, and #700 split the digest half out precisely so
 * a caller holding only `buildCorpus(parsed)` can score against it without
 * either holding the parse or forking a second coverage implementation. That
 * split is what lets a résumé reach a consumer as one lowercased string instead
 * of a structured document. `corpus` MUST already be lowercased — `buildCorpus`
 * does that normalisation, and the skill/phrase matchers assume it.
 *
 * Note the deep specifiers: `jd-match/index.ts` would pull `fetch-jd.ts` in with
 * them. See rule 1 at the top of this file.
 */
export {
  computeCoverageFromCorpus,
  type CoverageResult,
} from "../../../src/lib/jd-match/coverage.ts";

export {
  extractJdTerms,
  type ExtractedTerm,
} from "../../../src/lib/jd-match/extract-jd-terms.ts";

/**
 * `ratingInputFor` is the single source of truth for what feeds a rating — the
 * specificity discount, the annualised comp top, the location match rule and the
 * seniority rung distance, all in one function. A consumer holding a single
 * freshly captured posting builds the `RankedJob`-shaped argument and calls
 * this; reconstructing the argument list at the far end would reimplement the
 * rating one constant at a time.
 */
export {
  ratingInputFor,
  type RankedJob,
  type KeywordJdMatch,
} from "../../../src/lib/job-search/rank.ts";

export {
  rateJobs,
  describeRating,
  MAX_STARS,
  type JobRating,
} from "../../../src/lib/job-search/rating.ts";

/**
 * `JobPosting` is on `./job-search` as well, and deliberately on both. It is the
 * shape a captured posting is *rated* in, which a consumer needs whether or not
 * it ever searches — and it is what an adapter *returns*, which a consumer of the
 * subpath cannot do without. A type-only re-export erases, so the duplication
 * costs nothing at runtime; narrowing it to one entry would only force some
 * importer to reach for the other.
 */
export type { JobPosting } from "../../../src/lib/job-search/types.ts";
