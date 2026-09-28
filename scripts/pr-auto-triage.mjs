// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * PR Auto-Triage & Safe Approval Helper.
 *
 * Automates two maintenance tasks for Gaal agent and contributor PRs:
 * 1. Auto-resolves review threads on PRs where the automated review bot has
 *    already reached a verdict of APPROVE (e.g. closing non-blocking nits or
 *    threads settled by discussion that stalled the auto-revise loop).
 * 2. Flags strictly classified low-risk PRs as eligible for a human approval:
 *    - Docs-only (e.g. CONTRIBUTING.md, documentation changes)
 *    - Test-only refactor / consolidation (zero production code touched)
 *    Provided the required CI checks (`verify`, `e2e`, `zizmor`) are all
 *    SUCCESS — `fallow` runs as a report-only step inside `verify` (CLAUDE.md),
 *    not as its own check — exactly 1 commit exists on the branch, all threads
 *    are resolved, and the review bot's latest verdict is APPROVE against the
 *    current head. This never posts an APPROVE itself: `pr-review.yml`'s
 *    "Dismiss any approval this job left" step exists specifically because a
 *    `github-actions[bot]` APPROVE would let an agent-written PR merge unread,
 *    and this script runs under the same default token.
 *
 * Any PR touching core parser heuristics, scoring, WebLLM engine, UI components,
 * workflows, dependencies, or PII fixtures is strictly excluded from auto-approval
 * and preserved for human review.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The review bot's logins, across GraphQL (`github-actions`) and REST
 * (`github-actions[bot]`) responses.
 */
const BOT_LOGINS = new Set(["github-actions", "github-actions[bot]"]);

/**
 * CI checks that must each be present and SUCCESS before auto-approval.
 * `fallow` is deliberately absent — it is a report-only step inside `verify`,
 * not an independent check (CLAUDE.md).
 */
const REQUIRED_CHECK_NAMES = ["verify", "e2e", "zizmor"];

/**
 * Parse `BLOCKED_PATHS` out of `.github/scripts/publish-policy.sh`, the one list
 * of paths automation may not publish (workflows, package manifests, agent
 * configuration such as CLAUDE.md and .claude/, hook scripts). A path that is
 * unsafe to publish unread is never safe to fast-track either, so this reads
 * that list instead of keeping a second one that drifts. The ERE it holds is
 * also a valid JS RegExp. Throws when the line is missing: failing closed beats
 * silently classifying CLAUDE.md as docs.
 *
 * @param {string} policySource contents of publish-policy.sh
 * @returns {RegExp}
 */
export function parseBlockedPaths(policySource) {
  const m = policySource.match(/^BLOCKED_PATHS='([^']+)'$/m);
  if (!m) throw new Error("publish-policy.sh has no BLOCKED_PATHS line");
  return new RegExp(m[1]);
}

/**
 * Denylist of sensitive paths that must NEVER be flagged as low-risk: the
 * publish policy's blocked paths, plus fixtures (PII review, CLAUDE.md).
 */
const SENSITIVE_PATTERNS = [
  parseBlockedPaths(
    readFileSync(new URL("../.github/scripts/publish-policy.sh", import.meta.url), "utf8")
  ),
  /^tests\/fixtures\//,
];

/**
 * Allowed docs extensions/paths.
 */
const DOCS_PATTERNS = [
  /^docs\//,
  /\.md$/i,
  /^LICENSE$/,
  /^NOTICE$/,
];

/**
 * Allowed test file patterns.
 */
const TEST_FILE_PATTERNS = [
  /\.test\.(ts|tsx|mjs|js)$/,
  /\.spec\.(ts|tsx|mjs|js)$/,
  /\.test-utils\.(ts|tsx|mjs|js)$/,
];

/**
 * Classify a list of changed file paths into risk categories.
 *
 * @param {string[]} files
 * @returns {{ isLowRisk: boolean, riskClass?: "docs-only" | "test-refactor", reason?: string }}
 */
export function classifyChangedFiles(files) {
  if (!files || files.length === 0) {
    return { isLowRisk: false, reason: "No files changed" };
  }

  for (const f of files) {
    for (const pat of SENSITIVE_PATTERNS) {
      if (pat.test(f)) {
        return { isLowRisk: false, reason: `Touches sensitive path: ${f}` };
      }
    }
  }

  const allDocs = files.every((f) => DOCS_PATTERNS.some((pat) => pat.test(f)));
  if (allDocs) {
    return { isLowRisk: true, riskClass: "docs-only" };
  }

  const allTests = files.every((f) => TEST_FILE_PATTERNS.some((pat) => pat.test(f)));
  if (allTests) {
    return { isLowRisk: true, riskClass: "test-refactor" };
  }

  return { isLowRisk: false, reason: "Touches production code outside low-risk classes" };
}

/**
 * Extract latest verdict from review comments/bodies by the review bot.
 *
 * Only a review posted against the current head commit counts — a stale
 * APPROVE from before a force-push must not drive thread resolution or
 * auto-approval for code the bot never saw.
 *
 * @param {Array<{ author?: { login: string }, body?: string, commit?: { oid?: string } }>} reviews
 * @param {string} [headOid] the PR's current head commit oid
 * @returns {"APPROVE" | "REQUEST_CHANGES" | "COMMENT" | "NONE"}
 */
export function extractLatestBotVerdict(reviews, headOid) {
  if (!reviews || reviews.length === 0) return "NONE";

  const botReviews = reviews.filter((r) => {
    const login = r.author?.login || "";
    return (
      BOT_LOGINS.has(login) &&
      r.body &&
      r.body.includes("Verdict:") &&
      (!headOid || r.commit?.oid === headOid)
    );
  });

  if (botReviews.length === 0) return "NONE";
  const latest = botReviews[botReviews.length - 1];
  const match = latest.body.match(/Verdict:\s*([A-Z_]+)/);
  if (match) {
    const v = match[1];
    if (v === "APPROVE" || v === "REQUEST_CHANGES" || v === "COMMENT") {
      return v;
    }
  }
  return "NONE";
}

/**
 * Determine if an open review thread can be auto-resolved.
 *
 * Only resolves threads the review bot itself opened — this runs on every
 * `pull_request_review: submitted` event for any PR that has ever gotten a
 * bot APPROVE, so a thread a human reviewer opened (a still-open question,
 * unrelated to the bot's own nits) must never be swept up in it.
 *
 * @param {Array<{ id: string, isResolved: boolean, firstCommentAuthor?: string }>} threads
 * @param {"APPROVE" | "REQUEST_CHANGES" | "COMMENT" | "NONE"} botVerdict
 * @returns {string[]} IDs of threads that can be resolved
 */
export function findResolvableThreads(threads, botVerdict) {
  if (botVerdict !== "APPROVE") return [];
  if (!threads || threads.length === 0) return [];

  return threads
    .filter((t) => !t.isResolved && t.id && BOT_LOGINS.has(t.firstCommentAuthor))
    .map((t) => t.id);
}

/**
 * Marker on the eligibility comment, keyed to the head commit it vouches for.
 * The workflow runs every 30 minutes, so without it an eligible PR would be
 * flagged again on every run; a new push gets a new head, and a fresh flag.
 *
 * @param {string} headOid
 */
export function eligibilityMarker(headOid) {
  return `<!-- pr-auto-triage:eligible ${headOid} -->`;
}

/**
 * Whether this head commit has already been flagged as eligible.
 *
 * @param {Array<{ body?: string }>} comments
 * @param {string} headOid
 */
export function alreadyFlagged(comments, headOid) {
  const marker = eligibilityMarker(headOid);
  return (comments || []).some((c) => (c.body || "").includes(marker));
}

/**
 * Check whether a PR meets all conditions for safe auto-approval.
 *
 * @param {Object} pr
 * @returns {{ canApprove: boolean, riskClass?: string, reason?: string }}
 */
export function canAutoApprove(pr) {
  if (pr.state !== "OPEN") {
    return { canApprove: false, reason: `PR is not open (${pr.state})` };
  }
  if (pr.isDraft) {
    return { canApprove: false, reason: "PR is a draft" };
  }
  if (!Array.isArray(pr.commits) || pr.commits.length !== 1) {
    return { canApprove: false, reason: `PR must have exactly 1 commit (has ${pr.commits?.length ?? "unknown"})` };
  }
  if (pr.reviewDecision === "APPROVED") {
    return { canApprove: false, reason: "PR is already approved" };
  }

  const labels = (pr.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  if (labels.includes("needs-human")) {
    return { canApprove: false, reason: "PR has 'needs-human' label" };
  }

  // Every required check must be present and SUCCESS — a missing, pending, or
  // otherwise-non-SUCCESS check must block approval, not just an explicit
  // FAILURE/ERROR (a QUEUED e2e run is not "no failure yet", it is "unverified").
  // `fallow` is not in this list: it runs as a report-only step inside the
  // `verify` job (CLAUDE.md), not as its own check.
  const checks = pr.statusCheckRollup || [];
  for (const name of REQUIRED_CHECK_NAMES) {
    const check = checks.find((c) => (c.name || c.context) === name);
    if (!check || (check.conclusion || check.state) !== "SUCCESS") {
      return { canApprove: false, reason: `CI '${name}' check is not SUCCESS` };
    }
  }

  // Any other explicitly failed check also prevents auto-approval.
  const hasFailure = checks.some(
    (c) => (c.conclusion || c.state) === "FAILURE" || (c.conclusion || c.state) === "ERROR"
  );
  if (hasFailure) {
    return { canApprove: false, reason: "PR has failing check runs" };
  }

  // Bot review must be APPROVE, and must be against the current head — a stale
  // approval from before a force-push must not authorize approving new code.
  const verdict = extractLatestBotVerdict(pr.reviews || [], pr.headRefOid);
  if (verdict !== "APPROVE") {
    return { canApprove: false, reason: `Latest bot verdict is not APPROVE (${verdict})` };
  }

  // All threads must be resolved
  const unresolvedThreads = (pr.reviewThreads || []).filter((t) => !t.isResolved);
  if (unresolvedThreads.length > 0) {
    return {
      canApprove: false,
      reason: `${unresolvedThreads.length} review thread(s) still unresolved`,
    };
  }

  // File risk classification
  const filePaths = (pr.files || []).map((f) => (typeof f === "string" ? f : f.path));
  const classification = classifyChangedFiles(filePaths);
  if (!classification.isLowRisk) {
    return { canApprove: false, reason: classification.reason };
  }

  return { canApprove: true, riskClass: classification.riskClass };
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────

function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function runCli(argv = process.argv.slice(2)) {
  let targetPr = null;
  let dryRun = false;
  let repo = process.env.GITHUB_REPOSITORY || "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr" && i + 1 < argv.length) {
      targetPr = parseInt(argv[++i], 10);
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--repo" && i + 1 < argv.length) {
      repo = argv[++i];
    }
  }

  const repoFlag = repo ? ["--repo", repo] : [];

  let prNumbers = [];
  if (targetPr) {
    prNumbers = [targetPr];
  } else {
    const listRaw = runGh([
      "pr",
      "list",
      ...repoFlag,
      "--json",
      "number,author",
      "--limit",
      "50",
    ]);
    const list = JSON.parse(listRaw);
    prNumbers = list
      .filter((p) => p.author?.login === "gaal-agent[bot]" || p.author?.login === "app/gaal-agent")
      .map((p) => p.number);
  }

  console.log(`Evaluating ${prNumbers.length} PR(s) (dry-run: ${dryRun})...`);

  for (const num of prNumbers) {
    console.log(`\n--- Evaluating PR #${num} ---`);
    const prRaw = runGh([
      "pr",
      "view",
      String(num),
      ...repoFlag,
      "--json",
      "number,title,state,isDraft,commits,reviewDecision,labels,statusCheckRollup,reviews,files,headRefOid,comments",
    ]);
    const pr = JSON.parse(prRaw);

    // Fetch review threads via GraphQL
    const owner = repo ? repo.split("/")[0] : runGh(["repo", "view", "--json", "owner", "-q", ".owner.login"]);
    const name = repo ? repo.split("/")[1] : runGh(["repo", "view", "--json", "name", "-q", ".name"]);
    // Follow every page: a thread past the first 100 is as open as any other,
    // and canAutoApprove must not see a truncated list as "all resolved".
    const gqlQuery = `query($owner: String!, $name: String!, $num: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $num) {
          reviewThreads(first: 100, after: $endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              path
              comments(first: 1) {
                nodes { author { login } }
              }
            }
          }
        }
      }
    }`;
    const threadNodes = [];
    let endCursor = null;
    do {
      const gqlRes = JSON.parse(
        runGh([
          "api",
          "graphql",
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `num=${num}`,
          ...(endCursor ? ["-f", `endCursor=${endCursor}`] : []),
          "-f",
          `query=${gqlQuery}`,
        ])
      );
      const page = gqlRes.data.repository.pullRequest.reviewThreads;
      threadNodes.push(...(page.nodes || []));
      endCursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    } while (endCursor);
    pr.reviewThreads = threadNodes.map((n) => ({
      id: n.id,
      isResolved: n.isResolved,
      path: n.path,
      firstCommentAuthor: n.comments?.nodes?.[0]?.author?.login,
    }));

    const verdict = extractLatestBotVerdict(pr.reviews || [], pr.headRefOid);
    console.log(`Bot verdict: ${verdict} | Unresolved threads: ${pr.reviewThreads.filter((t) => !t.isResolved).length}`);

    // Step 1: Thread resolution
    const resolvableThreadIds = findResolvableThreads(pr.reviewThreads, verdict);
    if (resolvableThreadIds.length > 0) {
      console.log(`Resolving ${resolvableThreadIds.length} open thread(s) (verdict is APPROVE)...`);
      for (const id of resolvableThreadIds) {
        if (!dryRun) {
          runGh([
            "api",
            "graphql",
            "-f",
            `query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`,
            "-f",
            `id=${id}`,
          ]);
        }
      }
      // Update local thread states
      for (const t of pr.reviewThreads) {
        if (resolvableThreadIds.includes(t.id)) t.isResolved = true;
      }
      // `needs-human` is deliberately left alone. pr-auto-rebase.yml,
      // pr-revise.yml and gaal-agent.yml also add it for reasons that have
      // nothing to do with review threads (an oversized conflict, a discarded
      // blocked-path edit, exhausted revise rounds), and the label does not say
      // which. Only a human removes it.
    }

    // Step 2: Auto-approval eligibility check.
    //
    // This deliberately does NOT post event=APPROVE: that would submit the
    // review as github-actions[bot] via the default token, which is exactly
    // the identity pr-review.yml's "Dismiss any approval this job left" step
    // exists to strip, because a bot APPROVE would let an agent-written PR
    // merge unread. Flag eligibility with a comment instead and leave the
    // approving review to a human (or to `gh-as-reviewer.sh`'s signed,
    // self-approval-guarded path).
    const approvalCheck = canAutoApprove(pr);
    if (approvalCheck.canApprove) {
      console.log(`PR #${num} is eligible for approval (risk class: ${approvalCheck.riskClass})`);
      if (alreadyFlagged(pr.comments, pr.headRefOid)) {
        console.log(`Already flagged at ${pr.headRefOid}; not commenting again.`);
      } else if (!dryRun) {
        const body = `🤖 pr-auto-triage: this PR looks low-risk (${approvalCheck.riskClass}) — CI green, 1 commit, all threads resolved, review bot verdict APPROVE. Flagging for a human approval.\n\n${eligibilityMarker(pr.headRefOid)}`;
        runGh(["pr", "comment", String(num), ...repoFlag, "--body", body]);
      }
    } else {
      console.log(`Not eligible for approval: ${approvalCheck.reason}`);
    }
  }
}

// Run directly if invoked from command line
if (process.argv[1] && process.argv[1].endsWith("pr-auto-triage.mjs")) {
  runCli().catch((err) => {
    console.error("pr-auto-triage failed:", err);
    process.exit(1);
  });
}
