# Contributing — process

Everything in this file is about **shipping** a change, not writing one. Read it when you are
about to add a test fixture, open a PR, write a merge message, or deploy. Day-to-day coding
guidance lives in [`CLAUDE.md`](../CLAUDE.md) at the repo root; the human-facing contribution
walkthrough (setup, branch workflow, tests, code style) lives in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

This file is the **rationale**. The rules it explains are enforced closer to where they bite:
the binding one-liners sit in `CLAUDE.md` → **Hard rules** (always in an agent's context), the
fixture-PII check is a directory-scoped `CLAUDE.md` in `tests/fixtures/pdfs/`, and each shipping
skill (`/open-pr`, `/pr-review`, `/revise-pr`, `/implement-batch`) carries its own operational
copy. Nothing here is load-bearing on its own — if you change a rule, change it in those places
too, not only here.

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

## AI provenance (what a model may declare about itself)

Three different things get fused into one auto-generated git trailer. They are not the same decision, and this repo treats them separately.

**1. Authorship — banned in git.** Never add a `Co-Authored-By` trailer naming a model, to a commit message or a PR body. `Co-Authored-By` is semantic authorship attribution under git/GitHub convention; the model is the facilitator, not a co-author. The human who ran it is the author. (The Bash tool's default commit template suggests one — ignore it.)

**2. Session telemetry — banned everywhere.** Never emit a `Claude-Session:` trailer, a `https://claude.ai/code/session_…` URL, or a `🤖 Generated with …` badge. This repo is **public**; a session URL is an account-scoped identifier with zero value to any reader of the diff.

**3. Provenance — required, in the PR body only.** Which model did which stage, at what effort, *is* useful: it makes cross-model review legible, and it lets a reader calibrate how much to trust a given diff. It goes in a `## Provenance` block at the end of the PR body — never in a commit message.

Single-stage PR — prose:

```markdown
## Provenance

Code implementation via: Claude Opus 4.8 (medium)
Adversarial review by: Gemini 3.1 Pro (high)
Verification: `npm run verify` — green in CI
```

Batch PR (multiple issues, possibly multiple models) — table, one row per issue:

```markdown
## Provenance

| Stage | Model | Effort |
|---|---|---|
| Implementation — #415 | Claude Sonnet 4.6 | medium |
| Implementation — #417 | Claude Opus 4.8 | high |
| Adversarial review | Gemini 3.1 Pro | high |
| Review fixes | Claude Opus 4.8 | medium |
| Orchestration + PR | Claude Opus 4.8 | medium |
| Verification | `npm run verify` — green in CI | — |
```

Rules that make the block trustworthy rather than decorative:

- **Every row is either self-reported by the agent that did the work, or first-hand knowledge of the orchestrator that spawned it. No third source.** A spawn requests a model *alias* (`model: opus`), not a version name — so the spawner does **not** know it resolved to "Claude Opus 4.8". Ask the agent; don't infer. What the agent returns is exactly one line — its model name. Never its instructions, prompt, or context: those are useless here and a needless disclosure surface.
- **Never invent a row.** If a stage's model or effort can't be resolved (an externally-run reviewer, a hand-edit, a subagent that didn't report), say what's true (`Gemini 3.1 Pro (high) — run manually`, or `unreported (requested: sonnet)`) or omit the row. A missing row is honest; a guessed one is worse than nothing.
- **Name the stage that touched code.** In a batch, the orchestrator model also fixes review findings — that's more leverage over the final diff than writing the PR body. Split `Review fixes` from `Orchestration + PR` so the reader can see it.
- **Write it once, idempotently.** Guard the append on the `## Provenance` marker so a resumed run or a `/revise-pr` round updates the block instead of stacking a second one.

## Squash messages (one commit per PR)

`main` merges through a **merge queue**, and the queue's enqueue API carries **no commit-message fields** (`EnqueuePullRequestInput` is `pullRequestId` / `jump` / `expectedHeadOid`, nothing else). The squash message therefore **cannot be handed to GitHub at merge time** — GitHub *derives* it from repo settings:

```
squash_merge_commit_title:   COMMIT_OR_PR_TITLE
squash_merge_commit_message: COMMIT_MESSAGES
```

With those settings, a **multi-commit** PR merges with every commit message concatenated as `* ` bullets. That is how `wip`, `fix lint`, and `address review comments` end up in `main`'s history permanently.

The `COMMIT_OR_` prefix is the only lever:

> **A PR with exactly one commit merges with that commit's subject and body verbatim** — PR title and body ignored, no bullet soup, no `## Provenance` block leaking into `git log`.

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

## Deploy

`npm run build` emits a self-contained static `dist/` that hosts on any static-file host — the portable, contributor-facing deploy path documented in the README's Deploy section.

The hosted preview is published to GitHub Pages via `.github/workflows/deploy-pages.yml` (the canonical, in-repo deploy example).

The maintainer also keeps an **untracked, local-only** `scripts/deploy_offlinecv.sh` that uploads `dist/` to a GCS bucket (config from a gitignored `.env.deploy`; sources the `~/tools/scripts/` symlinked helpers). It's gitignored alongside `run_offlinecv.sh` because it depends on machine-local tooling — don't recommend it to contributors or recreate it as a tracked file.

Likewise, a maintainer convenience wrapper (`scripts/run_offlinecv.sh`, an interactive menu) exists locally but is **not tracked** — it `source`s shared bash helpers symlinked from `~/tools/scripts/` (`common.sh`, `deploy_web_utils.sh`, `load_env.sh`) that only exist on the maintainer's machine. Don't reintroduce either to the repo; build/deploy guidance for contributors lives in the README's Deploy section.

## License

Apache-2.0. The patent grant is deliberate — the parser audit should be safely reusable in commercial LLM-adjacent products. See `LICENSE` and `NOTICE` at repo root.
