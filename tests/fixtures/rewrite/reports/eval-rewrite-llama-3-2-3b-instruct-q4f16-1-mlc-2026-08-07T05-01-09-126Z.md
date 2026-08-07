# Rewrite eval report

- **Started:** 2026-08-07T04:57:58.840Z
- **App version:** `72ad3c1`
- **Models:** 1
- **Prompt variants:** 3
- **Fixtures:** 5
- **LLM judge:** disabled (default)

## Aggregate (per model × variant)

| Model | Variant | Numbers | One-line | Verb | Length | No-preamble | Dedup | Steering | Judge | **Aggregate** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Llama 3.2 (3B) | Baseline (shipped) | 0% | 100% | 40% | 100% | 100% | 0% | 100% | — | **63%** |
| Llama 3.2 (3B) | Terse (rules-only) | 20% | 100% | 40% | 100% | 0% | 0% | 100% | — | **51%** |
| Llama 3.2 (3B) | Examples-led (few-shot) | 20% | 100% | 0% | 100% | 0% | 0% | 100% | — | **46%** |

## Per-cell records

### Llama 3.2 (3B)

#### Baseline (shipped)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Steering | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | fail | fail | PASS | PASS | — | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | fail | PASS | PASS | — | — |  |
| redundant-support-lead | redundant | 5 → 5 | fail | fail | PASS | PASS | fail | — |  |
| steering-forbidden-word | weak | 4 → 4 | fail | PASS | PASS | PASS | — | PASS |  |

#### Terse (rules-only)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Steering | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | fail | fail | PASS | fail | — | — |  |
| strong-backend-engineer | strong | 5 → 5 | PASS | PASS | PASS | fail | — | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | PASS | PASS | fail | — | — |  |
| redundant-support-lead | redundant | 5 → 5 | fail | fail | PASS | fail | fail | — |  |
| steering-forbidden-word | weak | 4 → 4 | fail | fail | PASS | fail | — | PASS |  |

#### Examples-led (few-shot)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Steering | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | fail | fail | PASS | fail | — | — |  |
| strong-backend-engineer | strong | 5 → 5 | PASS | fail | PASS | fail | — | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | fail | PASS | fail | — | — |  |
| redundant-support-lead | redundant | 5 → 5 | fail | fail | PASS | fail | fail | — |  |
| steering-forbidden-word | weak | 4 → 4 | fail | fail | PASS | fail | — | PASS |  |

