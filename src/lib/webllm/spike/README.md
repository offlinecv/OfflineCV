# JD Spike Harness

Dev-only spike for issue [#198](https://github.com/offlinecv/OfflineCV/issues/198).
Validated Qwen2.5-1.5B (then the default WebLLM model) for two tasks before any production
design commitment; it now defaults to the shipped model and can run any dev-only candidate
from `../eval/candidate-models.ts`:

1. **JD requirement extraction** (call 1) — extract structured `JdRequirement[]` from job-description text.
2. **Per-requirement evidence judging** (call 2) — produce `RequirementVerdict[]` by matching requirements against a flattened resume projection.

## What the spike measures

- **Token budget headroom** — max `prompt_tokens` seen vs. the context window the report states (see the note in `measure.ts`).
- **JSON reliability** — rate of strict parse, repaired parse, and outright failures per call type.
- **Latency** — cold (first repeat) and warm (mean of subsequent repeats) latency for both call types.

## How to run

1. Start the dev server: `npm run dev`
2. Open: `https://localhost:5173/jd-spike.html`
3. Pick a model in the dropdown (the shipped model is preselected).
4. Set **Repeats** (default 3 — higher values give better failure-rate estimates).
5. Click **Run spike** — the model downloads on first run (1–2 GB); subsequent runs use the cached copy.
6. When done, click **Download Markdown report**.
7. Paste the Markdown into issue [#156](https://github.com/offlinecv/OfflineCV/issues/156) as the spike findings.

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
| `jd-spike-browser.ts` | Browser entry (candidate dropdown, run button, download wiring) |
| `../../jd-spike.html` | Dev-only HTML page (repo root, mirrors `eval-rewrite.html`) |
