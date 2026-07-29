// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Issue-linked baseline gate (#654). Fails the build when a corpus gate's
 * known-failure exemption — or a ground-truth `knownWrong` marker — cites an
 * issue that no longer justifies it.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. Everything else about a baseline is
 * checkable in vitest, and is: `assertNoStaleKeys` rejects a key naming no
 * fixture, `assertRatchet` rejects a baselined category that now passes, and
 * `loadKnownFailures` rejects a malformed entry. The one fact none of them can
 * reach is whether the cited ISSUE is still open — that lives on GitHub. So this
 * runs where a token exists, and the baselines live in JSON (rather than as
 * TypeScript literals inside the test files) precisely so a plain Node script
 * can read them without a TS toolchain.
 *
 * WHAT IT CATCHES, concretely, and why that is not hypothetical. When #654 was
 * written, NINE `experience` exemptions in the edit-leg gate cited #436 — closed
 * as completed months earlier. They still failed, so the ratchet was happy; they
 * cited a finished issue, so a reader chasing the citation found a closed tab and
 * no owner. That is the orphaned-baseline failure mode, and it is invisible to
 * every other gate in the repo. This script turns it into a red build the day the
 * issue closes.
 *
 * The two statuses are not decoration:
 *   `open`     the exemption is charged to a live bug. The issue MUST be open.
 *              Closed ⇒ the fix landed ⇒ either the exemption should be gone
 *              (the ratchet will say so) or it was mis-attributed. FAIL.
 *   `accepted` the exemption is charged to a written-down decision (#326's lossy
 *              `toWinAnsi()` substitution). Its issue is normally CLOSED, which
 *              is exactly why `accepted` cannot be inferred from issue state and
 *              has to be declared. An `accepted` entry whose issue is still OPEN
 *              is reported as a warning, not a failure — a decision issue can
 *              legitimately still be open while it is being written.
 *   `unfiled`  a ground-truth `knownWrong` only, carrying `issue: null`: a wrong
 *              parse that has been MEASURED but not yet filed. It has no issue to
 *              go stale, so it is warned about on every run and capped by
 *              `corpus.test.ts`'s ceiling rather than checked here. It exists so
 *              that discovering a defect never requires inventing an issue number
 *              or mislabelling a live bug as `accepted`.
 *
 * What it deliberately does NOT do: judge whether the citation is the RIGHT
 * issue. A truthful-looking number pointing at an unrelated bug passes here. That
 * judgement is a reviewer's, and the mandatory `note` on every entry is what
 * gives them something to judge.
 *
 * Run:  npm run check:baselines
 * Offline / unauthenticated (`gh` missing or logged out) the issue-state pass is
 * SKIPPED with a loud notice and the script still runs every structural check,
 * so `npm run verify` works on a plane. CI runs it with a token, where the
 * issue-state pass is the point.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const REPO = "offlinecv/OfflineCV";
const BASELINE_DIR = "src/lib/heuristics";
const FIXTURE_ROOT = "tests/fixtures/pdfs";

const VALID_STATUSES = ["open", "accepted"];

// ── Discovery ───────────────────────────────────────────────────────────────

function walk(dir, predicate) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path, predicate));
    else if (predicate(entry)) found.push(path);
  }
  return found;
}

/** POSIX-style relative fixture key, so it compares against the JSON's keys on
 *  Windows too (the gates' `relKey` does the same normalization). */
function relFixtureKey(absPath) {
  return relative(FIXTURE_ROOT, absPath).split(sep).join("/");
}

/**
 * Every citation in the repo, flattened to one shape so the issue-state pass
 * does not care which file it came from.
 *
 * Two sources, deliberately swept together: the corpus gates'
 * `*.known-failures.json`, and each fixture's `*.truth.json` `knownWrong` block —
 * a ground-truth field the parser is currently known to get wrong is an
 * exemption in exactly the same sense, and rots in exactly the same way.
 */
export function collectCitations({ baselineFiles, truthFiles, fixtureKeys }) {
  const citations = [];
  const unfiled = [];
  const truthFiled = [];
  const failures = [];
  const note = (where, msg) => failures.push(`${where}: ${msg}`);

  for (const { path, json } of baselineFiles) {
    const categories = new Set(json.categories ?? []);
    if (categories.size === 0) note(path, "`categories` is missing or empty");
    for (const [fixture, entries] of Object.entries(json.baselines ?? {})) {
      if (fixtureKeys && !fixtureKeys.has(fixture))
        note(`${path} → ${fixture}`, "names no fixture under " + FIXTURE_ROOT);
      const seen = new Set();
      for (const entry of entries) {
        const where = `${path} → ${fixture}/${entry.category}`;
        if (!categories.has(entry.category))
          note(where, `unknown category "${entry.category}"`);
        if (seen.has(entry.category)) note(where, "duplicate category");
        seen.add(entry.category);
        citations.push({ where, ...validateCitation(entry, where, note) });
      }
    }
  }

  for (const { path, json, fixture } of truthFiles) {
    // Same staleness check the baselines get: a `.truth.json` whose PDF has been
    // deleted is an orphan measuring nothing, and without this it was silently
    // counted as coverage — the annotated-fixture floor in `corpus.test.ts` reads
    // the same tree.
    if (fixtureKeys && !fixtureKeys.has(fixture))
      note(`${path}`, `names no fixture under ${FIXTURE_ROOT} ("${fixture}")`);
    for (const [field, entry] of Object.entries(json.knownWrong ?? {})) {
      const where = `${path} → ${fixture}/${field}`;
      // An `unfiled` disagreement has no issue to look up — by construction, it
      // is one nobody has filed yet. It is still validated, still counted, and
      // still printed, so it cannot hide; it just has nothing to go stale.
      if (entry.status === "unfiled") {
        if (entry.issue !== null) note(where, "an \"unfiled\" entry must carry `issue: null`");
        if (!entry.note || String(entry.note).trim().length === 0)
          note(where, "`note` is required");
        unfiled.push(where);
        continue;
      }
      // Tracked separately from the baseline citations so the run can PRINT it.
      // `unfiled` is capped (`corpus.test.ts`) and printed; a truth `knownWrong`
      // charged to a live issue was uncapped AND silent, which made the
      // less-visible path the one of least resistance.
      truthFiled.push(where);
      citations.push({ where, ...validateCitation(entry, where, note) });
    }
  }

  return { citations, unfiled, truthFiled, failures };
}

/** The `{issue, status, note}` triple every citation carries, wherever it lives. */
function validateCitation(entry, where, note) {
  if (!Number.isInteger(entry.issue) || entry.issue <= 0)
    note(where, "`issue` must be a positive integer");
  if (!VALID_STATUSES.includes(entry.status))
    note(where, `unknown status "${entry.status}" (expected ${VALID_STATUSES.join(" | ")})`);
  if (!entry.note || String(entry.note).trim().length === 0)
    note(where, "`note` is required — an exemption nobody can explain is one nobody can retire");
  return { issue: entry.issue, status: entry.status };
}

// ── Issue state ─────────────────────────────────────────────────────────────

/**
 * `gh` telling us "there is no such issue" and `gh` being unable to tell us
 * anything are different facts, and only the first one is the baseline's fault.
 *
 * Collapsing both into `null` made a 5xx, a rate-limit, a network blip or an
 * issue transferred out of the repo all render as `"issue #N could not be
 * resolved"` — which reads as *you cited a bogus issue number* and sends the
 * contributor to check a citation that is fine. Since this is a required gate
 * (its own CI step AND inside `verify`), that misdirection lands on every PR.
 *
 * Returns the parsed `{state, title}`, `null` for a genuine not-found (the hard
 * failure this gate exists for), or `{unreachable}` when the lookup itself
 * failed — which degrades to the same loud warn-and-skip as a logged-out `gh`.
 */
function issueState(number) {
  try {
    const raw = execFileSync(
      "gh",
      ["issue", "view", String(number), "--repo", REPO, "--json", "state,title"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(raw);
  } catch (err) {
    // `gh` reports a missing/transferred issue on stderr with a GraphQL
    // resolution error; anything else (non-zero exit with a transport message,
    // a killed process, unparseable JSON) is us failing to ask, not an answer.
    const stderr = String(err?.stderr ?? "");
    if (/could not resolve to an? issue|no issue found|not found/i.test(stderr))
      return null;
    const detail = (stderr.trim() || String(err?.message ?? "unknown error"))
      .split("\n")[0]
      .slice(0, 200);
    return { unreachable: detail };
  }
}

function ghAvailable() {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The rule, pure over an already-fetched state so it is testable without a
 * network: `open` demands an OPEN issue; `accepted` tolerates either but says so
 * when the decision issue is still open.
 */
export function judgeCitation({ where, issue, status }, state) {
  // The lookup never completed — say so, and do NOT accuse the citation. Warn,
  // not fail: this is the same "the issue-state pass could not run" degradation
  // `ghAvailable()` already takes, and for the same reason. Failing here would
  // turn a transient GitHub blip into a red merge queue on every open PR.
  if (state?.unreachable)
    return {
      level: "warn",
      message:
        `${where}: could not check #${issue} against ${REPO} — the lookup itself failed ` +
        `(${state.unreachable}). The citation was NOT validated; this is a transport ` +
        `problem, not a bad issue number.`,
    };
  if (state === null)
    return { level: "fail", message: `${where}: issue #${issue} could not be resolved in ${REPO}` };
  if (status === "open" && state.state !== "OPEN")
    return {
      level: "fail",
      message:
        `${where}: cites #${issue} as an OPEN bug, but that issue is ${state.state} ` +
        `("${state.title}"). Either the fix landed and this exemption should be deleted ` +
        `(the corpus ratchet will confirm), or it is charged to the wrong issue. ` +
        `Do NOT flip it to "accepted" to silence this — "accepted" is for a decision ` +
        `someone wrote down.`,
    };
  if (status === "accepted" && state.state === "OPEN")
    return {
      level: "warn",
      message: `${where}: marked "accepted" but #${issue} is still OPEN ("${state.title}") — confirm the decision is recorded.`,
    };
  return null;
}

// ── Entry point ─────────────────────────────────────────────────────────────

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  const baselinePaths = walk(BASELINE_DIR, (n) => n.endsWith(".known-failures.json"));
  const truthPaths = walk(FIXTURE_ROOT, (n) => n.endsWith(".truth.json"));
  if (baselinePaths.length === 0) {
    console.error(`✗ no *.known-failures.json under ${BASELINE_DIR}/ — is the path right?`);
    process.exitCode = 1;
    return;
  }

  const fixtureKeys = new Set(
    walk(FIXTURE_ROOT, (n) => n.toLowerCase().endsWith(".pdf")).map(relFixtureKey),
  );

  const { citations, unfiled, truthFiled, failures } = collectCitations({
    baselineFiles: baselinePaths.map((path) => ({ path, json: loadJson(path) })),
    truthFiles: truthPaths.map((path) => ({
      path,
      json: loadJson(path),
      fixture: relFixtureKey(path).replace(/\.truth\.json$/, ".pdf"),
    })),
    fixtureKeys,
  });

  // BOTH passes always run, and the failures are UNIONED. Gating the issue-state
  // pass on `failures.length === 0` meant one malformed entry anywhere masked
  // every stale-issue finding in the repo — you fixed the typo, pushed, and the
  // next run surfaced a second wall of failures you could have seen at once.
  // A citation the structural pass rejected is skipped individually instead:
  // `validateCitation` may have left `issue` non-numeric, which has no state to
  // look up.
  const warnings = [];
  const lookupReady = citations.filter(
    (c) => Number.isInteger(c.issue) && c.issue > 0,
  );
  if (!ghAvailable()) {
    console.log(
      `⚠ ${citations.length} citation(s) collected, but \`gh\` is unavailable or ` +
        `logged out — the ISSUE-STATE pass was SKIPPED. An orphaned baseline (an exemption ` +
        `whose issue has been closed) would not be caught by this run. CI runs it with a token.`,
    );
  } else {
    const states = new Map();
    for (const { issue } of lookupReady)
      if (!states.has(issue)) states.set(issue, issueState(issue));
    for (const citation of lookupReady) {
      const verdict = judgeCitation(citation, states.get(citation.issue));
      if (!verdict) continue;
      (verdict.level === "fail" ? failures : warnings).push(verdict.message);
    }
  }

  for (const where of unfiled)
    console.warn(
      `⚠ ${where}: a ground-truth disagreement with NO issue filed yet ` +
        `(status "unfiled"). File it and flip the entry to "open".`,
    );
  for (const warning of warnings) console.warn(`⚠ ${warning}`);
  if (failures.length === 0) {
    console.log(
      `✓ issue-linked baselines: ${citations.length} citation(s) across ` +
        `${baselinePaths.length} gate baseline(s) and ${truthPaths.length} truth file(s); ` +
        `${truthFiled.length} ground-truth \`knownWrong\` entry/entries charged to a live ` +
        `issue, ${unfiled.length} unfiled.`,
    );
    return;
  }
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(
    `\n${failures.length} baseline citation(s) are stale or malformed. ` +
      `See scripts/check-known-failures.mjs for what each status means.`,
  );
  process.exitCode = 1;
}

// Only sweep when run as a script; importing this module (the unit tests do)
// must not shell out to `gh`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
