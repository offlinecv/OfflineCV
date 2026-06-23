# Rewrite eval report

- **Started:** 2026-06-23T18:57:10.380Z
- **App version:** `8c12fb0`
- **Models:** 1
- **Prompt variants:** 3
- **Fixtures:** 4
- **LLM judge:** disabled (default)

## Aggregate (per model × variant)

| Model | Variant | Numbers | One-line | Verb | Length | No-preamble | Dedup | Judge | **Aggregate** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen 2.5 (1.5B) | Baseline (shipped) | 50% | 100% | 50% | 100% | 100% | 0% | — | **67%** |
| Qwen 2.5 (1.5B) | Terse (rules-only) | 50% | 100% | 50% | 100% | 100% | 0% | — | **67%** |
| Qwen 2.5 (1.5B) | Examples-led (few-shot) | 50% | 100% | 0% | 100% | 100% | 0% | — | **58%** |

## Per-cell records

### Qwen 2.5 (1.5B)

#### Baseline (shipped)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | PASS | fail | PASS | PASS | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | PASS | PASS | PASS | — |  |
| redundant-support-lead | redundant | 5 → 5 | PASS | fail | PASS | PASS | fail |  |

#### Terse (rules-only)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | PASS | fail | PASS | PASS | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | PASS | PASS | PASS | — |  |
| redundant-support-lead | redundant | 5 → 5 | PASS | fail | PASS | PASS | fail |  |

#### Examples-led (few-shot)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | fail | fail | PASS | PASS | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | fail | PASS | PASS | — |  |
| numeric-growth-pm | numeric | 5 → 5 | PASS | fail | PASS | PASS | — |  |
| redundant-support-lead | redundant | 5 → 5 | PASS | fail | PASS | PASS | fail |  |

