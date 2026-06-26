# JD Spike Harness

Dev-only spike for issue [#198](https://github.com/resumelint-org/resumelint/issues/198).
Validates Qwen2.5-1.5B (the default WebLLM model) for two tasks before any production
design commitment:

1. **JD requirement extraction** (call 1) — extract structured `JdRequirement[]` from job-description text.
2. **Per-requirement evidence judging** (call 2) — produce `RequirementVerdict[]` by matching requirements against a flattened resume projection.

## What the spike measures

- **Token budget headroom** — max `prompt_tokens` seen vs. the model's 32 768-token context.
- **JSON reliability** — rate of strict parse, repaired parse, and outright failures per call type.
- **Latency** — cold (first repeat) and warm (mean of subsequent repeats) latency for both call types.

## How to run

1. Start the dev server: `npm run dev`
2. Open: `http://localhost:5173/resumelint/jd-spike.html`
3. Select **Qwen 2.5 (1.5B)** (default) in the model picker.
4. Set **Repeats** (default 3 — higher values give better failure-rate estimates).
5. Click **Run spike** — the model downloads on first run (~1.6 GB); subsequent runs use the cached IndexedDB copy.
6. When done, click **Download Markdown report**.
7. Paste the Markdown into issue [#156](https://github.com/resumelint-org/resumelint/issues/156) as the spike findings.

## Not bundled / no prod code

`jd-spike.html` is a dev-only sibling of `eval-rewrite.html`. Vite serves it from the
dev server but does NOT include it in `dist/` (only `index.html` is the production build
input). No spike file is imported by `src/main.tsx` or any shipped module.

## Files

| File | Purpose |
| --- | --- |
| `types.ts` | Spike-local types (`JdRequirement`, `RequirementVerdict`, `SpikeReport`, …) |
| `fixtures.ts` | 3 inline PII-safe test cases (`music-intern`, `software-engineer`, `years-mismatch`) |
| `prompts.ts` | Prototype prompts for extract (call 1) and judge (call 2) |
| `measure.ts` | Run logic + per-call measurement capture + report renderers |
| `jd-spike-browser.ts` | Browser entry (model picker, run button, download wiring) |
| `../../jd-spike.html` | Dev-only HTML page (repo root, mirrors `eval-rewrite.html`) |
