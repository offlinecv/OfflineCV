# Rewrite eval report

- **Started:** 2026-08-07T04:49:02.749Z
- **App version:** `72ad3c1`
- **Models:** 1
- **Prompt variants:** 3
- **Fixtures:** 5
- **LLM judge:** disabled (default)

## Aggregate (per model × variant)

| Model | Variant | Numbers | One-line | Verb | Length | No-preamble | Dedup | Steering | Judge | **Aggregate** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gemma 2 (2B) | Baseline (shipped) | 20% | 100% | 40% | 100% | 100% | 0% | 100% | — | **66%** |
| Gemma 2 (2B) | Terse (rules-only) | 40% | 100% | 40% | 100% | 100% | 0% | 100% | — | **69%** |
| Gemma 2 (2B) | Examples-led (few-shot) | 0% | 100% | 40% | 100% | 100% | 100% | 100% | — | **77%** |

## Per-cell records

### Gemma 2 (2B)

#### Baseline (shipped)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Steering | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | fail | fail | PASS | PASS | — | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | fail | PASS | PASS | — | — |  |
| redundant-support-lead | redundant | 5 → 5 | fail | fail | PASS | PASS | fail | — |  |
| steering-forbidden-word | weak | 4 → 4 | PASS | PASS | PASS | PASS | — | PASS |  |

#### Terse (rules-only)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Steering | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | PASS | fail | PASS | PASS | — | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | fail | PASS | PASS | — | — |  |
| redundant-support-lead | redundant | 5 → 5 | fail | fail | PASS | PASS | fail | — |  |
| steering-forbidden-word | weak | 4 → 4 | PASS | PASS | PASS | PASS | — | PASS |  |

#### Examples-led (few-shot)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Steering | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | fail | fail | PASS | PASS | — | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | PASS | PASS | PASS | — | — |  |
| redundant-support-lead | redundant | 5 → 4 | fail | fail | PASS | PASS | PASS | — |  |
| steering-forbidden-word | weak | 4 → 4 | fail | fail | PASS | PASS | — | PASS |  |

