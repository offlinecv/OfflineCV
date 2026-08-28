# How a change gets reviewed and merged

The path a pull request takes from "I pushed a branch" to "it is in `main`",
and the two rules along it that surprise people. Companion to
[Architecture at a glance](./architecture.md) — that page tells you where your
change goes, this one tells you what happens to it afterwards.

## The path

```
claim an issue          comment on it; a maintainer adds `status:claimed`
      ↓
branch + commit         <your-initials>/<short-slug>, conventional prefix
      ↓
open a PR against main  title in conventional form, `Resolves #<n>` in the body
      ↓
CI runs `verify`        the one required check — see below
      ↓
review                  findings sorted Blocking / Secondary / Nit
      ↓
one approval            required; a later push dismisses it
      ↓
merge queue             squash, all-green, up to 5 built at once
      ↓
main
```

Claiming is the step people skip. An issue with the `status:claimed` label
already has someone on it, and a claim with no linked PR and no activity for
**7 days** is released automatically by
[`stale-claims.yml`](../.github/workflows/stale-claims.yml). Full rules:
[Claiming an issue](../CONTRIBUTING.md#claiming-an-issue).

## What CI actually checks

Branch protection on `main` requires exactly **one** status check, the `verify`
job in [`ci.yml`](../.github/workflows/ci.yml). That single name hides the
steps below, and knowing which one failed saves you a guess:

| Step | Fails when |
|---|---|
| `npm run typecheck` | TypeScript does not compile |
| `npm run lint` | ESLint — including the design-system and colour-token rules |
| `npm run check:fixtures` | a committed résumé PDF carries real contact data |
| `npm run check:baselines` | a known-failure exemption is charged to a closed issue |
| `npm run check:core` | the publishable `@offlinecv/core` tarball is broken |
| `npm run test:coverage` | a test fails |
| `npm run build` | the production bundle does not build |
| fallow static analysis | never — the audit's exit code is swallowed, and the report is uploaded to code scanning |

`check:fixtures` runs **before** the test suite on purpose: the repo is public,
so a leaked PDF is the one failure that cannot be undone by a follow-up commit.
See the PII policy in
[CONTRIBUTING-PROCESS.md](./CONTRIBUTING-PROCESS.md#test-fixtures--pii-policy-non-negotiable)
before you add any fixture.

Run the local gates first — `npm run verify:quick` while you iterate,
`npm run verify` before you push (a `pre-push` hook runs it for you). They are
not the sequence above: `verify` scopes the test run to the files you changed,
where CI always runs the whole suite. Treat a green `verify` as a fast
pre-flight, not a promise that CI will pass.

## What a reviewer is looking for

Findings are sorted into three buckets, and the label is a claim about the
merge, not about tone:

- **Blocking** — must change before merge: a bug that fires on normal use, real
  contact data in a fixture, a hardcoded colour where a semantic token belongs,
  a raw `<button>` where the design-system primitive belongs, or a description
  that claims behaviour the code does not have.
- **Secondary** — a real pattern worth fixing, not a merge blocker.
- **Nit** — style and polish, explicitly non-blocking.

Two properties of the review are worth knowing as an author. The **issue is the
spec** — a PR that says `Resolves #N` while an acceptance criterion of #N is
unimplemented is Blocking, because merging closes the issue and nothing reopens
it. And the **PR description is read last**, as a claim to check against the
diff rather than a guide to what to look at, so a description that overstates
what changed is itself a finding.

## The two rules that surprise people

**One commit per PR.** `main` merges through a merge queue, and the queue's
enqueue API carries no commit-message fields — so GitHub *derives* the squash
message from the repo's settings, which concatenate every commit on the branch
as bullets. A three-commit PR lands `wip` and `fix lint` in `main`'s history
permanently. Collapse the branch before it reaches the queue; the full
derivation is in
[Squash messages](./CONTRIBUTING-PROCESS.md#squash-messages-one-commit-per-pr).

**A push dismisses the approval.** `main` has dismiss-stale-reviews-on-push
enabled, so pushing after someone approves sends the PR back to needing one.
Address every comment in one pass and push once, then reply on the threads —
not a push per comment.

## How long it takes

Of the **last 100 merged PRs** (snapshot 2026-08-28): median time open **4.7
hours**, **86%** merged within a day, median **8** files changed, and **73**
carried at least one review. Re-derive it yourself rather than trusting the
snapshot:

```bash
gh pr list --repo offlinecv/OfflineCV --state merged --limit 100 \
  --json number,createdAt,mergedAt,changedFiles,reviews
```

Nobody is watching the queue for you, though. If a PR has been sitting, say so
on the issue or in chat — silence from a reviewer who is mid-review and silence
from one who has not opened it look identical from the author's side.
