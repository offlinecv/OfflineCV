# Reviewing a Gaal PR

Gaal is the repo's coding agent. It takes an issue labelled `gaal`, writes the fix and its tests, and opens a PR as `gaal-agent[bot]`. A bot reviewer comments on the PR, and Gaal revises until the review is clean or it runs out of rounds. What neither bot can do is decide whether the change is **right**. Your approval is the only thing that lands it in `main`, so treat it as yours.

This page is the checklist. For how any PR moves from branch to `main`, see [How a change gets reviewed and merged](./pr-review-process.md).

## Before you start

- **Claim it.** Add yourself under **Reviewers** on the PR, so two people don't review the same one.
- **Check the label.** A PR with no label is ready for review. `needs-human` means the bot reviewer and Gaal couldn't settle something: read the open thread first.

## The checklist

### 1. Read the issue before the diff

Open the linked issue (`Closes #N` at the bottom of the PR description) and read its **acceptance criteria**. Those are what you're checking against, not the PR description. The description is Gaal's summary of its own work, and it can be wrong.

### 2. Check the diff against every criterion

Go through the criteria one by one. For each, find the code that meets it. Watch for three things:

- **A criterion quietly skipped.** The PR says "fixes the bug" but criterion 3 isn't touched.
- **A choice made without saying so.** If the issue listed options ("Option 1 / Option 2", "Decide whether…"), the PR description must name the one Gaal picked and why. Gaal sometimes picks silently, for example refusing an action silently where the issue asked for a message (#1044, #1048). If the choice isn't named, ask.
- **Scope creep.** Changes to files the issue doesn't need. Small tidy-ups next to the fix are fine; unrelated rewrites are not.

### 3. Check the tests prove the fix

- There's at least one new or changed test for the behaviour the issue describes.
- The test asserts what the **user** would see or what the data ends up as, not just that a function was called.
- It would fail without the fix. The bot review often says it reverted the change and saw the test go red. If it doesn't, ask Gaal to confirm (`/gaal confirm the new test fails with the production change reverted`), or check it locally.

### 4. Try it in the preview

Every PR gets its own deployed copy of the site. On the PR, find the **Cloudflare Pages** comment and open the **Branch Preview URL** (it looks like `https://gaal-issue-929.offlinecv.pages.dev`).

- Follow the issue's reproduction steps and confirm the bug is gone, or that the new behaviour works.
- Need a résumé? Download a PDF from [`tests/fixtures/pdfs/`](../tests/fixtures/pdfs/). They're synthetic, so they're safe to use anywhere.
- For a layout or mobile issue, use your browser's device toolbar (Chrome DevTools → Toggle device toolbar) at the width the issue names, for example 375px.
- Poke around the feature next to the fix too. A fix that breaks the neighbouring control is the common failure.
- To compare against today's behaviour, open [offlinecv.org](https://offlinecv.org) in another tab. It can trail `main` by up to a day.

If the preview comment says the deploy failed, note it on the PR and review from the diff.

### 5. House rules

CI enforces most of these, but look anyway:

- **One commit** on the branch (the **Commits** tab shows 1).
- **No new fixture PDF with real-looking contact data.** Fixture changes need a maintainer's approval as well (see `CODEOWNERS`), because the repo is public and a leaked PDF can't be taken back.
- The `verify` check is green.

## Deciding

| What you found | What to do |
|---|---|
| Everything checks out | **Approve**, then **Merge when ready**, which adds the PR to the merge queue. |
| Something specific is wrong | Comment `/gaal <exactly what to change>`. Gaal revises and the bot reviews again. Be concrete: name the file, the behaviour and the criterion. |
| You're unsure, or it's a product or design question | Comment with your take and tag the maintainer. Don't approve yet. |
| It's labelled `needs-human` | Write your recommendation as a comment and tag the maintainer; you'll decide together. |

A new push dismisses earlier approvals. If Gaal revises after you approved, look at the new commit and approve again.
