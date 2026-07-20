---
name: create-gh-issue
description: File a thorough, self-contained GitHub issue against offlinecv/OfflineCV — full analysis, implementation plan, acceptance criteria — using the scripts/create-gh-issue.sh writer so backticks/tables/code blocks survive intact. Use when the user says "create an issue", "file an issue", "/create-gh-issue", or wants a well-scoped issue written from the current conversation.
---

# Create GitHub Issue (offlinecv)

File a comprehensive, **self-contained** issue against `offlinecv/OfflineCV`.
The issue must carry enough detail that someone with **no prior context** (a
contributor after `/clear`, or another intern) can implement it start to finish.

This skill is the intern-facing, in-repo version of the maintainer's private
issue tooling. It depends on nothing outside this checkout: only `gh`
(authenticated) and `scripts/create-gh-issue.sh`. No `~/tools`, no Linear,
no machine-local `.env`. GitHub-only — offlinecv has no Linear backend.

## Input

`$ARGUMENTS`, if present, is a free-form hint about the issue's subject — a topic,
not an issue number or repo name.

**The issue number is not yours to choose.** GitHub assigns it when the issue is
created; the "next" number is not predictable (other people and automations file
too). If the conversation or `$ARGUMENTS` names a specific number, treat it as an
unverified guess: **strip it** from the title and body, and don't reference it
anywhere (branch names, commits, cross-links) until the script reports the real
`owner/repo#N` in the Create step.

First, confirm the backend is reachable (one line, non-blocking):

```bash
gh repo view --json nameWithOwner -q .nameWithOwner   # → offlinecv/OfflineCV
```

If `gh` isn't installed or authenticated, stop and tell the user to run
`gh auth login` — don't try to work around it.

## Process

### Phase 1 — Gather and verify context

1. **Review the conversation.** Identify: the problem or feature request, the
   code areas involved, and any analysis already done.

2. **If context is thin, investigate the codebase.** Prefer codegraph tools
   (`codegraph_search`, `codegraph_context`, `codegraph_callers/callees/impact`)
   over raw grep for symbol lookups and call-graph traversal — `.codegraph/` is
   present in this repo. Read the actual source to confirm current behavior;
   don't describe the code from memory.

3. **Build a root-cause analysis (bugs) or technical design (features):**
   - Name ALL affected files with specific line numbers.
   - Trace the data flow from entry point to symptom.
   - For parser/scoring bugs, name the cascade tier and function (e.g.
     `matchSectionHeader` in `src/lib/heuristics/regex.ts`) — see the Pipeline
     shape section of `CLAUDE.md`.

### Phase 2 — Draft the plan

4. **Step-by-step implementation plan:** ordered steps, each naming specific
   files and what changes, with short code snippets showing the approach (enough
   to be unambiguous, not full implementations). Flag any new files.

5. **Acceptance criteria as a checklist:** each independently testable. Include
   regression checks (existing behavior must not break) and the edge cases found
   during analysis. For parser/scoring changes, name the corpus/round-trip
   invariant that must still hold (`corpus.test.ts`, `corpus-roundtrip.test.ts`).

5b. **Reuse analysis — required when the issue adds a UI/workflow surface.**
   offlinecv enforces a Reuse Gate (`CLAUDE.md` → "Component architecture & reuse").
   Before finalizing a body that proposes a **new component, panel, dialog, or
   page**, search for an existing surface that already owns that capability:
   - Check the design-system (`src/design-system/`) for an existing primitive or
     shared component before proposing any `<button>`, modal, dropzone, or banner.
   - Check `src/components/features/` for a feature surface that already owns the
     job (`codegraph_search` on the capability verb; grep fallback).
   - Emit a **`### Reuse analysis`** section: **Capability** (what it does),
     **Existing surfaces found** (`file:symbol`, or "none"), **Decision**
     (`extend <surface>` — the default — or `build new because <reason>`). Soft
     gate: a justified "build new" passes, but the section is mandatory.
     "Faster to add a new one" is not a justification.

### Phase 3 — Ask only if genuinely ambiguous

By now the conversation usually holds enough to draft a complete issue. Don't echo
the full plan back for line-by-line approval.

6. **Decide whether anything material is ambiguous** — a scope boundary, which of
   two reasonable approaches, an acceptance threshold. Stylistic polish doesn't
   qualify. If nothing does, go straight to Phase 4.

7. **If you must ask, ask narrowly** — AskUserQuestion, at most 1–2 focused
   questions with concrete options. Never "does this look good?".

### Phase 4 — Create the issue

8. **State what you're about to file, in one line** — title + labels + milestone
   (if any) — before the write. Informational, not an approval gate.

9. **Write the body to a _unique_ tempfile.** Never a fixed path like
   `/tmp/issue-body.md`: a stale file from an earlier session gets silently
   re-filed, and the Write tool refuses to overwrite a file it hasn't read.
   Generate a fresh suffix per call:

   ```bash
   date +%Y%m%d-%H%M%S        # e.g. 20260708-120000
   ```

   Use the Write tool to put the markdown body at
   `/tmp/issue-body-<that-timestamp>.md`. If Write is rejected as already-existing,
   the path collided — pick another suffix. Use the exact same path in the next
   step.

9b. **Do NOT hard-wrap the body.** Write each paragraph, list item, and table row
   as ONE physical line, however long, and let GitHub soft-wrap it to the reader's
   viewport. Nothing in this skill or in `create-gh-issue.sh` reflows text — a
   manual ~80-column wrap survives verbatim into the issue and into every later
   `gh issue edit` / `/clarify` round, where it turns a one-word change into a
   whole-paragraph reflow diff. It is also self-inconsistent: tables and fenced
   code blocks can't be wrapped, so a hard-wrapped body wraps some content and not
   the rest.

   Hard line breaks are meaningful in exactly three places — keep them there:
   - **inside fenced code blocks** (` ``` `), where they are the content;
   - **between** block elements (the blank line separating paragraphs, list items,
     headings);
   - a deliberate **two-space** or `\` line break, if you actually want a `<br>`.

10. **Run the writer** (from the repo root):

    ```bash
    scripts/create-gh-issue.sh \
      --title "<the issue title>" \
      --body-file /tmp/issue-body-<timestamp>.md \
      --labels bug,improvement \
      [--assignee @me]            # optional; default = no assignee
      [--milestone "P1 · Friends & Family"]   # optional; title or number
    ```

    - Body is passed as a file, so backticks / tables / fenced code blocks survive
      shell escaping — write real markdown, don't flatten it.
    - `--labels` are required and must already exist in the repo (see Labels
      below). An unknown label makes `gh` fail with exit 1.
    - No `--priority` / `--cycle` / `--blocked-by` — GitHub issues don't model
      those. Record a blocker with a follow-up comment (`gh issue comment <N>
      --body "Blocked by #M"`).

11. **Capture stdout** — one tab-separated line: `<owner/repo>#<number>\t<URL>`.

12. **Report to the user** the identifier, URL, labels, and milestone. Mention the
    body can be revised with `gh issue edit <N> --body-file <file>` or via
    `/clarify <N>`, and that `/triage-issue <N>` places it on the roadmap board if
    it isn't there yet.

**Error handling:**
- Exit 2 = arg/env error (missing required arg, `gh` not on PATH, or no GitHub
  remote detected). For the last, run from the repo root or pass `--repo
  offlinecv/OfflineCV`.
- Exit 1 = `gh issue create` failed. Most common cause: a `--labels` value that
  doesn't exist. Check `gh label list`; drop or correct the label and retry. If a
  genuinely new label is needed, ask the user before `gh label create`.

## Labels (required)

Every issue needs at least one **type** label; add the domain labels that fit
(most issues carry 2–3). These are the labels that exist in
`offlinecv/OfflineCV` today — check `gh label list` if unsure:

### Type (pick at least one)
| Label | When |
|-------|------|
| `bug` | Something is broken |
| `feature` | New functionality |
| `enhancement` | New feature or request (GitHub's default; overlaps `feature`) |
| `improvement` | Enhancing existing functionality |
| `refactor` | Code restructuring, no behavior change |
| `chore` | Maintenance, deps, CI config, cleanup |

### Domain / other (add all that match)
| Label | When |
|-------|------|
| `testing` | Tests, test infrastructure, coverage, corpus fixtures |
| `documentation` | READMEs, guides, docs |
| `good first issue` | Well-scoped, low-context — good for a newcomer |
| `help wanted` | Needs extra attention |

If the exact label you want isn't in `gh label list`, either pick the closest
existing one or ask the user before creating a new label — don't invent taxonomy.

## Milestones (the roadmap)

offlinecv plans on four milestones (read live with
`gh api repos/offlinecv/OfflineCV/milestones --jq '.[] | "\(.number)\t\(.title)"'`).
Pass `--milestone` by title or number when the issue's home is clear:

| # | Title | Role |
|---|-------|------|
| 9 | `P1 · Friends & Family` | Core loop trustworthy on normal resumes (drop → correct parse + score → safe download) |
| 10 | `P2 · Design Partner` | Differentiators live (semantic JD-match, AI rewrite), reliability, score transparency |
| 11 | `P3 · Public Launch` | Polish + standards (JSON Resume export, profiles model, JD-match eval/docs) |
| 12 | `P4 · Post-Public` | Job-search maturation, local-first storage, resume library, job tracker |

If the milestone is genuinely ambiguous, leave it off and let `/triage-issue`
place it — don't guess.

## Quality standard

The body must be **self-contained**. Someone reading it after `/clear` with zero
prior context must be able to: understand the problem completely, know exactly
which files to read and modify, follow the steps without ambiguity, and verify
their work against the acceptance criteria. Avoid vague language ("update as
needed", "handle appropriately") — every step must be specific.
