# Segmentation-as-source-of-truth — design spike (#127)

Spike for [#127](https://github.com/offlinecv/OfflineCV/issues/127), under the section-recognizer epic [#109](https://github.com/offlinecv/OfflineCV/issues/109).

**Status:** design only — no production code changed by this issue (acceptance criterion). Implementation lands as the sequenced follow-up issues at the end of this doc.

**Note on the moving target:** issue [#126](https://github.com/offlinecv/OfflineCV/issues/126) is concurrently splitting `src/lib/heuristics/extract-fields.ts` into `src/lib/heuristics/extract/*.ts`. All `extract-fields.ts:NNN` citations below are against the current main baseline (what is in this worktree). Follow-ups should target the **post-split** module paths once #126 merges; the per-symbol names (`extractSkills`, `looksLikeContactLink`, `disambiguateCompanyTitle`, …) are stable across the split and are the durable anchors.

---

## 0. The thesis, restated precisely

The cascade already computes a sectioned structure: `splitIntoSections` / `splitIntoSectionsWithMarkdown` produce `PdfSection[]` (`sections.ts:43`, `:383`, `:526`), and `buildHeuristicResult` (`openresume.ts:166`) fans those sections out to the field extractors. **But that structure is private to `buildHeuristicResult` and is discarded at the function boundary.** Only the flattened `parsed` fields, `fieldConfidence`, `rawText`, and a single hand-picked slice (`skillsSectionLines` → `skillsSectionText`) survive into `CascadeResult`.

So every downstream consumer that needs to know "which section did this line come from?" — chiefly the scorer, but also several extractors operating on already-flattened text — has to **re-derive section membership from raw text with a template-specific predicate**, because the real segmentation is gone. That is the leak. The fix is not "build segmentation" (it exists); it is **stop throwing it away** — promote the `PdfSection[]` to a typed field on `CascadeResult` and let the scorer (and, longer term, the bullet pooler) consume it directly.

A useful three-way taxonomy for every catalogued patch:

- **(S) Segmentation-rooted** — the patch exists *only* because the consumer lost section membership. Centralizing segmentation **deletes** it.
- **(B) Boundary-imprecision** — segmentation ran but drew the line in the wrong place (a skills line bled into experience, a footer link landed in projects). Centralizing segmentation **subsumes** it *if* boundary detection improves; otherwise it stays but moves *into* the segmentation layer instead of the field extractor.
- **(H) Genuine heuristic** — the patch is real domain inference (company-vs-title, mononym detection, redacted-date credit) that no amount of correct sectioning removes. **Stays** as a deterministic heuristic, or defers to the WebLLM tier (#3).

The whole point of the spike is to sort the catalog into these buckets honestly, because only the (S) rows are pure win and only they justify the interface change on their own.

---

## 1. Inventory of segmentation-rooted downstream patches

### 1.1 — #30 — bulleted skills judged as experience bullets (the canonical (S) case)

The scorer's bullet pool is built by `extractBulletsFromText(input.rawText, …)` (`score.ts:612`), which walks **raw text** and treats every marker-led line as an experience bullet. Bulleted skills sections ("• Project management", "• Data analysis") are structurally bullets, so they entered the Specificity/Structure pool and got judged by the action-verb / metric / length rules — tanking the score of a perfectly good skills list.

The fix threaded a side-channel end to end:

| Layer | Symbol | file:line |
|---|---|---|
| Cascade collects the slice | `skillsSectionLines` build | `openresume.ts:294` |
| Cascade serializes it onto the result | `skillsSectionText: heuristic.skillsSectionLines.join("\n")` | `cascade.ts:198`, `cascade.ts:408` |
| Result type carries it | `CascadeResult.skillsSectionText?` | `types.ts:189` |
| Scorer input accepts it | `AnonymousAtsScoreInput.skillsSectionText?` | `score.ts:532` |
| Scorer builds an exclusion set | `buildSkillsExclusion` | `score.ts:583` |
| Scorer applies the exclusion | `extractBulletsFromText(text, excludeStripped)` + the `excludeStripped?.has(trimmed)` drop | `score.ts:612`, `score.ts:639` |
| UI consumers pass it through | `App.tsx:52`, `useResumeAnalysis.ts:99`, `corpus.test.ts:108` | — |

**Bucket: (S).** This is the architectural tell #127 calls out. The scorer cannot answer "is this line a skill?" because it only has `rawText`; the cascade therefore hands it a pre-sliced copy of one section. The skills exclusion set (`buildSkillsExclusion`) is *literally a hand-serialized fragment of the section structure the cascade already had and threw away.* If the scorer received `PdfSection[]`, it would build the experience-bullet pool from the experience/projects/achievements sections and never look at skills lines at all — `skillsSectionText`, `buildSkillsExclusion`, and the `excludeStripped` parameter all delete.

Triggering template: Microsoft **Word** column-skills templates (the #29/#30/#31 family; see `word/` fixtures). The same templates render skills as a borderless multi-column bulleted table, which is exactly what `splitColumnCells` (`extract-fields.ts:634`) was added to recover.

### 1.2 — Profile links bleeding into the Skills token pool

`extractSkills` (`extract-fields.ts:656`) operates on the `skills` `PdfSection`, but a LinkedIn/GitHub/portfolio link sitting visually inside or adjacent to the skills block survives sectioning and gets tokenized as a "skill". Two guards were added:

| Guard | file:line | What it rejects |
|---|---|---|
| `looksLikeContactLink` (whole-cell, pre-split) | `extract-fields.ts:602`, applied at `:668` | a cell that is itself a profile link (`github.com/janesmith`), dropped *before* `SKILL_SPLIT_RE` shreds the URL on `/` |
| `isSkillToken` → `looksLikeContactLink` (per-token) | `extract-fields.ts:607`, `:612` | a bare heading word `GitHub`/`LinkedIn` or a URL-ish token that survived the split |
| supporting predicates | `PROFILE_LABEL_RE` `:587`, `PROFILE_HOST_RE` `:591`, `URLISH_RE` `:597` | — |

**Bucket: mostly (B), partly (H).** The deep cause is a **boundary** problem: the contact/links block is not cleanly separated from the skills block, so contact lines fall into the `skills` section. Better segmentation (a dedicated `links`/`contact` lane, or tighter skills-section boundaries) removes most of this — the link never reaches `extractSkills` in the first place. The residual (H) is the "bare `GitHub` heading word with no URL" case: even with perfect sectioning, a *one-word* line `GitHub` is genuinely ambiguous (heading vs. the skill "GitHub Actions" abbreviated), so a small predicate may remain. But note it should live in the **segmentation/classification** layer ("this line is a links-block header"), not re-implemented inside the skills tokenizer.

Triggering template: LaTeX/Word resumes with a "Links" or icon-row block placed under or beside Skills (the `latex/` and `word/` fixtures, and the identity-link work in PR #125).

### 1.3 — Promoted identity links surviving as phantom project/achievement entries

Because `extractContact` matches LinkedIn/GitHub **document-wide** (`anywhereOnDoc = () => true`, `extract-fields.ts:455`, used at `:493`–`:494`), an identity link in a footer "Links" block is promoted into the contact card — *and* the same line also survives in whatever section it physically fell into (often `projects` or `achievements`), producing a phantom entry whose only content is the bare URL. `stripPromotedUrls` (`openresume.ts:133`) and its driver in `buildHeuristicResult` (`openresume.ts:196`–`:250`) remove the promoted slugs from every section body and drop entries left empty.

| Symbol | file:line |
|---|---|
| `stripPromotedUrls` | `openresume.ts:133` |
| `urlSlug` / `isPromotedUrl` / `PROMOTED_LABEL_RE` | `openresume.ts:111`, `:161`, `:124` |
| driver (strip across experience/education/projects/achievements/skills/summary) | `openresume.ts:196`–`:250` |
| root cause: document-wide contact match | `extract-fields.ts:455`, `:493` |

**Bucket: (B) de-duplication caused by an intentional (H) over-reach.** This one is subtler than #30. The phantom entry exists because `extractContact` *deliberately* reaches outside its section (document-wide) to recover footer-hyperlinked identity links — a genuine, valuable heuristic (1.4 below). The cost is a duplicate that has to be scrubbed from the section body. Better *segmentation* alone does **not** delete this: even with a perfect `links` section, the same URL is both (a) the contact link and (b) a line in the `links` section, and you still must decide it shouldn't render twice. What centralized segmentation *does* buy here: if the cascade emitted a typed `links`/`contact` section, the de-dup becomes "the contact extractor *owns* the links section, so lines consumed there are marked consumed and never offered to `extractProjects`/`extractAchievements`" — a **provenance/ownership** model rather than a slug-subtraction pass. So: **(B), retired-by-ownership, not retired-by-boundary.** Keep on the roadmap but sequence it after the pure-(S) win.

Triggering template: resumes with a bottom "Links"/"Find me online" block (common in LaTeX `moderncv`-style and Word templates; the #125 identity-link fixtures).

### 1.4 — `extractContact` document-wide URL fallback (the over-reach itself)

`anywhereOnDoc` (`extract-fields.ts:455`) plus the header-region band `inHeaderRegion` (`:447`) are a segmentation **workaround**: contact extraction can't trust that the profile section contains all the contact links (footers, sidebars, post-Skills "Links" blocks), so it scans the whole document with link-shape predicates and a y-band as a crude proxy for "header region".

**Bucket: (B).** This is segmentation imprecision wearing a geometry costume — `ann.yTop < 280` is literally "I don't have a profile/header *section* boundary so I'll approximate one with PDF points." A real `contact`/`links` section (or reliable profile-band boundary) replaces the y-band heuristic. The document-wide LinkedIn/GitHub match is defensible to keep (identity links are specific enough), but it is the upstream cause of 1.3, so the two should be redesigned together.

### 1.5 — Scorer's "experience" completeness fallback on raw bullet count

`completenessChecks` for `experience` passes when `expEntries.length > 0 || bullets.length > 0` (`score.ts:698`). The `|| bullets.length > 0` clause exists because when the experience *section* failed to parse into entries, the scorer falls back to "did we at least see bullet-shaped lines anywhere in raw text?" — a raw-text proxy for "there is an experience section."

**Bucket: (S), minor.** With a typed sectioned structure the scorer could ask "is there a non-empty `experience` section?" directly instead of guessing from the global bullet count. Low stakes, but it is the same anti-pattern (re-derive structure from `rawText`) and should be cleaned up in the same pass.

### 1.6 — `extractBulletsFromText` lone-bullet merge + raw-text walk (the pool itself)

`extractBulletsFromText` (`score.ts:612`) walks **all** of `rawText`, including the `LONE_BULLET_RE` Word-table merge (`score.ts:564`, `:624`). It cannot scope the pool to "bullets that belong to an accomplishment section," so it pools every marker-led line in the document and then *subtracts* skills via the side-channel (1.1). This is the structural reason #30 needed a side-channel at all.

**Bucket: (S), foundational.** This is the single function whose contract the interface change most improves: instead of "walk rawText, then subtract skills," it becomes "walk the experience + projects + achievements sections" (the same sections the authed scorer pools per-role at `score.ts:284`–`:289`). The lone-bullet merge is a (B) Word-table artifact that stays, but it would run *within* the experience section, not document-wide.

### 1.7 — Heuristics that are NOT segmentation-rooted (the (H) control group — explicitly out of scope to retire)

Listed so the catalog is honest about what centralizing segmentation does **not** touch:

| Heuristic | file:line | Why it's (H), not (S) |
|---|---|---|
| `disambiguateCompanyTitle` (company vs. title) | `extract-fields.ts:1071` | semantic inference inside a correctly-bounded experience entry |
| `looksLikeTitle` / `looksLikeCompany` / `TITLE_KEYWORDS_RE` | `:1042`, `:1051`, `:1038` | role-keyword inference — no sectioning removes it |
| `extractName` scoring (mononym, stacked-name merge, title penalty) | `:194`, `:124`, `:142` | name-vs-tagline inference *within* the profile section (#10/#16/#107) |
| `looksLikeDocTitleBoilerplate` | `:98` | "Functional Resume Sample" is in the profile section but isn't a name |
| `REDACTED_DATE_RE` partial credit (#31) | `score.ts:119`, `:716` | date-shape inference, orthogonal to sectioning |
| `splitColumnCells` (borderless table recovery) | `extract-fields.ts:634` | a *line-assembly* (Tier-0-ish) fix, not a section fix |
| `parseEducationDates` graduation-date disambiguation (#97) | `extract-fields.ts:946` | semantic date-role inference within the education section |

The presence of this control group is the argument for **scoping the rework tightly**: the catalog has ~6 (S)/(B) rows that centralizing segmentation helps and a long tail of (H) that it doesn't. Don't let the rework metastasize into "rewrite all the extractors."

---

## 2. Proposed single-source-of-truth interface

### 2.1 — The structure already exists; promote it

`PdfSection` (`sections.ts:43`) is already the right shape:

```ts
export interface PdfSection {
  name: SectionName | "profile";   // SectionName = summary|experience|education|skills|projects|certifications|achievements|other
  lines: PdfLine[];                // PdfLine carries text + geometry + font
}
```

`buildHeuristicResult` already holds the full `PdfSection[]` and already records `sectionSource: "markdown" | "regex"` (`openresume.ts:169`, surfaced today only on `diagnostics.sectionSource`). The change is to **stop discarding the array** and instead carry it forward.

Two delivery options, in order of preference:

**Option A (recommended) — carry the typed structure on `CascadeResult`, expose a derived view to the scorer.**

Add to `HeuristicResult` and thence to `CascadeResult`:

```ts
// new typed field on CascadeResult (types.ts), replacing skillsSectionText
sections: SectionedResume;

// the consumer-facing contract (new, e.g. sections.ts or a sections-view.ts)
export interface SectionedResume {
  /** Section name → marker-stripped, non-empty lines, in document order.
   *  Profile/contact included so contact + name extraction can share it. */
  readonly byName: ReadonlyMap<SectionName | "profile", readonly string[]>;
  /** Which sections produced an experience-bullet contribution, for the
   *  scorer's pool. Convenience accessor over `byName`. */
  readonly accomplishmentSections: readonly (SectionName)[]; // ["experience","projects","achievements"]
  /** Provenance for confidence tuning / telemetry (already computed). */
  readonly source: "markdown" | "regex";
}
```

The scorer then takes `sections` instead of `rawText + skillsSectionText`:

```ts
export interface AnonymousAtsScoreInput {
  parsed: { /* unchanged */ };
  fieldConfidence: { /* unchanged */ };
  triggers: readonly string[];
  /** Replaces rawText + skillsSectionText. The scorer pools bullets from the
   *  accomplishment sections and never sees skills lines. */
  sections: SectionedResume;
  /** Optional, retained ONLY for the redacted-date scan (REDACTED_DATE_RE),
   *  which is text-shape inference, not section inference (#31). Can later
   *  read the experience section's joined text instead and drop entirely. */
  rawText?: string;
}
```

Why a derived `SectionedResume` view rather than raw `PdfSection[]`:

- The pure scorer must stay dependency-light. Handing it `PdfSection[]` drags `PdfLine`/`PdfTextItem` geometry types into `score.ts`, which today has *zero* heuristics imports. A `ReadonlyMap<name, string[]>` of marker-stripped text lines is the minimal contract the scorer needs and keeps `score.ts` pure.
- It is the natural home for `accomplishmentSections`, which encodes the policy decision "experience + projects + achievements pool together" once (today that policy is duplicated: authed at `score.ts:284`–`:289`, anonymous via the rawText walk + skills subtraction).
- It subsumes `skillsSectionLines`/`skillsSectionText` (the skills section is just `byName.get("skills")`) and `diagnostics.sectionSource` (now `sections.source`).

**Option B (lighter, transitional) — keep `CascadeResult` flat but generalize the side-channel into `sectionText: Partial<Record<SectionName, string>>`.** This is strictly a stopgap: it replaces *one* hand-picked slice with *all* of them, which removes the "add a new side-channel per bug" failure mode but keeps the scorer re-deriving the bullet pool by string-matching. Recommended **only** if Option A's blast radius (App.tsx, useResumeAnalysis.ts, corpus.test.ts, score.test.ts all change shape) is judged too large for one PR. Prefer A.

### 2.2 — Modules that change (Option A)

| Module | Change |
|---|---|
| `sections.ts` (or new `sections-view.ts`) | add `SectionedResume` type + a `toSectionedResume(sections: PdfSection[], source)` builder |
| `openresume.ts` `buildHeuristicResult` | return `sections: toSectionedResume(...)` on `HeuristicResult`; **delete** `skillsSectionLines` build (`:294`) |
| `types.ts` | `CascadeResult.sections: SectionedResume`; **delete** `skillsSectionText?` (`:189`); `HeuristicResult.skillsSectionLines` removed |
| `cascade.ts` | carry `heuristic.sections` onto both `CascadeResult` builders; **delete** the two `skillsSectionText` spreads (`:198`, `:408`); `sectionSource` diagnostic folds into `sections.source` |
| `score.ts` | `AnonymousAtsScoreInput` takes `sections`; `extractBulletsFromText` scoped to `accomplishmentSections`; **delete** `buildSkillsExclusion` (`:583`), the `excludeStripped` param, the `skillsSectionText` field |
| `App.tsx`, `useResumeAnalysis.ts`, `corpus.test.ts` | pass `sections: cascade.sections` instead of `rawText + skillsSectionText` |
| `score.test.ts` | the #30 tests (`:503`–`:520`, `:542`) reshape from `skillsSectionText:` to a `sections` fixture |

(Post-#126, the `extract/*.ts` split changes none of the above module names except that the contact/skills extractors move under `extract/`.)

---

## 3. Removing `skillsSectionText` — the smallest end-to-end proof

This is the concrete first win and should be its **own** PR (the proof that the model works before the bigger pool refactor).

**Minimal viable slice (does not require the full `SectionedResume`):**

1. Add `sections: SectionedResume` to `HeuristicResult` and `CascadeResult` (built from the `PdfSection[]` already in hand at `openresume.ts:166`). Keep `skillsSectionText` *temporarily* alongside it.
2. Change `computeAnonymousAtsScore` to derive the skills-exclusion set from `input.sections.byName.get("skills")` instead of `input.skillsSectionText`. `buildSkillsExclusion` keeps its logic but reads from the section view; `extractBulletsFromText` is unchanged in this slice (still walks `rawText`, still subtracts the skills set).
3. Drop `skillsSectionText` from `AnonymousAtsScoreInput`, `CascadeResult`, and the two cascade spreads. Update `App.tsx`, `useResumeAnalysis.ts`, `corpus.test.ts`, `score.test.ts`.

This proves the side-channel can be replaced by the typed structure **without** yet touching the bullet-pool sourcing (the riskier change deferred to a second PR). It is the literal request in deliverable #3.

### 3.1 — Expected snapshot impact

The corpus suite (`corpus.test.ts`) golden-diffs `runCascade` + `computeAnonymousAtsScore` output across **24 `.expected.json` fixtures** in 7 categories (`google-docs`, `indesign`, `latex`, `mac-pages`, `mac-preview`, `unknown`, `word`).

**Expected churn from the minimal slice: zero score changes if behavior is preserved.** The skills lines fed to `buildSkillsExclusion` are identical whether sourced from `skillsSectionLines.join("\n")` (today) or `byName.get("skills")` (proposed) — both are `skillsSection?.lines.map(text).filter(non-empty)`. So the exclusion set is byte-identical and every `overall`/dimension number should be unchanged. **This is a behavior-preserving refactor; a clean diff is the pass condition.** Per the corpus-snapshot lesson, regenerating goldens would *mask* a regression — so the PR must show goldens **unchanged**, not regenerated. The only legitimate snapshot edits are structural fields if the snapshot records `sectionSource` (it does, at `corpus.test.ts:129`, but that value is unchanged).

**Risk caveat:** the equivalence holds only because the skills section identity is preserved. If the second PR (scoping the *pool* to accomplishment sections, §1.6) lands, snapshots **will** move — bullets currently pooled from "other"/un-sectioned regions of `rawText` would leave the pool, shifting Specificity/Structure on any fixture whose experience section under-segments. That is a deliberate scoring change and **must** bump `ATS_SCORE_ALGO_VERSION` (`score.ts:54`) per its own doc-comment, with goldens regenerated *and* spot-audited fixture-by-fixture. Keep that out of the smallest-proof PR precisely so the first step is provably inert.

---

## 4. Boundary statement — segmentation vs. deterministic heuristic vs. WebLLM tier

**Segmentation owns (Tier 0.5 / Tier 1 section layer):** *which lines belong to which section.* Output is the typed `SectionedResume`. This includes: section-header recognition (`matchSectionHeader`, exact-match today — generalizing it is #109's job), section boundaries, column/visual splitting, and a **provenance/ownership** model so a line consumed by one extractor (a contact link) is not re-offered to another (projects). Everything currently re-deriving section membership from `rawText` (the §1.1/§1.5/§1.6 (S) rows) belongs here.

**Deterministic heuristic owns (Tier 1 field layer):** *semantic inference within a correctly-bounded section.* company-vs-title (`disambiguateCompanyTitle`), name-vs-tagline (`extractName`), date-shape/role inference (`parseEducationDates`, `REDACTED_DATE_RE`), skill tokenization, line/table assembly (`splitColumnCells`). These stay even with perfect segmentation (the §1.7 control group). They should *consume* the section structure, not rebuild it.

**WebLLM tier owns (#3):** *cases where neither a clean section boundary nor a deterministic predicate is reliable* — narrative resumes with no headers at all, creative layouts where "section" is a visual gestalt, ambiguous company/title that needs world knowledge, summarizing prose into bullets. The line: if a human needs to *read for meaning* (not just recognize a header keyword or a date shape), it's LLM. Segmentation should expose a confidence/`source` signal (`sections.source`, the existing markdown-vs-regex flag, plus a future "no canonical sections found" state) so the cascade can decide when to escalate to the LLM tier rather than emit a low-confidence guess.

The clean rule: **segmentation answers "where", deterministic heuristics answer "what" within a known "where", and the LLM answers "what" when "where" is unknowable deterministically.**

---

## 5. Migration cost & go/no-go

### 5.1 — How many special-cases retire

| # | Patch | Bucket | Retired by this rework? |
|---|---|---|---|
| 1.1 | `skillsSectionText` side-channel (#30) — 7 touch-points | (S) | **Yes — fully.** The headline win. |
| 1.5 | scorer `\|\| bullets.length > 0` experience fallback | (S) | **Yes — fully** (read the experience section). |
| 1.6 | `extractBulletsFromText` rawText walk + skills subtraction | (S) | **Yes — restructured** (pool from accomplishment sections); enables 1.1's full deletion. |
| 1.2 | `looksLikeContactLink` skills rejection (2 guards) | (B)+(H) | **Mostly** — boundary fix removes the URL-in-skills case; a small "bare heading word" predicate may survive, relocated into classification. |
| 1.3 | `stripPromotedUrls` phantom-entry scrub | (B) | **Replaceable** by a provenance/ownership model, not by boundary alone; sequenced later. |
| 1.4 | `extractContact` document-wide + y-band fallback | (B) | **Partially** — y-band replaced by a real contact/links section; document-wide identity match retained by choice. |

**Count: 3 pure-(S) patches retire fully (1.1, 1.5, 1.6), 3 (B) patches shrink or relocate (1.2, 1.3, 1.4).** The (H) control group (§1.7, ~7 heuristics) is untouched by design. So the honest headline is **"retires 3 classes outright, shrinks 3 more, and — most importantly — removes the *incentive* to add the next side-channel,"** not "deletes half the extractor."

### 5.2 — Risk to the fixture corpus

- **Smallest-proof PR (§3): ~zero risk.** Behavior-preserving; goldens must stay unchanged (regeneration would mask a regression — corpus-snapshot lesson). Blast radius is type-shape only across 4 call sites + 2 test files.
- **Pool-rescoping PR (§1.6): deliberate score movement.** Requires `ATS_SCORE_ALGO_VERSION` bump and fixture-by-fixture audit of regenerated goldens. Medium risk, isolated to scoring, fully gated by the corpus suite.
- **Provenance/ownership PR (§1.3/§1.4): medium risk** — touches contact extraction and section assignment; needs the identity-link fixtures (#125) as regression anchors.

### 5.3 — Recommendation: **GO**, sequenced and staged

GO on the interface (Option A) because the structure already exists and is merely discarded — the change is *promotion, not construction* — and because the leverage is real: the side-channel pattern is self-replicating (#127's core argument), and the first step is provably inert. **Do not** do it as one big-bang PR. Stage it:

1. **PR 1 (the proof):** add `SectionedResume` + retire `skillsSectionText`, behavior-preserving, goldens unchanged. (Follow-up A below.)
2. **PR 2:** scope the bullet pool to accomplishment sections; algo-version bump + golden regen. (Follow-up B.)
3. **PR 3+:** provenance/ownership model to retire `stripPromotedUrls` + the contact y-band. (Follow-ups C, D.)

Gate each on the corpus suite. Sequence after #126 lands (or rebase onto it) so the `extract/*.ts` paths are stable.

---

## 6. Follow-up issues filed

Filed on `offlinecv/OfflineCV`, each referencing #127 and #109, in dependency order:

| Seq | Issue | Title | Bucket | Risk |
|---|---|---|---|---|
| A (PR 1) | [#132](https://github.com/offlinecv/OfflineCV/issues/132) | Emit typed `SectionedResume` from cascade + retire `skillsSectionText` (proof PR) | (S) | ~zero (behavior-preserving; goldens unchanged) |
| B (PR 2) | [#133](https://github.com/offlinecv/OfflineCV/issues/133) | Pool anon scorer bullets from accomplishment sections (retire rawText walk + `buildSkillsExclusion`) | (S) | medium (deliberate score change; algo bump) |
| C (PR 3) | [#134](https://github.com/offlinecv/OfflineCV/issues/134) | Replace `stripPromotedUrls` scrub with a section-ownership/provenance model | (B) | medium |
| D (PR 4) | [#135](https://github.com/offlinecv/OfflineCV/issues/135) | Replace `extractContact` y-band header proxy with a real contact/links section boundary | (B) | medium |

A is the gating dependency for B/C/D and is the provably-inert first step. Sequence the whole set after #126 (the `extract/*.ts` split) lands, or rebase onto it.
