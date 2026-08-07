# Rewrite eval report

- **Started:** 2026-08-07T03:11:15.457Z
- **App version:** `72ad3c1`
- **Models:** 1
- **Prompt variants:** 3
- **Fixtures:** 5
- **LLM judge:** disabled (default)

## Aggregate (per model × variant)

| Model | Variant | Numbers | One-line | Verb | Length | No-preamble | Dedup | Steering | Judge | **Aggregate** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen 2.5 (1.5B) | Baseline (shipped) | 40% | 100% | 40% | 100% | 100% | 0% | 100% | — | **69%** |
| Qwen 2.5 (1.5B) | Terse (rules-only) | 80% | 100% | 60% | 100% | 100% | 0% | 100% | — | **77%** |
| Qwen 2.5 (1.5B) | Examples-led (few-shot) | 20% | 100% | 20% | 100% | 100% | 0% | 100% | — | **63%** |

## Per-cell records

### Qwen 2.5 (1.5B)

#### Baseline (shipped)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Steering | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | PASS | fail | PASS | PASS | — | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | PASS | PASS | PASS | — | — |  |
| redundant-support-lead | redundant | 5 → 5 | PASS | fail | PASS | PASS | fail | — |  |
| steering-forbidden-word | weak | 4 → 4 | fail | fail | PASS | PASS | — | PASS |  |

#### Terse (rules-only)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Steering | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | PASS | fail | PASS | PASS | — | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | PASS | PASS | PASS | — | — |  |
| numeric-growth-pm | numeric | 5 → 5 | PASS | PASS | PASS | PASS | — | — |  |
| redundant-support-lead | redundant | 5 → 5 | PASS | fail | PASS | PASS | fail | — |  |
| steering-forbidden-word | weak | 4 → 4 | PASS | PASS | PASS | PASS | — | PASS |  |

#### Examples-led (few-shot)

| Fixture | Kind | In → Out | Numbers | Verb | Length | Preamble | Dedup | Steering | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weak-marketing-generalist | weak | 5 → 5 | fail | fail | PASS | PASS | — | — |  |
| strong-backend-engineer | strong | 5 → 5 | fail | fail | PASS | PASS | — | — |  |
| numeric-growth-pm | numeric | 5 → 5 | fail | fail | PASS | PASS | — | — |  |
| redundant-support-lead | redundant | 5 → 5 | PASS | fail | PASS | PASS | fail | — |  |
| steering-forbidden-word | weak | 4 → 4 | fail | PASS | PASS | PASS | — | PASS |  |

