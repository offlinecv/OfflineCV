// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Prevalence mining harness (#588) — inert in CI, runs ONLY when
 * `RL_MINE_PREVALENCE=1` is set:
 *
 *   RL_MINE_PREVALENCE=1 npx vitest run \
 *     src/lib/job-search/mine-prevalence.test.ts
 *
 * WHY THIS EXISTS. `ROLE_PROFILES` promises its `titles` are "most-used first"
 * and its `skills` "most-expected first". Curation can assert that ordering; it
 * cannot *measure* it, so the product would be making a market claim off one
 * person's judgement. The job feeds we already query carry the market's own
 * vocabulary in their posting titles and descriptions. This harness reads that
 * vocabulary back and emits a frequency ranking, which `role-profiles.ts` bakes
 * in as `prevalence-snapshot.ts` and applies as an ORDERING ONLY.
 *
 * ── NO NEW EGRESS (the property the privacy copy depends on) ────────────────
 * Nothing résumé-derived is involved anywhere in this loop. The queries are
 * seeded from `CURATED_ROLE_PROFILES`' OWN titles — public, committed strings —
 * so the egress is a strict SUBSET of what a normal in-app search already
 * sends (`providers/keywords.ts`: a short keyword string; company adapters: a
 * public slug). No PDF, no parsed résumé, no user text. `keywords.ts` is
 * untouched and remains the sole résumé-derived egress helper.
 *
 * The mined result is COMMITTED as a static TS module, never fetched at
 * runtime: a "prevalence service" call from the browser would be a brand-new
 * egress path, which #588 puts explicitly out of scope. `role-profiles.ts`
 * therefore still fetches nothing.
 *
 * Node has no CORS, so a run from here may reach feeds a browser's CORS set
 * cannot, and live postings drift run to run. That asymmetry is exactly why the
 * output is a snapshot rather than a runtime computation — the committed file
 * is the record of what one dated run saw, reviewable in a diff.
 *
 * ── CURATION STAYS AUTHORITATIVE ON MEMBERSHIP ──────────────────────────────
 * The harness only ever *counts*. For titles it counts how often each of a
 * profile's CURATED surface forms is observed in real posting titles (via the
 * shared `profileTitleMatches` relation), deliberately NOT harvesting new forms:
 * harvesting would be adding membership, and a junk title form that trends in a
 * feed must never be able to write itself into a profile.
 *
 * Skills are TALLIED over the whole jd-match dictionary — the raw market
 * vocabulary, whatever it says — and then narrowed to curated membership at
 * EMIT time. The narrowing is a snapshot-size decision, not the guard rail:
 * `applyPrevalenceOrder` filters again and structurally cannot add, so the
 * committed file stays reviewable in a diff and free of ~20× dead entries the
 * consumer would discard at module init anyway. Narrowing before the cut is also
 * the correct order — capping a raw tally first would drop a curated skill that
 * happened to rank below a pile of ids no profile carries, silently losing its
 * ranking. The unfiltered tally is preserved in the gitignored JSON report.
 *
 * ── Sampling shape (stated so a reader can calibrate the numbers) ───────────
 * Keyless feeds only (`KEYLESS_PROVIDERS`). Company ATS boards are deliberately
 * excluded: their pool is derived from a *sector* classification that has no
 * profile-level equivalent, their light index carries no description (so the
 * skill axis would be blind for them), and several Lever registry slugs are
 * known-wrong. Adding them would widen the run without deepening the sample.
 * The `providerMix` in the snapshot header names exactly which feeds answered.
 *
 * | Var | Default | Meaning |
 * |---|---|---|
 * | `RL_MINE_PREVALENCE` | *(unset)* | Set to any value to run. Unset → inert. |
 * | `RL_MINE_OUT` | `internal/job-search/` | Directory for the JSON report + the generated snapshot module. |
 * | `RL_MINE_SEEDS` | *(all)* | Cap on curated titles per profile used as feed queries. Lower it for a smoke run, never for a snapshot you intend to commit. |
 *
 * ── SEEDING IS SNAPSHOT-INDEPENDENT, ON PURPOSE ─────────────────────────────
 * The seed loop reads `CURATED_ROLE_PROFILES`, the hand-written table, NOT the
 * prevalence-reordered `ROLE_PROFILES` it is about to regenerate. Seeding from
 * the ranked table is a ratchet: the corpus becomes a function of the previous
 * run, so a title that sank to the tail once is never queried again and is
 * pinned there permanently — and a profile whose bucket got filled by a
 * neighbouring role would then seed that neighbour's name first and be filled
 * even harder next time. Bucketing is stable under reordering (see `bucketFor`);
 * seeding is a different question and is answered here.
 *
 * ── Baking the result (the two-step, on purpose) ────────────────────────────
 * The run writes `prevalence-snapshot.generated.ts` into the gitignored output
 * dir; a human copies it over `src/lib/job-search/prevalence-snapshot.ts` and
 * reviews the diff. The harness never writes into a tracked path, for the same
 * reason `probe-jobs` doesn't: a networked, non-deterministic step must not be
 * able to mutate committed source without a human reading the change.
 *
 * ASSERTS NOTHING ABOUT WHAT IT FINDS. It fails only if it could not run at all
 * (every feed down), so a thin corpus is reported honestly instead of inflated.
 * Every bucketed profile is baked with an `audit` — the consumer's own per-axis
 * verdict, computed here by calling `auditPrevalence` rather than re-deriving
 * the rule — so "ranked", "declined for a thin sample", "declined because the
 * bucket is a different role" and "declined for want of readable descriptions"
 * are four visibly different outcomes in the committed diff. Profiles no posting
 * reached at all are listed separately as `unobservedProfiles`: measured-and-
 * declined and never-seen are not the same finding.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { REPO_ROOT } from "../heuristics/__test-utils__/corpus-snapshots.ts";
import { getSkillIndex } from "../jd-match/skills.ts";
import { KEYLESS_PROVIDERS } from "./providers/index.ts";
import type { JobQuery } from "./query-builder.ts";
import { dedupKey } from "./raw-postings.ts";
import {
  CURATED_ROLE_PROFILES,
  auditPrevalence,
  normalizeSkillKey,
  profileTitleMatches,
  resolveProfilesByTitles,
  type PrevalenceAudit,
  type RoleProfile,
} from "./role-profiles.ts";
import type { JobPosting } from "./types.ts";

/**
 * The output directory, validated exactly the way `probe-jobs` validates its
 * own: the default (`internal/`) is gitignored, and an override that lands
 * inside the repo but is NOT gitignored is a hard failure. `git check-ignore` is
 * the authority. The stake here is different from probe-jobs' (no PII is in
 * play) but the rule is the same one: a networked run may not deposit a file
 * into a tracked path.
 */
function resolveOutDir(): string {
  const override = process.env.RL_MINE_OUT;
  if (!override) return join(REPO_ROOT, "internal/job-search");

  const dir = isAbsolute(override) ? override : resolve(process.cwd(), override);
  const rel = relative(REPO_ROOT, dir);
  const insideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (!insideRepo) return dir;

  try {
    execFileSync("git", ["check-ignore", "-q", "--", dir], { cwd: REPO_ROOT });
    return dir;
  } catch {
    throw new Error(
      `RL_MINE_OUT="${override}" resolves inside the repo at "${rel}" and is NOT ` +
        `gitignored. This harness is networked and non-deterministic; its output ` +
        `must be reviewed and copied in by a human, never written straight into a ` +
        `tracked path. Point RL_MINE_OUT at a gitignored path (the default ` +
        `"internal/job-search/") or somewhere outside the repo.`,
    );
  }
}

/**
 * Curated titles per profile used as feed queries. ALL of them by default.
 *
 * Capping the seeds was a fan-out saving that quietly decided what the corpus
 * could contain: a title never queried is a title that can only ever be observed
 * incidentally, so it sinks to the tail and — if the seeds were taken from a
 * ranked table — stays there across every future run. Seeding every curated
 * title is what makes the corpus a function of curation rather than of the
 * previous snapshot. `RL_MINE_SEEDS` still caps it for a quick smoke run; a cap
 * makes the run faster and the ranking narrower, and should not be used to
 * produce a snapshot that gets committed.
 */
const DEFAULT_SEEDS_PER_PROFILE = Number.POSITIVE_INFINITY;
/**
 * Pause between seed queries. These are free, keyless, unauthenticated public
 * feeds and this harness is the heaviest thing in the tree that touches them —
 * every curated title in the table × 3 providers in one run (113 × 3 as of the
 * committed snapshot). Without pacing they throttle partway through and the
 * corpus silently halves, which looks like a thin market rather than a thin
 * sample. If a run reports many `providerFailures`, wait for the window to clear
 * and re-run; do not read a throttled corpus as data. Raised from 400ms when
 * seeding went from 3 titles per profile to all of them (#588 review), and
 * again to 1200ms after a 600ms run drew 72 `arbeitnow` rejections across 113
 * queries — the pacing is per seed while the providers are queried in parallel,
 * so each provider sees one request per interval and this is the knob that
 * moves.
 */
const QUERY_PACING_MS = 1200;
/** A posting whose description is shorter than this carries no usable skill
 *  vocabulary (a feed that returned a stub). Counted in the corpus, skipped for
 *  the skill axis, so the sample size stays honest about what was read. */
const MIN_DESCRIPTION_CHARS = 80;

/** One observed term with its raw count. Mirrors `PrevalenceEntry`. */
interface MinedEntry {
  form: string;
  count: number;
}

/** Per-profile accumulator during the run. */
interface ProfileTally {
  sampleSize: number;
  titles: Map<string, number>;
  skills: Map<string, number>;
}

describe.runIf(process.env.RL_MINE_PREVALENCE)(
  "role-profile prevalence mining (RL_MINE_PREVALENCE)",
  () => {
    // Deliberate monolithic diagnostic harness (mirrors probe-jobs): one linear
    // read-out of seed → capture → bucket → tally → emit, in a single scroll.
    // Not production logic; it never asserts on what it finds.
    // fallow-ignore-next-line complexity
    it("mines title + skill prevalence from live feeds and emits a snapshot module", async () => {
      const outDir = resolveOutDir();
      const seedsPerProfile = Number(
        process.env.RL_MINE_SEEDS ?? DEFAULT_SEEDS_PER_PROFILE,
      );

      // ── Capture. One query per (profile, seed title), fanned across the
      //    keyless feeds. Deduped cross-provider under the SAME rule the app's
      //    fan-out uses, so a posting carried by two feeds counts once. ────────
      const corpus = new Map<string, JobPosting>();
      const providerMix: Record<string, number> = {};
      const failures: Record<string, number> = {};
      const signal = new AbortController().signal;

      // Seeds come from CURATED_ROLE_PROFILES, never from the reordered
      // `ROLE_PROFILES` — see that constant's docblock. Seeding from the ranked
      // table would make each corpus a function of the previous snapshot, which
      // is a ratchet: a title that fell to the tail once would never be queried
      // again. Seeding is deliberately snapshot-independent.
      for (const profile of CURATED_ROLE_PROFILES) {
        for (const seed of profile.titles.slice(0, seedsPerProfile)) {
          await new Promise((r) => setTimeout(r, QUERY_PACING_MS));
          const query: JobQuery = { titles: [seed], skills: [] };
          const settled = await Promise.allSettled(
            KEYLESS_PROVIDERS.map((provider) => provider.search(query, signal)),
          );
          settled.forEach((outcome, idx) => {
            const provider = KEYLESS_PROVIDERS[idx];
            if (outcome.status === "rejected") {
              failures[provider.id] = (failures[provider.id] ?? 0) + 1;
              return;
            }
            for (const posting of outcome.value) {
              const key = dedupKey(posting);
              if (corpus.has(key)) continue;
              corpus.set(key, posting);
              providerMix[provider.id] = (providerMix[provider.id] ?? 0) + 1;
            }
          });
        }
      }

      // ── Bucket + tally. ──────────────────────────────────────────────────────
      const { tallies, unbucketed } = tally([...corpus.values()]);

      // ── Emit. ────────────────────────────────────────────────────────────────
      const snapshot = renderSnapshotModule({
        generatedAt: new Date().toISOString().slice(0, 10),
        corpusSize: corpus.size,
        providerMix,
        tallies,
      });
      mkdirSync(outDir, { recursive: true });
      const tsFile = join(outDir, "prevalence-snapshot.generated.ts");
      const jsonFile = join(outDir, "prevalence-mining-report.json");
      writeFileSync(tsFile, snapshot);
      writeFileSync(
        jsonFile,
        JSON.stringify(
          {
            corpusSize: corpus.size,
            providerMix,
            providerFailures: failures,
            unbucketed,
            seedsPerProfile,
            unobservedProfiles: CURATED_ROLE_PROFILES.map((p) => p.id)
              .filter((id) => !tallies.has(id))
              .sort(),
            profiles: Object.fromEntries(
              [...tallies].map(([id, t]) => [
                id,
                {
                  sampleSize: t.sampleSize,
                  titles: sortEntries(t.titles),
                  skills: sortEntries(t.skills),
                },
              ]),
            ),
          },
          null,
          2,
        ),
      );

      console.log(
        renderReadout(
          corpus.size,
          providerMix,
          failures,
          unbucketed,
          tallies,
          tsFile,
          jsonFile,
        ),
      );

      // Diagnostic: never fails on findings, but must fail if it could not run.
      expect(corpus.size).toBeGreaterThan(0);
    }, 900_000); // live network fan-out over the whole table — minutes, not seconds.
  },
);

/**
 * Bucket every posting into ONE profile and count what it says.
 *
 * One posting, one bucket: `resolveProfilesByTitles` returns a ranked list, and
 * crediting every member would let a single posting inflate five sample sizes
 * at once, making `sampleSize` a number no reader could interpret. The head is
 * the resolver's own best answer, which is the same answer the product uses.
 */
function tally(postings: readonly JobPosting[]): {
  tallies: Map<string, ProfileTally>;
  unbucketed: number;
} {
  const byId = new Map(CURATED_ROLE_PROFILES.map((p) => [p.id, p] as const));
  const tallies = new Map<string, ProfileTally>();
  let unbucketed = 0;

  for (const posting of postings) {
    const profile = bucketFor(posting, byId);
    if (!profile) {
      unbucketed += 1;
      continue;
    }
    const tallyForProfile = tallies.get(profile.id) ?? {
      sampleSize: 0,
      titles: new Map<string, number>(),
      skills: new Map<string, number>(),
    };
    tallies.set(profile.id, tallyForProfile);
    tallyForProfile.sampleSize += 1;

    // Titles: which CURATED forms does this real posting title exhibit? A
    // posting can exhibit several ("Senior Engineering Manager" is both
    // "engineering manager" and "senior engineering manager"); each is a real
    // observation of that form, so each is counted.
    for (const curated of profile.titles) {
      if (profileTitleMatches(curated, posting.title)) {
        bump(tallyForProfile.titles, curated);
      }
    }

    for (const id of skillsMentionedIn(posting.description)) {
      bump(tallyForProfile.skills, id);
    }
  }

  return { tallies, unbucketed };
}

/**
 * Canonical jd-match skill ids mentioned in a posting description, deduped.
 *
 * One pass of jd-match's own combined alias regex, so the mined vocabulary is
 * the SAME vocabulary the JD-match lane extracts — a skill this can see is a
 * skill the product can already reason about. Deduped within a posting: a
 * description repeating "Kubernetes" eight times is one posting asking for
 * Kubernetes, not eight. A too-short description (a feed that returned a stub)
 * yields nothing rather than a fake zero-skill observation.
 */
function skillsMentionedIn(description: string): ReadonlySet<string> {
  const ids = new Set<string>();
  if (description.length < MIN_DESCRIPTION_CHARS) return ids;
  const { pattern, aliasToId } = getSkillIndex();
  for (const match of description.matchAll(pattern)) {
    const id = aliasToId.get((match[1] ?? "").toLowerCase());
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The single profile this posting's title resolves to, or undefined.
 *
 * `resolveProfilesByTitles` reads the ALREADY-ORDERED `ROLE_PROFILES`, but
 * ordering can never change membership or the subset relation a title match is
 * decided by — only the small prevalence nudge that breaks otherwise-equal ties.
 * BUCKETING is therefore stable across regenerations. That claim covers
 * bucketing and nothing else; SEEDING, which decides what the corpus contains in
 * the first place, is a separate question and is answered separately — the seed
 * loop reads `CURATED_ROLE_PROFILES` precisely so the corpus does not chase the
 * previous run's output.
 *
 * Bucketing is stable, not correct. Every posting lands in exactly one profile,
 * so a posting for a neighbouring role whose market name happens to be a curated
 * title of some profile is counted as evidence about THAT profile. The consumer
 * gate `MIN_CURATED_HEAD_TITLE_SHARE` catches the resulting contamination at
 * apply time, and the baked `audit` reports it; the harness itself, as ever,
 * asserts nothing about what it finds.
 */
function bucketFor(
  posting: JobPosting,
  byId: ReadonlyMap<string, RoleProfile>,
): RoleProfile | undefined {
  const id = resolveProfilesByTitles([posting.title])[0]?.id;
  return id ? byId.get(id) : undefined;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Count desc, then insertion order — a deterministic, reproducible ranking. */
function sortEntries(counts: ReadonlyMap<string, number>): MinedEntry[] {
  const keys = [...counts.keys()];
  return keys
    .map((form, index) => ({ form, count: counts.get(form) ?? 0, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ form, count }) => ({ form, count }));
}

/**
 * Render the generated `prevalence-snapshot.ts`. The header this writes is the
 * file's provenance — generation date, corpus size, provider mix, and the exact
 * command that rebuilds it — because a snapshot nobody can regenerate rots
 * silently and a snapshot with no dated header rots invisibly.
 */
function renderSnapshotModule(input: {
  generatedAt: string;
  corpusSize: number;
  providerMix: Record<string, number>;
  tallies: Map<string, ProfileTally>;
}): string {
  const { generatedAt, corpusSize, providerMix, tallies } = input;
  const unobserved = CURATED_ROLE_PROFILES.map((p) => p.id)
    .filter((id) => !tallies.has(id))
    .sort();
  const mixLine = Object.entries(providerMix)
    .map(([id, n]) => `${id}=${n}`)
    .join(", ");
  const dominantLine = describeDominantFeed(providerMix, corpusSize);

  const byId = new Map(CURATED_ROLE_PROFILES.map((p) => [p.id, p] as const));

  const profileBlocks = [...tallies]
    .sort((a, b) => b[1].sampleSize - a[1].sampleSize || a[0].localeCompare(b[0]))
    .map(([id, t]) => {
      const profile = byId.get(id);
      const curated = new Set((profile?.skills ?? []).map(normalizeSkillKey));
      const titles = sortEntries(t.titles);
      const skills = sortEntries(t.skills).filter((e) =>
        curated.has(normalizeSkillKey(e.form)),
      );
      // The verdict is computed by the CONSUMER's own `auditPrevalence`, not
      // re-derived here, so the baked `audit` and what `applyPrevalenceOrder`
      // will actually do cannot drift. A test asserts the two still agree on the
      // committed file — which also catches a hand-edited count.
      const audit = profile
        ? auditPrevalence(profile, { sampleSize: t.sampleSize, titles, skills })
        : undefined;
      return (
        `    ${JSON.stringify(id)}: {\n` +
        `      sampleSize: ${t.sampleSize},\n` +
        `      titles: [\n${renderEntries(titles)}      ],\n` +
        `      skills: [\n${renderEntries(skills)}      ],\n` +
        (audit ? `      audit: ${renderAudit(audit)},\n` : "") +
        `    },`
      );
    })
    .join("\n");

  return `// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * prevalence-snapshot.ts — GENERATED. Do not hand-edit the data body (#588).
 *
 * Baked frequency counts mined from real job postings, consumed by
 * \`role-profiles.ts\` to ORDER each profile's curated \`titles\` / \`skills\`.
 * Ordering only: an entry naming a term the curated table does not carry is
 * dropped by \`applyPrevalenceOrder\`, never added. Editing these numbers by hand
 * is how a snapshot rots — regenerate instead.
 *
 * NO RUNTIME FETCH. This is a static module in the bundle; nothing here or in
 * \`role-profiles.ts\` calls the network. The mining that produced it ran offline
 * in a dev harness seeded from the curated titles themselves — no résumé, no new
 * egress. See \`mine-prevalence.test.ts\`.
 *
 * ── WHOSE VOICE THIS IS ─────────────────────────────────────────────────────
 * ${dominantLine}
 * These are keyless remote-jobs aggregators, which over-represent remote-first,
 * English-language and often smaller-company listings. Read a ranking as "what
 * these feeds said on this date", not as a market-wide measurement.
 *
 * COMPANY ATS BOARDS (greenhouse / lever / ashby) ARE EXCLUDED BY DESIGN, not
 * missing because they were down. Their pool is drawn from a *sector*
 * classification with no profile-level equivalent, their light index carries no
 * description at all (so the skill axis would be blind for every posting they
 * contributed), and several Lever registry slugs are known-wrong. A provider
 * absent from \`providerMix\` below is either one of those three or a feed that
 * genuinely failed; the run's JSON report records the failures.
 *
 * Regenerate with:
 *
 *   RL_MINE_PREVALENCE=1 npx vitest run src/lib/job-search/mine-prevalence.test.ts
 *
 * then copy \`internal/job-search/prevalence-snapshot.generated.ts\` over this
 * file and review the diff. Read each entry's \`audit\` first: it says whether
 * each AXIS was ranked or declined and why, and it names the modal observed
 * title — a modal title that is not the role is the tell that the bucket was
 * filled by a neighbour and that curated MEMBERSHIP, not ordering, needs work.
 *
 * generatedAt:  ${generatedAt}
 * corpusSize:   ${corpusSize} deduped postings
 * providerMix:  ${mixLine || "(none)"}
 */

import type { PrevalenceAudit } from "./role-profiles.ts";

/** One observed surface form (title) or canonical id (skill) with its count. */
export interface PrevalenceEntry {
  readonly form: string;
  readonly count: number;
}

/** What one profile's postings said, ranked count-desc. */
export interface ProfilePrevalence {
  /**
   * Postings that bucketed to this profile. This is the TITLE axis's evidence
   * and only the title axis's: a posting joins the corpus on its title, and a
   * posting whose description was a stub contributes to this number while
   * contributing nothing to \`skills\`. \`audit.skillObservations\` is the skill
   * axis's own denominator — see \`MIN_PREVALENCE_SKILL_OBSERVATIONS\`.
   */
  readonly sampleSize: number;
  readonly titles: readonly PrevalenceEntry[];
  /**
   * Curated skills observed at least once, count-desc. A curated skill missing
   * from this list scored zero, which is AMBIGUOUS: postings may genuinely never
   * ask for it, or jd-match's alias regex may be unable to see the phrasing they
   * asked for it with. The ranking cannot distinguish the two and treats both as
   * "unobserved", sinking the term to the tail of the curated order — never
   * dropping it, which is what keeps the ambiguity survivable.
   */
  readonly skills: readonly PrevalenceEntry[];
  /** Per-axis verdict + the measurements behind it, computed at bake time by
   *  the consumer's own \`auditPrevalence\`. Present for every mined profile. */
  readonly audit: PrevalenceAudit;
}

/** The whole baked corpus summary. */
export interface PrevalenceSnapshot {
  /** ISO date (YYYY-MM-DD) of the mining run. */
  readonly generatedAt: string;
  /** Deduped postings read across every feed. */
  readonly corpusSize: number;
  /** Provider id → postings contributed (first-seen wins under dedup). */
  readonly providerMix: Readonly<Record<string, number>>;
  readonly profiles: Readonly<Record<string, ProfilePrevalence>>;
  /**
   * Curated profile ids for which the corpus contained NO posting at all —
   * distinct from a profile that bucketed too few, which appears in \`profiles\`
   * with a declining \`audit\`. The distinction matters: a thin profile was
   * measured and declined, an unobserved one was never seen, and only the second
   * says the seeds or the feeds could not reach that role.
   */
  readonly unobservedProfiles: readonly string[];
}

export const PREVALENCE_SNAPSHOT: PrevalenceSnapshot = {
  generatedAt: ${JSON.stringify(generatedAt)},
  corpusSize: ${corpusSize},
  providerMix: ${JSON.stringify(providerMix)},
  profiles: {
${profileBlocks}
  },
  unobservedProfiles: ${JSON.stringify(unobserved)},
};
`;
}

function renderEntries(entries: readonly MinedEntry[]): string {
  return entries
    .map((e) => `        { form: ${JSON.stringify(e.form)}, count: ${e.count} },\n`)
    .join("");
}

/** One line, so a reviewer reads the verdict without unfolding an object. */
function renderAudit(audit: PrevalenceAudit): string {
  return (
    `{ titles: ${JSON.stringify(audit.titles)}, skills: ${JSON.stringify(audit.skills)}, ` +
    `sampleSize: ${audit.sampleSize}, ` +
    `modalTitle: ${JSON.stringify(audit.modalTitle)}, ` +
    `modalTitleShare: ${audit.modalTitleShare}, ` +
    `curatedHeadTitleShare: ${audit.curatedHeadTitleShare}, ` +
    `skillObservations: ${audit.skillObservations}, ` +
    `skillHeadCount: ${audit.skillHeadCount} }`
  );
}

/**
 * The one sentence a reader needs before believing any count in this file: how
 * lopsided the corpus is. A snapshot that only lists `providerMix` lets a
 * reader assume three feeds contributed comparably when in practice one
 * aggregator has supplied four fifths of every run so far.
 */
function describeDominantFeed(
  providerMix: Readonly<Record<string, number>>,
  corpusSize: number,
): string {
  const entries = Object.entries(providerMix).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  if (!top || corpusSize <= 0) return "No feed answered; the corpus is empty.";
  const pct = Math.round((top[1] / corpusSize) * 100);
  const others = entries.slice(1).map(([id, n]) => `${id} ${n}`).join(", ");
  return (
    `THIS CORPUS IS NOT EVENLY SOURCED: "${top[0]}" alone supplied\n` +
    ` * ${top[1]} of ${corpusSize} postings (${pct}%)` +
    (others ? `, against ${others}.` : ".")
  );
}

/** The console read-out. No PII is in play here — the corpus is public postings
 *  and the seeds are committed strings — so this prints real counts and ids. */
function renderReadout(
  corpusSize: number,
  providerMix: Record<string, number>,
  failures: Record<string, number>,
  unbucketed: number,
  tallies: Map<string, ProfileTally>,
  tsFile: string,
  jsonFile: string,
): string {
  const byId = new Map(CURATED_ROLE_PROFILES.map((p) => [p.id, p] as const));
  const audits = [...tallies].map(([id, t]) => {
    const profile = byId.get(id);
    const audit = profile
      ? auditPrevalence(profile, {
          sampleSize: t.sampleSize,
          titles: sortEntries(t.titles),
          skills: sortEntries(t.skills),
        })
      : undefined;
    return { id, tally: t, audit };
  });

  const rows = audits
    .sort((a, b) => b.tally.sampleSize - a.tally.sampleSize)
    .map(({ id, tally: t, audit }) => {
      // The modal is printed for both verdicts that turn on it — the refusal,
      // and the near-tie where it led but not by enough to take the head.
      const modalMatters =
        audit?.titles === "bucket-not-this-role" ||
        audit?.titles === "ranked-head-pinned";
      const verdict = audit
        ? `titles=${audit.titles} skills=${audit.skills}` +
          (modalMatters
            ? `  modal="${audit.modalTitle}" ${Math.round(audit.modalTitleShare * 100)}%`
            : "")
        : "(not a curated profile)";
      return (
        `    ${id.padEnd(30)} n=${String(t.sampleSize).padStart(4)}` +
        `  skillObs=${String(audit?.skillObservations ?? 0).padStart(4)}  ${verdict}`
      );
    })
    .join("\n");

  const rankedTitles = audits.filter((a) => a.audit?.titles === "ranked").length;
  const pinnedTitles = audits.filter(
    (a) => a.audit?.titles === "ranked-head-pinned",
  ).length;
  const rankedSkills = audits.filter((a) => a.audit?.skills === "ranked").length;
  const unobserved = CURATED_ROLE_PROFILES.filter((p) => !tallies.has(p.id)).length;

  return (
    `\nprevalence mining run\n` +
    `  corpus=${corpusSize} deduped postings  unbucketed=${unbucketed}\n` +
    `  providerMix=${JSON.stringify(providerMix)}\n` +
    `  providerFailures=${JSON.stringify(failures)}\n` +
    `  profiles bucketed=${tallies.size}  unobserved=${unobserved}\n` +
    `  ranked TITLE axis=${rankedTitles} (+${pinnedTitles} head-pinned)` +
    `  ranked SKILL axis=${rankedSkills}\n\n` +
    `  PER PROFILE:\n${rows}\n\n` +
    `  generated snapshot → ${tsFile}\n` +
    `  full report        → ${jsonFile}\n` +
    `  Copy the generated module over src/lib/job-search/prevalence-snapshot.ts ` +
    `and review the diff.\n`
  );
}
