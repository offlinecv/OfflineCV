# Suggested diff for #1119 — `.github/workflows/pr-review.yml`

Gaal cannot commit under `.github/` (`.github/scripts/publish-policy.sh`
`BLOCKED_PATHS`): a workflow runs with secrets, so a change there needs a
human's own hands on the file, not an agent's. Issue #1119 asks for exactly
that kind of change, so this file carries the diff instead of the real one.
Apply it by hand to `.github/workflows/pr-review.yml`, then delete this file
— it has no reason to stay in the tree once the real edit lands.

## What the diff does

1. Adds a step after `Review` and before `Dismiss any approval this job
   left` that queries `repos/$REPO/pulls/$PR/reviews` and fails the job with
   `::error::` unless a review from `github-actions[bot]` exists with
   `commit_id` equal to `github.event.pull_request.head.sha`. A run that
   finishes green today without posting anything (PR #1114, run
   36610745105) becomes a red run instead.
2. Gives the `Review` step an `id`, then redacts its `execution_file` output
   — the tool-call/response transcript the action normally keeps out of the
   log ("full output hidden for security") — before uploading it as a 7-day
   artifact, so the next silent run leaves evidence without publishing a raw
   transcript. The redaction step masks the two secrets this job holds
   (`GH_TOKEN`, `secrets.CLAUDE_PAT_FOR_GOOSE`); it is not a general secret
   scanner, and the workflow comment on the new steps says so at the point a
   reviewer would want to check it.

**Not independently verified against upstream:** `steps.<id>.outputs.execution_file`
on `anthropics/claude-code-action` — this environment had no network access
to confirm the exact output name against the action pinned at
`756cc22e19660d20e8cc9496b4f242475a7f7790` (v1.0.235). Please check that
name (or the equivalent `show_full_output` input, if the output isn't
there) before merging.

## Diff

```diff
--- a/.github/workflows/pr-review.yml
+++ b/.github/workflows/pr-review.yml
@@ -119,6 +119,7 @@
           cache: 'npm'

       - name: Review
+        id: review
         uses: anthropics/claude-code-action@756cc22e19660d20e8cc9496b4f242475a7f7790 # v1.0.235
         with:
           claude_code_oauth_token: ${{ secrets.CLAUDE_PAT_FOR_GOOSE }}
@@ -147,10 +147,61 @@
             - Exact symbols in backticks; a concrete fix, never "consider …".
             - Drop hedging ("might", "perhaps"), restating the diff, and praise.
             - Exception: a security or architecture finding gets one short
               paragraph with the why — then back to one-liners.

+      # A green job here does not mean a review was posted: run 36610745105 on
+      # PR #1114 finished `subtype: success`, 40 turns, and posted nothing —
+      # no review, no comment, not even the 👀 reaction /pr-review posts first
+      # (#1119). This turns that silent no-post into a red run instead.
+      - name: Assert a review was posted for this head SHA
+        if: always() && !cancelled()
+        env:
+          GH_TOKEN: ${{ github.token }}
+          REPO: ${{ github.repository }}
+          PR: ${{ github.event.pull_request.number }}
+          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
+        run: |
+          set -euo pipefail
+          n=$(gh api --paginate "repos/$REPO/pulls/$PR/reviews" \
+            --jq "[.[] | select(.user.login == \"github-actions[bot]\" and .commit_id == \"$HEAD_SHA\")] | length" |
+            jq -s add)
+          if [ "${n:-0}" -eq 0 ]; then
+            echo "::error::no review posted by github-actions[bot] for $REPO#$PR at $HEAD_SHA"
+            exit 1
+          fi
+
+      # A silent run otherwise leaves nothing to diagnose: the action hides its
+      # own log ("full output hidden for security"). The transcript itself can
+      # still contain whatever a tool call printed, so it is redacted — not
+      # trusted on the strength of GH_TOKEN never appearing as a literal
+      # argument — before it is published. This masks only the two secrets
+      # this job holds; it is not a general secret scanner.
+      - name: Redact the review's execution transcript
+        id: redact
+        if: always() && steps.review.outputs.execution_file != ''
+        env:
+          CLAUDE_TOKEN: ${{ secrets.CLAUDE_PAT_FOR_GOOSE }}
+          GH_TOKEN: ${{ github.token }}
+        run: |
+          set -euo pipefail
+          src="${{ steps.review.outputs.execution_file }}"
+          redacted="${src%.json}.redacted.json"
+          sed -e "s@${CLAUDE_TOKEN}@***REDACTED***@g" \
+              -e "s@${GH_TOKEN}@***REDACTED***@g" \
+              "$src" > "$redacted"
+          echo "redacted_file=$redacted" >> "$GITHUB_OUTPUT"
+
+      # Kept 7 days, not indefinitely, because the repo is public.
+      - name: Upload the review's execution transcript
+        if: always() && steps.redact.outputs.redacted_file != ''
+        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
+        with:
+          name: pr-review-execution-${{ github.event.pull_request.number }}
+          path: ${{ steps.redact.outputs.redacted_file }}
+          retention-days: 7
+
       # Actions may approve PRs in this repo and `main` needs one approval, so a
       # bot APPROVE would let an agent-written PR merge unread. The prompt asks
       # for COMMENT; this makes it true regardless of what the model did.
       - name: Dismiss any approval this job left
         if: always()
```

## How this maps to the acceptance criteria

- [x] A review run that posts no review for the head SHA fails the job with
      a clear error naming the PR and SHA (the `Assert a review was posted`
      step's `::error::` line).
- [x] A normal run (COMMENT review posted) still passes — the review the
      `Review` step posts has `commit_id == github.event.pull_request.head.sha`
      by construction, so the count is non-zero.
- [x] A skipped review (clean replay, cooldown cancel) is not affected — all
      three new steps live inside the `review` job, which already doesn't run
      in those cases.
- [x] The execution transcript is retained as an artifact for ≤7 days,
      redacted of the two secrets this job holds before upload (the `Redact
      the review's execution transcript` step), with a comment noting that
      redaction covers only those two secrets, not arbitrary tool output.
