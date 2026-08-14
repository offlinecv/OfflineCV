# Contributing — process

Everything in this file is about **shipping** a change, not writing one. Read it when you are
about to add a test fixture, open a PR, write a merge message, or deploy. Day-to-day coding
guidance lives in [`CLAUDE.md`](../CLAUDE.md) at the repo root; the human-facing contribution
walkthrough (setup, branch workflow, tests, code style) lives in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

This file is the **rationale**. The rules it explains are enforced closer to where they bite:
the binding one-liners sit in `CLAUDE.md` → **Hard rules** (always in an agent's context), the
fixture-PII check is a directory-scoped `CLAUDE.md` in `tests/fixtures/pdfs/`, and each shipping
skill (`/open-pr`, `/pr-review`, `/revise-pr`, `/implement-batch`, `/pr-ready`) carries its own
operational copy. Nothing here is load-bearing on its own — if you change a rule, change it in
those places too, not only here. **AI attribution** is the partial exception: it is enforced by a
setting in `.claude/settings.json`, so its `CLAUDE.md` counterpart is deliberately thin — a
one-liner for the harnesses that setting does not reach, rather than prose restating it.

## Test fixtures — PII policy (non-negotiable)

PDF fixtures under `tests/fixtures/pdfs/<category>/` **must use synthetic personas only** — fake name, email (`@example.com`), and a phone using a **real area code with the `555` exchange and a `0100`–`0199` subscriber** (e.g. `(312) 555-0123`). That is the only reserved-but-valid fictional form: it passes `libphonenumber-js` `isValid()` (which the parser uses) yet never rings a real line. Do **not** use an area-code-`555` number like `(555) 010-0123` — `555` is an invalid NANP area code, so the validator rejects it and the fixture's `phone` silently drops out of the score. The repo is **public**; the committed PDF *binary* is the exposure surface, and purging a leaked fixture after merge means `git filter-repo` + a GitHub Support ticket. Catch it before merge.

- **`npm run check:fixtures` mechanically enforces four of these rules — but not the name.** `scripts/check-fixture-pii.mjs` scans *every* PDF under `tests/fixtures/pdfs/` on every run, and exits non-zero naming the offending value. It runs in `npm run verify` and as a step in CI's `verify` job, so a violating fixture cannot merge. It reads text, **link annotations** and metadata with `pdfjs-dist` (already a dependency), so CI needs no `poppler-utils`. The four rules it encodes: an `@example.com` email must be present; any phone present must be a real area code + `555` exchange + `0100`–`0199` subscriber; no denylisted real persona (posquit0, Debarghya Das); and metadata `Author` / XMP `dc:creator` must be empty or an obviously synthetic name.
  - **What it cannot do:** decide whether a **name** is synthetic — no script can — and it does not walk the non-PDF fixtures (png/jpeg/docx). Both stay a human call, so a green check is not by itself an approval.
  - **Why annotations are scanned:** a `tel:`/`mailto:` href is a real contact surface (the cascade extracts it as `CascadeResult.linkAnnotations`) and is invisible to both `getTextContent()` and `pdftotext`. Two fixtures drew a compliant phone on the page while their `tel:` href still pointed at a forbidden area-code-`555` number, and passed a text-only gate.
- **"Self-published upstream" is not an exception.** Several OSS résumé templates ship the author's *own real résumé* as the demo PDF — e.g. Awesome-CV embeds posquit0's CV (real email + phone), Deedy-Resume embeds Debarghya Das's. Downloading those verbatim re-hosts a real person's contact info here. Re-export the template filled with synthetic data instead.
- **Before adding a fixture — or approving a PR that adds one — run the check, and eyeball the binary:**
  ```bash
  npm run check:fixtures
  pdftotext tests/fixtures/pdfs/<category>/<file>.pdf - | head -40
  ```
  Confirm the name, email, and phone are fake. A "PII-free" claim in a PR description is not a substitute for this — verify the binary, not the prose. Run **both**: they cover different surfaces. `pdftotext` prints only the drawn page, so it cannot see a `tel:`/`mailto:` **link annotation** or the Info dict — the gate scans those, and both have leaked here. Conversely, only *you* can judge whether the **name** is synthetic, and for that the `pdftotext` output is exactly what you read.
- **The exception table is the only hole, and it is pinned.** Two fixtures (`unknown/openresume-react-pdf.pdf`, `word/openresume-laverne-word-quartz.pdf`) carry upstream OpenResume demo addresses and cannot be re-exported — their renderers (react-pdf; Word → macOS Quartz) are not reproducible here, and re-encoding their text runs would shift glyph widths and destroy the very layout they exist to capture. Each exception pins **one value in one file** and must state a reason. Prefer re-exporting the fixture. Do not widen an entry to cover a new file.
- The `*.expected.json` snapshots are lossy by design (keys/counts only, never field values), so they stay PII-free automatically — but that safety does **not** extend to the PDF itself.
- Full policy + add-fixture workflow: `tests/fixtures/pdfs/README.md` (Privacy section).

## AI attribution — suppressed by configuration, not by prose

Claude Code appends attribution to the commits and PRs it creates: a `Co-Authored-By:` trailer, a
`🤖 Generated with [Claude Code]` PR-body badge, and — from web / Remote Control sessions — a
`Claude-Session:` trailer carrying a `https://claude.ai/code/session_…` URL. That text is injected
into the agent's system prompt, so for a long time this repo fought it with prose: a hard rule in
`CLAUDE.md` plus a near-identical paragraph in each of the four shipping skills, all telling the
model to ignore an instruction it had just been given. Prose that argues with the harness loses
sometimes, and ~16 `Claude-Session:` trailers reached `main` before anyone noticed.

**It is a setting.** `.claude/settings.json`:

```json
"attribution": {
  "commit": "",
  "pr": "",
  "sessionUrl": false
}
```

An empty `commit` / `pr` string hides the trailer and the badge; `sessionUrl: false` drops the
session trailer and PR-body link. With that in place the harness never emits the text and never
suggests it, so there is nothing left to resist — the rule survives in `CLAUDE.md` only as a
one-liner saying *don't type one back in by hand*.

`includeCoAuthoredBy: false` is the older, single-boolean form of the same idea and is what you'll
see in most repos. It is **deprecated** in favour of `attribution`, and it covers less: it kills the
`Co-Authored-By` trailer and the `🤖` badge but **not** the session URL, which was the only part
with an actual privacy cost on a public repo. Prefer `attribution`. Do not set both — when
`attribution` defines `commit` or `pr`, `includeCoAuthoredBy` is ignored entirely, which is a quiet
way to think you've disabled something you haven't.

**Why the reasoning differs per line.** `Co-Authored-By` is semantic authorship attribution under
git/GitHub convention, and the model is the facilitator, not a co-author — the human who ran it is
the author. The session URL is an account-scoped identifier with zero value to any reader of a
public diff. (The ~16 already in `main` were deliberately **not** purged with `git filter-repo`:
those URLs are auth-gated, so the exposure is an identifier and not content, and a history rewrite
on a public repo costs far more than it recovers.)

### Model provenance — retired

This repo used to require a `## Provenance` block in every PR body: which model did which stage, at
what effort, one row per issue on a batch PR. It was **retired in favour of nothing** — the block
is no longer written, updated, or expected, and existing ones need not be removed.

The idea was sound: it made cross-model review legible and let a reader calibrate how much to trust
a diff. What it cost was not. Because a spawn requests a model *alias* (`model: opus`) and never
learns what that alias resolved to, every row had to be **self-reported** — so an orchestrator paid
a round-trip per subagent to collect model strings, then a `gh pr view` + text-surgery + `gh pr edit`
per PR to write the block in idempotently, plus a repeat of that on every `/revise-pr` round. Four
skills carried the machinery. And the output was not reliably true: on the #711/#712 batch, two
subagents spawned with the *same* `model: sonnet` alias self-reported **different** names, so one
row was wrong with no way to tell which from the orchestrator's side.

A block a reader can't trust is worse than no block — it launders a guess into a fact. Given that,
the tokens and the wall-clock bought nothing worth keeping. What a reviewer actually needs is
already cheap and first-hand: `/pr-review` signs its review off with a single
`Reviewed by: <model> (<effort>)` line, naming the model that *is* running — no round-trip, no
inference, no PR-body edit.

## Squash messages (one commit per PR)

`main` merges through a **merge queue**, and the queue's enqueue API carries **no commit-message fields** (`EnqueuePullRequestInput` is `pullRequestId` / `jump` / `expectedHeadOid`, nothing else). The squash message therefore **cannot be handed to GitHub at merge time** — GitHub *derives* it from repo settings:

```
squash_merge_commit_title:   COMMIT_OR_PR_TITLE
squash_merge_commit_message: COMMIT_MESSAGES
```

With those settings, a **multi-commit** PR merges with every commit message concatenated as `* ` bullets. That is how `wip`, `fix lint`, and `address review comments` end up in `main`'s history permanently.

The `COMMIT_OR_` prefix is the only lever:

> **A PR with exactly one commit merges with that commit's subject and body verbatim** — PR title and body ignored, no bullet soup, nothing from the PR body leaking into `git log`.

So **every PR reaches the queue as a single commit whose message is the message we want in `main`.**

- **`/open-pr` (Step 3.6)** collapses the branch *before* the PR exists — free, since there is no approval to dismiss yet.
- **`/revise-pr` (Step 5.1)** collapses **only on the final review round**, when no thread is left open. A mid-review force-push costs the reviewer the delta diff they came back for.

```bash
git reset --soft "$(git merge-base HEAD origin/main)"
git commit -F .git/COMMIT_EDITMSG     # the combined message, hand-written
git push --force-with-lease           # never bare --force
```

Rules:

- **Branch commits are scratch; the merge message is the artifact.** Write the combined message to describe the change *as a whole* — not the sequence of steps that produced it. Drop the review round-trip; it is process, not change.
- **Don't `rebase -i` a branch clean before merge.** Pointless when it is getting squashed — collapse instead.
- **Never bypass the queue with `--admin`** just to hand-write a merge message. The collapse achieves the same thing without skipping required checks.
- **Nothing is lost that squash-merge wasn't already going to discard.** `main` only ever receives one commit per PR; collapsing early changes *when* the intermediate commits are dropped, not *whether*. The collapsed commit's tree is byte-identical to the branch tip's.
- **Recovery, if a collapse goes wrong:** the pre-push SHA is permanently recorded on the PR timeline (`HeadRefForcePushedEvent`, `before`/`after`), the orphaned commit stays viewable at `github.com/<org>/<repo>/commit/<sha>` and downloadable via `gh api repos/<org>/<repo>/commits/<sha> -H "Accept: application/vnd.github.patch"`, and the pusher's local `git reflog` holds it for 90 days. Note that `git fetch origin <sha>` will **not** retrieve it — the server rejects unreachable objects — so restore from the reflog, or apply the patch.

## Soliciting review (`/pr-ready`)

Opening a PR (`/open-pr`) doesn't get a human to look at it — silence from a
reviewer who's mid-review and silence from a reviewer who hasn't opened the
PR look identical to the author. `/pr-ready` runs the ask as a small protocol
instead of a hand-typed message: it preflights the PR (open, mergeable,
checks green, one commit), posts a single ping with a stated ack mechanism
and an absolute-time deadline, waits, sends at most one reminder if still
silent, and reports whether anyone engaged — across chat reactions, thread
replies, or GitHub review activity. It never changes the PR's merge state;
the terminal state is always a report, and the merge call stays a human's.

It takes a **list** too — `/pr-ready 572,605,606` is one ping covering all
three, with one deadline and one reminder, and a report that says per PR who
engaged. That is deliberately not the same as running the skill three times:
three runs would @-mention the same reviewers three times and hold three
sequential deadlines, which is what being chased feels like from the other
side. A PR that fails preflight is dropped from the ask and named — both when
you approve the message and in the final report — rather than blocking the
PRs that are ready.

**One-time setup, per checkout:** copy `.claude/pr-ready.local.json.example`
to `.claude/pr-ready.local.json` (git-ignored) and fill in your chat channel
and reviewer roster — the skill file itself carries no identity, by design.
Full config schema and process detail: `.claude/skills/pr-ready/SKILL.md`.

## Deploy

`npm run build` emits a self-contained static `dist/` that hosts on any static-file host — the portable, contributor-facing deploy path documented in the README's Deploy section.

The hosted preview is published to GitHub Pages via `.github/workflows/deploy-pages.yml` (the canonical, in-repo deploy example).

The maintainer also keeps an **untracked, local-only** `scripts/deploy_offlinecv.sh` that uploads `dist/` to a GCS bucket (config from a gitignored `.env.deploy`; sources the `~/tools/scripts/` symlinked helpers). It's gitignored alongside `run_offlinecv.sh` because it depends on machine-local tooling — don't recommend it to contributors or recreate it as a tracked file.

Likewise, a maintainer convenience wrapper (`scripts/run_offlinecv.sh`, an interactive menu) exists locally but is **not tracked** — it `source`s shared bash helpers symlinked from `~/tools/scripts/` (`common.sh`, `deploy_web_utils.sh`, `load_env.sh`) that only exist on the maintainer's machine. Don't reintroduce either to the repo; build/deploy guidance for contributors lives in the README's Deploy section.

## License

Apache-2.0. The patent grant is deliberate — the parser audit should be safely reusable in commercial LLM-adjacent products. See `LICENSE` and `NOTICE` at repo root.
