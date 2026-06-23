# Rewrite eval fixtures

Synthetic résumé-section fixtures consumed by the rewrite-quality eval
harness (issue #65; see `src/lib/webllm/eval/README.md`).

## Layout

```
tests/fixtures/rewrite/
├── weak.json        # vague bullets, no metrics, weak verbs
├── strong.json      # already-strong bullets the rewrite should leave intact
├── numeric.json     # bullets dense with metrics — number-preservation stress
├── redundant.json   # deliberate duplicates the rewrite should collapse
└── reports/         # committed reports from local WebGPU runs
```

## Fixture shape

```json
{
  "id": "kebab-case-id",
  "kind": "weak | strong | numeric | redundant",
  "description": "What this fixture is exercising, surfaced in the report.",
  "bullets": ["...", "..."]
}
```

`parseFixture` in `src/lib/webllm/eval/fixtures.ts` validates the shape
at module load; a malformed file throws before any eval runs.

## PII policy

The repo's general PII rule
(`tests/fixtures/pdfs/README.md` Privacy section) applies to these
fixtures too: **synthetic personas only**. Bullet fixtures don't carry
contact info, but keep employer names, dates, locations, and project
details fictional. The repo is public — anything you commit is
permanently searchable, even after a later removal commit.

The committed reports under `reports/` are derived from these fixtures
running through models locally; they inherit the same PII-cleanliness as
long as the fixtures themselves stay clean.

## Adding a fixture

1. Drop a new JSON file in this directory matching the shape above.
2. Append an `import` + `parseFixture(...)` line in
   `src/lib/webllm/eval/fixtures.ts::REWRITE_FIXTURES`.
3. Run `npm run test src/lib/webllm/eval/fixtures.test.ts` to verify it
   loads.
4. Run `npm run eval:rewrite` locally (WebGPU required) to regenerate
   committed reports.
