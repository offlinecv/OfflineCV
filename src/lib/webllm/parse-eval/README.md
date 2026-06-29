# Parse-resume eval harness

Dev-only eval harness for the LLM structured-parse provider
([issue #241](https://github.com/resumelint-org/resumelint/issues/241)).

## What it measures

Given a loaded `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` model (or another registry
model), runs `parseResumeWithLlm` over 3 inline PII-safe resume fixtures and
scores each against ground-truth expected values:

| Dimension | Method |
| --- | --- |
| **valid-JSON** | Did the model produce parseable JSON with ≥1 non-null field? |
| **scalar-acc** | Fraction of non-null expected scalars (name/email/phone/location/summary) that exactly match (case-insensitive). |
| **skills-acc** | Jaccard set overlap between expected and actual skill sets. |
| **exp-acc** | Fraction of expected experience entries whose company+title appear in the actual result. |
| **edu-acc** | Fraction of expected education entries whose institution+degree appear in the actual result. |

## How to run

```sh
npm run dev  # start the Vite dev server
npm run eval:parse
# opens http://localhost:5173/parse-eval.html
```

1. Select **Qwen 2.5 (1.5B)** (default, Apache-2.0) in the model picker.
2. Click **Run eval** — the model downloads on first run (~1.6 GB via WebGPU);
   subsequent runs use the cached IndexedDB copy.
3. When done, click **Download Markdown report**.
4. Paste the Markdown table into the **PR #241 description** under
   "Eval results".

To compare another model, open a fresh tab (or refresh) and pick a different
one. One model per tab — cycling multi-GB models in a single tab is fragile on
consumer GPUs.

## Where to paste results

PR #241 description, under a heading `## Eval results (parse-resume)`. Include:

- The model name + version used.
- The full table from the Markdown report.
- Any qualitative notes (e.g. which fixture types were hardest).

## Results (fill after running)

> TODO: run `npm run eval:parse`, download the Markdown report, and paste the
> table here before merging PR #241.

| fixture | valid-JSON | scalar-acc | skills-acc | exp-acc | edu-acc |
| --- | --- | --- | --- | --- | --- |
| software-engineer | _TODO_ | _TODO_ | _TODO_ | _TODO_ | _TODO_ |
| marketing-coordinator | _TODO_ | _TODO_ | _TODO_ | _TODO_ | _TODO_ |
| recent-grad | _TODO_ | _TODO_ | _TODO_ | _TODO_ | _TODO_ |
| **Overall mean** | _TODO_ | _TODO_ | _TODO_ | _TODO_ | _TODO_ |

## PII policy

All fixtures in `fixtures.ts` are synthetic:

- Fake names, `@example.com` emails.
- Phones use a **real area code** + `555` exchange + `0100`–`0199` subscriber
  (e.g. `(312) 555-0142`). Never use `555` as the area code — it fails
  `libphonenumber-js` `isValid()`.
- Fictional employers and schools.

If you add a fixture, verify it satisfies this policy before merging. The repo
is public and all text is indexable.

## Not bundled / no prod code

`parse-eval.html` is a dev-only sibling of `eval-rewrite.html` and
`jd-spike.html`. Vite serves it from the dev server but does NOT include it
in `dist/` (only `index.html` is the production build input). No file in this
directory is imported by `src/main.tsx` or any shipped module.

## Files

| File | Purpose |
| --- | --- |
| `fixtures.ts` | 3 inline PII-safe resume fixtures with ground-truth `expected` values |
| `score.ts` | Pure, model-free scorer (scalar / skills / experience / education) |
| `score.test.ts` | Vitest unit tests for the scorer — runs in CI, no model required |
| `report.ts` | JSON + Markdown report renderers |
| `parse-eval-browser.ts` | Browser entry (model picker, run button, download wiring) |
| `README.md` | This file |
| `../../parse-eval.html` | Dev-only HTML page (repo root) |
