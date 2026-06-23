# Rewrite eval report

- **Started:** 2026-06-23T19:01:41.578Z
- **App version:** `8c12fb0`
- **Models:** 1
- **Prompt variants:** 3
- **Fixtures:** 4
- **LLM judge:** disabled (default)

## Aggregate (per model × variant)

| Model | Variant | Numbers | One-line | Verb | Length | No-preamble | Dedup | Judge | **Aggregate** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gemma 2 (2B) | Baseline (shipped) | 0% | 100% | 25% | 100% | 100% | 0% | — | **54%** |
| Gemma 2 (2B) | Terse (rules-only) | 25% | 100% | 25% | 100% | 100% | 0% | — | **58%** |
| Gemma 2 (2B) | Examples-led (few-shot) | 0% | 100% | 25% | 100% | 100% | 0% | — | **54%** |

## Per-cell records

### Gemma 2 (2B)

#### Baseline (shipped)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | fail | fail | PASS | PASS | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | fail | PASS | PASS | — |  |
| redundant-support-lead | redundant | 5 → 5 | fail | fail | PASS | PASS | fail |  |

#### Terse (rules-only)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | PASS | fail | PASS | PASS | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | fail | PASS | PASS | — |  |
| redundant-support-lead | redundant | 5 → 5 | fail | fail | PASS | PASS | fail |  |

#### Examples-led (few-shot)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | fail | fail | PASS | PASS | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | fail | PASS | PASS | — |  |
| redundant-support-lead | redundant | 5 → 5 | fail | fail | PASS | PASS | fail |  |

