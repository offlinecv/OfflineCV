# How this project uses AI

AI shows up in offlinecv in three places that have nothing to do with each
other, and conflating them is how people end up with the wrong idea about
where their résumé goes. They are: **in the product**, **in how the code gets
written**, and **in the repo's own automation**.

## 1. In the product — on-device, opt-in

The parser itself is not AI. It is a heuristic cascade over pdf.js output
([Architecture at a glance](./architecture.md#the-parse-cascade)), and it runs
with no model at all.

On top of that sit the optional surfaces that do use a local language model.
Each is opt-in, and naming them is more useful than counting them, because the
list grows: flagging where the heuristic parse and the model disagree,
critiquing résumé quality, rewriting a bullet or a section, recovering a résumé
the heuristic parser mangled, matching a pasted job description semantically,
and inferring a posting's sector during a job search. All of them run through
[WebLLM](https://github.com/mlc-ai/web-llm) on **WebGPU**, inside the tab. If
the browser has no WebGPU, the surfaces detect that and say so rather than
falling back to a server.

One control in this lane deliberately points the other way, and it is the one
worth knowing about: the rewrite panel offers to hand you its prompt to run in
a model you already use elsewhere
([`export-prompt.ts`](../src/lib/webllm/export-prompt.ts)). What it copies is
instructions only — no name, no employer, no bullet, asserted against a full
fixture résumé in `export-prompt.test.ts` — and a clipboard write reaches no
network. Where you take it afterwards is your own choice rather than our
default.

| Model | Size | License |
|---|---|---|
| Qwen 2.5 (1.5B) — default | 1630 MB | Apache-2.0 |
| Gemma 2 (2B) | 1895 MB | Restricted-Community |
| Llama 3.2 (3B) | 2264 MB | Restricted-Community |

Registry: [`src/lib/webllm/models.ts`](../src/lib/webllm/models.ts). The
default is Apache-2.0 deliberately, so a fresh install boots without a licence
prompt; the other two are gated behind a consent modal that shows the licence
before anything downloads.

**What crosses the network is the model, not your résumé.** Choosing a model
downloads 1.6–2.3 GB of weights from `huggingface.co` and
`raw.githubusercontent.com` — the one egress this lane has, and the reason the
size is shown before you commit to it. The prompt, the résumé text, and the
output stay in the tab. The full list of what does leave, across every lane, is
[What leaves the tab](./architecture.md#what-leaves-the-tab).

## 2. In how the code gets written — Claude Code, in the open

This repo is developed with [Claude Code](https://claude.ai/code), and the
configuration is committed rather than kept on someone's laptop: `CLAUDE.md`
(the house rules the model reads before writing anything),
[`.claude/settings.json`](../.claude/settings.json), 18 skill files under
`.claude/skills/`, and the hooks under [`scripts/hooks/`](../scripts/hooks/)
that fire on edit, on commit, and when a session ends. Read any of them — they
are the actual instructions, not a sanitised copy.

You will not find `Co-Authored-By: Claude` or a generated-with badge anywhere
in the history. That is a **setting**, not a convention someone remembers to
follow: `attribution` in `.claude/settings.json` blanks the trailer and the
badge and drops the session URL, so the text is never emitted. The reasoning —
including why prose telling a model to suppress its own attribution kept
losing — is in
[AI attribution](./CONTRIBUTING-PROCESS.md#ai-attribution--suppressed-by-configuration-not-by-prose).

**You are not required to use it.** Contribute with whatever you like. The
gates in [How a change gets reviewed and
merged](./pr-review-process.md) do not know or care which editor produced the
diff, and they are the same for everyone.

## 3. In the repo's automation — less than you would guess

The repo's own jobs are ordinary code. The comment moderator
([`moderate-comments.yml`](../.github/workflows/moderate-comments.yml)) is an
account-age threshold plus a list of regexes, and it only ever *hides* a
comment, reversibly, and only from non-members — no model scores anything. The
claim-releaser ([`stale-claims.yml`](../.github/workflows/stale-claims.yml)) is
a date comparison. Neither is AI, and both are deliberately the kind of thing
you can read in one sitting and predict exactly.

## What AI does not get to decide

A PR here may well get an AI review, and that review is **advisory**. Three
things stop it from being anything more, and two of the three are enforced by
configuration rather than by anyone remembering:

- Branch protection requires **one approving review** from a human before a PR
  can merge. A repo admin can bypass it, so read this one as enforced for
  contributors and a convention for maintainers.
- GitHub refuses an approval from a PR's own author, so a run that opens a PR
  and reviews it cannot approve it — the review posts as a plain comment
  carrying its real verdict.
- **The merge is always a person's action.** Nothing in this repo auto-merges.

So the useful way to read an AI review is as a very thorough first pass that
has already checked the mechanical things — did the fixture leak contact data,
is that a raw `<button>`, does the description match the diff — leaving a human
reviewer the judgement calls. If you disagree with a finding, say so on the
thread; a finding that does not reproduce gets dropped, and that is a normal
outcome, not an argument you have to win.

## If you contribute with AI

Use it. Two things are yours regardless of what wrote the diff:

1. **You own the change.** "The model wrote it" is not a review response. If
   you cannot explain why a line is there, it is not ready.
2. **Never paste a real résumé into anything committed.** Test with your own
   locally as much as you like; the fixture PII policy is absolute and
   `npm run check:fixtures` enforces part of it, but it cannot tell whether a
   *name* is synthetic. That judgement stays yours.
