# Markdown ingest fixtures

`.md` résumés for the **markdown import path** (`#552`) — dropped-file text that
feeds `parseMarkdownFile` → `runCascadeFromMarkdown`. These are NOT part of the
PDF corpus: `corpus.test.ts` walks `tests/fixtures/pdfs/` for `*.pdf` only, so
nothing here is snapshot-baked and nothing here needs a `.expected.json`.

**PII — hard rule.** Same rule as the PDF corpus (`../pdfs/CLAUDE.md`): every
fixture uses a synthetic persona — fake name, `@example.com` email, and a phone
with a **real area code + `555` exchange + `0100`–`0199` subscriber**, e.g.
`(312) 555-0123`. Never an area-code-`555` number like `(555) 010-0123`: `555`
is an invalid NANP area code, so `libphonenumber-js` rejects it and the phone
silently drops out of the score.

`npm run check:fixtures` scans **PDFs under `tests/fixtures/pdfs/` only**, so
files in this directory are **not** covered by that gate. The judgement is
manual — read the fixture before you add or change one.

| Fixture | Guards |
|---|---|
| `inline-links.md` | `#610` — inline `[label](url)` / autolink flattening, and that a body-section URL never reaches the contact card |
| `reference-links.md` | `#611` — reference-style `[label][ref]` / `[label][]` / `[label]` resolution, that `[ref]: url` definition lines never become content (including from the profile band, where they otherwise become `website_url`), and that an *undefined* reference stays literal |
