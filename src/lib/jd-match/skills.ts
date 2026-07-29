// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Curated skill dictionary for JD-match v1.
 *
 * Each entry maps a canonical skill ID to the set of surface forms we accept
 * for that skill. The canonical ID is what the UI renders ("react"); the
 * aliases are what we phrase-match against the JD and the resume corpus.
 *
 * Constraints:
 *  - Aliases are matched case-insensitively, at word boundaries (see
 *    `aliasToMatchPattern` for the exact regex shape). Punctuation inside an
 *    alias is treated literally — `react.js` only matches the literal
 *    `react.js`, not `reactjs`.
 *  - Always list each alias once. Canonical ID counts as an alias too (so
 *    `react` is listed in its own alias array).
 *  - When adding a skill, lowercase everything. The matcher normalises both
 *    the JD text and the resume corpus to lowercase before comparison.
 *  - Keep the list tight: v1 trades recall for precision. Adding noisy
 *    one-letter tokens or English words ("go", "r") creates false positives
 *    against bullet copy. The matcher's word-boundary guard rules out
 *    *substring* hits but not *standalone* false hits.
 *
 * v1 seed: ~120 entries spanning common engineering, data, product, and
 * design skills. Implementer notes in the issue suggest 100–200; we sit in
 * that band. Extend over time as we see JD/resume pairs in the wild.
 */

export interface SkillEntry {
  /** Canonical skill ID — stable key, used for dedupe and as the React key. */
  readonly id: string;
  /** Surface forms (lowercase) accepted as evidence of this skill. */
  readonly aliases: readonly string[];
  /** Human display form. Omit when the `id` already reads cleanly (`react`,
   *  `kubernetes`); set it where the kebab/lowercased id reads poorly in the
   *  UI (`a-b-testing` → `A/B Testing`, `ci-cd` → `CI/CD`). Falls back to
   *  `id`.
   *
   *  MUST START WITH A CAPITAL (or a digit) — `skills.test.ts` enforces it.
   *  A `label` is rendered verbatim: `deriveSkills`
   *  (`job-search/query-builder.ts`) uses it for a recognized résumé skill and
   *  title-cases the free-text ones itself, so a lowercase label put two casings
   *  in one sentence — "cross-functional collaboration, Team Building &
   *  Mentorship" — and it was the RECOGNIZED skill that looked unpolished (#607).
   *  Inside the label, follow the entry's own house casing (`iOS`, `P&L
   *  Ownership`); only the first character is machine-checked. Aliases stay
   *  lowercase — they are matched, never shown. */
  readonly label?: string;
}

/**
 * Version of the dictionary's DATA — the entries, their aliases, their labels.
 *
 * Exists because this table is upstream of an answer that is versioned
 * elsewhere: `job-search/term-quality.ts` reproduces a query's advice from
 * `TERM_QUALITY_VERSION` (its rules) + `ROLE_PROFILES_VERSION` (which terms a
 * role expects), and neither moves when an alias here does — yet an added alias
 * changes which suggestions that module emits for an unchanged résumé, because
 * `deriveSkills` canonicalizes a chip through `aliasToId` before the advice is
 * computed. Without this number that class of change is unreproducible.
 *
 * Changelog:
 * - 1.0: initial curated dictionary, plus the #583 leadership/management block.
 * - 1.1 (2026-07-29): leadership aliases widened to the phrasings a leadership
 *   résumé's SKILLS ROW actually uses, and every authored `label` title-cased
 *   (#594, #607). Moves both the canonicalization of a chip and its display
 *   text; no entry was removed and no `id` renamed.
 */
export const SKILLS_DICTIONARY_VERSION = "1.1";

export const SKILLS: readonly SkillEntry[] = [
  // ── Languages ────────────────────────────────────────────────────────────
  { id: "javascript", aliases: ["javascript", "js", "ecmascript"] },
  { id: "typescript", aliases: ["typescript", "ts"] },
  { id: "python", aliases: ["python", "python3"] },
  { id: "java", aliases: ["java"] },
  { id: "kotlin", aliases: ["kotlin"] },
  { id: "scala", aliases: ["scala"] },
  { id: "go", aliases: ["golang", "go lang"] },
  { id: "rust", aliases: ["rust", "rustlang"] },
  { id: "c", aliases: ["c language"] },
  { id: "cpp", aliases: ["c++", "cpp"] },
  { id: "csharp", aliases: ["c#", "csharp", ".net"] },
  { id: "ruby", aliases: ["ruby"] },
  { id: "rails", aliases: ["rails", "ruby on rails", "ror"] },
  { id: "php", aliases: ["php"] },
  { id: "swift", aliases: ["swift"] },
  { id: "objective-c", label: "Objective-C", aliases: ["objective-c", "objective c", "obj-c"] },
  { id: "perl", aliases: ["perl"] },
  { id: "bash", aliases: ["bash", "shell scripting", "shell script"] },
  { id: "sql", aliases: ["sql"] },
  { id: "html", aliases: ["html", "html5"] },
  { id: "css", aliases: ["css", "css3"] },
  { id: "haskell", aliases: ["haskell"] },
  { id: "elixir", aliases: ["elixir"] },
  { id: "erlang", aliases: ["erlang"] },
  { id: "clojure", aliases: ["clojure"] },
  { id: "dart", aliases: ["dart"] },
  { id: "lua", aliases: ["lua"] },
  { id: "matlab", aliases: ["matlab"] },
  { id: "r-lang", label: "R", aliases: ["r language", "r programming"] },

  // ── Frontend / UI ────────────────────────────────────────────────────────
  { id: "react", aliases: ["react", "reactjs", "react.js"] },
  { id: "react-native", label: "React Native", aliases: ["react native", "react-native"] },
  { id: "next.js", aliases: ["next.js", "nextjs", "next js"] },
  { id: "vue", aliases: ["vue", "vue.js", "vuejs"] },
  { id: "nuxt", aliases: ["nuxt", "nuxt.js", "nuxtjs"] },
  { id: "angular", aliases: ["angular", "angularjs", "angular.js"] },
  { id: "svelte", aliases: ["svelte", "sveltekit"] },
  { id: "redux", aliases: ["redux"] },
  { id: "tailwind", aliases: ["tailwind", "tailwindcss", "tailwind css"] },
  { id: "sass", aliases: ["sass", "scss"] },
  { id: "webpack", aliases: ["webpack"] },
  { id: "vite", aliases: ["vite"] },
  { id: "jquery", aliases: ["jquery"] },
  { id: "storybook", aliases: ["storybook"] },
  { id: "graphql", aliases: ["graphql"] },
  { id: "apollo", aliases: ["apollo", "apollo client", "apollo server"] },
  { id: "webgl", aliases: ["webgl"] },
  { id: "three.js", aliases: ["three.js", "threejs"] },
  { id: "d3", aliases: ["d3", "d3.js"] },

  // ── Backend / server ─────────────────────────────────────────────────────
  { id: "node.js", aliases: ["node.js", "nodejs", "node js"] },
  { id: "express", aliases: ["express", "express.js", "expressjs"] },
  { id: "nestjs", aliases: ["nestjs", "nest.js"] },
  { id: "django", aliases: ["django"] },
  { id: "flask", aliases: ["flask"] },
  { id: "fastapi", aliases: ["fastapi", "fast api"] },
  { id: "spring", aliases: ["spring", "spring boot", "springboot"] },
  { id: "laravel", aliases: ["laravel"] },
  { id: "grpc", aliases: ["grpc"] },
  { id: "rest", aliases: ["rest", "rest api", "restful api", "restful"] },
  { id: "websocket", aliases: ["websocket", "websockets"] },
  { id: "microservices", aliases: ["microservices", "micro-services"] },

  // ── Databases ────────────────────────────────────────────────────────────
  { id: "postgresql", aliases: ["postgresql", "postgres", "psql"] },
  { id: "mysql", aliases: ["mysql"] },
  { id: "mongodb", aliases: ["mongodb", "mongo"] },
  { id: "redis", aliases: ["redis"] },
  { id: "elasticsearch", aliases: ["elasticsearch", "elastic search"] },
  { id: "dynamodb", aliases: ["dynamodb", "dynamo db"] },
  { id: "cassandra", aliases: ["cassandra"] },
  { id: "snowflake", aliases: ["snowflake"] },
  { id: "bigquery", aliases: ["bigquery", "big query"] },
  { id: "redshift", aliases: ["redshift"] },
  { id: "sqlite", aliases: ["sqlite"] },
  { id: "neo4j", aliases: ["neo4j"] },
  { id: "clickhouse", aliases: ["clickhouse"] },

  // ── Cloud / infra ────────────────────────────────────────────────────────
  { id: "aws", aliases: ["aws", "amazon web services"] },
  { id: "gcp", aliases: ["gcp", "google cloud", "google cloud platform"] },
  { id: "azure", aliases: ["azure", "microsoft azure"] },
  { id: "kubernetes", aliases: ["kubernetes", "k8s"] },
  { id: "docker", aliases: ["docker"] },
  { id: "terraform", aliases: ["terraform"] },
  { id: "ansible", aliases: ["ansible"] },
  { id: "helm", aliases: ["helm"] },
  { id: "linux", aliases: ["linux"] },
  { id: "nginx", aliases: ["nginx"] },
  { id: "kafka", aliases: ["kafka", "apache kafka"] },
  { id: "rabbitmq", aliases: ["rabbitmq", "rabbit mq"] },
  { id: "airflow", aliases: ["airflow", "apache airflow"] },
  { id: "spark", aliases: ["spark", "apache spark"] },
  { id: "hadoop", aliases: ["hadoop"] },
  { id: "vercel", aliases: ["vercel"] },
  { id: "cloudflare", aliases: ["cloudflare"] },
  { id: "datadog", aliases: ["datadog"] },
  { id: "prometheus", aliases: ["prometheus"] },
  { id: "grafana", aliases: ["grafana"] },
  { id: "sentry", aliases: ["sentry"] },

  // ── DevOps / CI ──────────────────────────────────────────────────────────
  { id: "ci-cd", label: "CI/CD", aliases: ["ci/cd", "cicd", "ci cd", "continuous integration", "continuous delivery", "continuous deployment"] },
  { id: "github-actions", label: "GitHub Actions", aliases: ["github actions"] },
  { id: "gitlab-ci", label: "GitLab CI", aliases: ["gitlab ci", "gitlab-ci"] },
  { id: "jenkins", aliases: ["jenkins"] },
  { id: "circleci", aliases: ["circleci", "circle ci"] },
  { id: "git", aliases: ["git"] },

  // ── Data / ML ────────────────────────────────────────────────────────────
  { id: "machine-learning", label: "Machine Learning", aliases: ["machine learning", "ml"] },
  { id: "deep-learning", label: "Deep Learning", aliases: ["deep learning"] },
  { id: "pytorch", aliases: ["pytorch"] },
  { id: "tensorflow", aliases: ["tensorflow"] },
  { id: "keras", aliases: ["keras"] },
  { id: "scikit-learn", aliases: ["scikit-learn", "sklearn", "scikit learn"] },
  { id: "pandas", aliases: ["pandas"] },
  { id: "numpy", aliases: ["numpy"] },
  { id: "jupyter", aliases: ["jupyter", "jupyter notebook"] },
  { id: "huggingface", aliases: ["huggingface", "hugging face"] },
  { id: "langchain", aliases: ["langchain", "lang chain"] },
  { id: "llm", aliases: ["llm", "large language model", "large language models"] },
  { id: "nlp", aliases: ["nlp", "natural language processing"] },
  { id: "computer-vision", label: "Computer Vision", aliases: ["computer vision", "cv (computer vision)"] },
  { id: "rag", aliases: ["rag", "retrieval augmented generation", "retrieval-augmented generation"] },
  { id: "etl", aliases: ["etl", "elt"] },
  { id: "dbt", aliases: ["dbt"] },
  { id: "tableau", aliases: ["tableau"] },
  { id: "looker", aliases: ["looker"] },
  { id: "power-bi", label: "Power BI", aliases: ["power bi", "powerbi"] },
  { id: "data-warehouse", label: "Data Warehouse", aliases: ["data warehouse", "data warehousing"] },

  // ── Mobile ──────────────────────────────────────────────────────────────
  { id: "ios", aliases: ["ios"] },
  { id: "android", aliases: ["android"] },
  { id: "flutter", aliases: ["flutter"] },
  { id: "xcode", aliases: ["xcode"] },

  // ── Testing ─────────────────────────────────────────────────────────────
  { id: "jest", aliases: ["jest"] },
  { id: "vitest", aliases: ["vitest"] },
  { id: "cypress", aliases: ["cypress"] },
  { id: "playwright", aliases: ["playwright"] },
  { id: "selenium", aliases: ["selenium"] },
  { id: "pytest", aliases: ["pytest"] },
  { id: "junit", aliases: ["junit"] },
  { id: "tdd", aliases: ["tdd", "test driven development", "test-driven development"] },

  // ── Product / collaboration ─────────────────────────────────────────────
  { id: "agile", aliases: ["agile"] },
  { id: "scrum", aliases: ["scrum"] },
  { id: "kanban", aliases: ["kanban"] },
  { id: "jira", aliases: ["jira"] },
  { id: "linear", aliases: ["linear"] },
  { id: "notion", aliases: ["notion"] },
  { id: "confluence", aliases: ["confluence"] },
  { id: "figma", aliases: ["figma"] },
  { id: "sketch", aliases: ["sketch"] },
  { id: "product-management", label: "Product Management", aliases: ["product management", "product manager"] },
  { id: "a-b-testing", label: "A/B Testing", aliases: ["a/b testing", "ab testing", "a/b test"] },
  { id: "user-research", label: "User Research", aliases: ["user research", "user interviews"] },
  { id: "okrs", aliases: ["okrs", "okr"] },

  // ── Security / misc ─────────────────────────────────────────────────────
  { id: "oauth", aliases: ["oauth", "oauth2", "oauth 2.0"] },
  { id: "jwt", aliases: ["jwt"] },
  { id: "saml", aliases: ["saml"] },
  { id: "sso", aliases: ["sso", "single sign-on", "single sign on"] },
  { id: "soc2", aliases: ["soc 2", "soc2"] },
  { id: "gdpr", aliases: ["gdpr"] },
  { id: "hipaa", aliases: ["hipaa"] },

  // ── Leadership / management ─────────────────────────────────────────────
  // Phrase-heavy by design: a bare "management" / "strategy" / "leadership"
  // is exactly the noisy single-word alias the docblock above warns against
  // — it would fire on ordinary bullet prose. Every alias here is a
  // multi-word phrase (see `skills.test.ts` for the enforcing check).
  //
  // THE SKILLS-ROW PHRASINGS ARE LOAD-BEARING, NOT DECORATION (#594, #607). Most
  // aliases here are BULLET phrasings ("managed a team"); the ones that read like
  // a section heading — "engineering leadership", "hiring & talent acquisition",
  // "talent acquisition" — are how a leadership résumé's SKILLS ROW spells the
  // same competency, and they earn their place for a second reason. `deriveSkills`
  // (`job-search/query-builder.ts`) canonicalizes a chip by EXACT full-string
  // alias lookup, so an unlisted spelling stays raw free text; `term-quality.ts`
  // may not import jd-match at runtime and so compares word-wise, finds no overlap
  // between {hiring} and {technical, recruiting}, and offers the person a skill
  // their own chip already states. Add the spelling here; never loosen that
  // comparison. The cost is that the chip then RENDERS as the canonical label —
  // "Engineering Leadership" shows up as "People Management" — which is the same
  // trade "k8s" → "kubernetes" already makes, and is why an alias must be a true
  // synonym of the entry, not merely adjacent to it.
  { id: "people-management", label: "People Management", aliases: ["people management", "managed a team", "managing a team", "team management", "engineering leadership", "engineering management", "people leadership"] },
  { id: "technical-recruiting", label: "Technical Recruiting", aliases: ["technical recruiting", "led hiring", "technical hiring", "talent acquisition", "hiring & talent acquisition", "hiring and talent acquisition"] },
  { id: "performance-management", label: "Performance Management", aliases: ["performance management", "performance reviews", "performance review"] },
  { id: "coaching-mentorship", label: "Coaching / Mentorship", aliases: ["coaching and mentorship", "coaching & mentorship", "mentoring engineers"] },
  { id: "career-development", label: "Career Development", aliases: ["career development", "career growth planning"] },
  { id: "org-design", label: "Org Design", aliases: ["org design", "organizational design", "organization design", "organizational leadership"] },
  { id: "team-building", label: "Team Building", aliases: ["team building", "built and scaled a team", "grew the team"] },
  { id: "roadmap-ownership", label: "Roadmap Ownership", aliases: ["roadmap ownership", "owned the roadmap", "product roadmap ownership"] },
  { id: "project-delivery", label: "Project Delivery", aliases: ["project delivery", "delivery leadership", "delivery management", "project execution"] },
  { id: "program-management", label: "Program Management", aliases: ["program management", "technical program management"] },
  { id: "agile-leadership", label: "Agile / Scrum Leadership", aliases: ["scrum leadership", "agile leadership", "agile transformation"] },
  { id: "incident-management", label: "Incident Management", aliases: ["incident management", "incident commander", "incident response leadership"] },
  { id: "on-call-ownership", label: "On-Call Ownership", aliases: ["on-call ownership", "owned on-call", "on-call rotation ownership"] },
  { id: "technical-strategy", label: "Technical Strategy", aliases: ["technical strategy", "engineering strategy"] },
  { id: "architecture-review", label: "Architecture Review", aliases: ["architecture review", "architectural review board"] },
  { id: "platform-ownership", label: "Platform Ownership", aliases: ["platform ownership", "owned the platform"] },
  { id: "vendor-management", label: "Vendor Management", aliases: ["vendor management", "vendor negotiations"] },
  { id: "budget-headcount-planning", label: "Budget / Headcount Planning", aliases: ["budget planning", "headcount planning", "budget and headcount planning"] },
  { id: "pnl-ownership", label: "P&L Ownership", aliases: ["p&l ownership", "profit and loss ownership", "p and l ownership"] },
  { id: "stakeholder-management", label: "Stakeholder Management", aliases: ["stakeholder management", "stakeholder alignment"] },
  { id: "cross-functional-collaboration", label: "Cross-Functional Collaboration", aliases: ["cross-functional collaboration", "cross functional collaboration"] },
  { id: "executive-communication", label: "Executive Communication", aliases: ["executive communication", "executive presentations", "communicating with executives"] },
  { id: "technical-writing", label: "Technical Writing", aliases: ["technical writing", "wrote technical documentation"] },
];

/**
 * Build a single regex that finds any alias from any skill, returning the
 * canonical ID via the alias-to-id index. We compile once at module load —
 * each pass over a JD is O(text length) instead of O(text × skills).
 *
 * The boundary lookarounds live in `regex-utils.ts` and are shared with
 * the resume-corpus probes in `coverage.ts` so both sides match the same
 * notion of "word boundary".
 *
 * `mentionPatterns` is a parallel index mapping each canonical ID to a
 * single per-skill regex that checks whether the corpus mentions any of
 * that skill's aliases. Prebuilt here so the coverage check doesn't
 * recompile a regex per alias per call.
 */
import {
  ALIAS_BOUNDARY_PREFIX,
  ALIAS_BOUNDARY_SUFFIX,
  escapeRegex,
} from "./regex-utils.ts";

interface CompiledIndex {
  readonly pattern: RegExp;
  readonly aliasToId: ReadonlyMap<string, string>;
  readonly idToAliases: ReadonlyMap<string, readonly string[]>;
  /** Canonical ID → human display label (falls back to the id when an entry
   *  has no explicit `label`). Lets the extractor render a clean term name
   *  instead of the kebab id (`a-b-testing` → `A/B Testing`). */
  readonly idToLabel: ReadonlyMap<string, string>;
  /** Per-canonical-ID mention probe — `mentionPatterns.get("kubernetes")`
   *  returns a single regex that fires on any of {"kubernetes", "k8s"}. */
  readonly mentionPatterns: ReadonlyMap<string, RegExp>;
}

function compileIndex(): CompiledIndex {
  const aliasToId = new Map<string, string>();
  const idToAliases = new Map<string, readonly string[]>();
  const idToLabel = new Map<string, string>();
  const mentionPatterns = new Map<string, RegExp>();
  for (const entry of SKILLS) {
    idToAliases.set(entry.id, entry.aliases);
    idToLabel.set(entry.id, entry.label ?? entry.id);
    for (const alias of entry.aliases) {
      aliasToId.set(alias.toLowerCase(), entry.id);
    }
    const aliasGroup = entry.aliases
      .map((a) => escapeRegex(a.toLowerCase()))
      .join("|");
    mentionPatterns.set(
      entry.id,
      new RegExp(
        `${ALIAS_BOUNDARY_PREFIX}(?:${aliasGroup})${ALIAS_BOUNDARY_SUFFIX}`,
        "i",
      ),
    );
  }
  // Sort aliases longest-first so multi-word phrases ("ruby on rails") win
  // against their prefixes ("ruby") inside a single regex pass.
  const sorted = Array.from(aliasToId.keys()).sort(
    (a, b) => b.length - a.length,
  );
  const body = sorted.map(escapeRegex).join("|");
  const pattern = new RegExp(
    `${ALIAS_BOUNDARY_PREFIX}(${body})${ALIAS_BOUNDARY_SUFFIX}`,
    "gi",
  );
  return { pattern, aliasToId, idToAliases, idToLabel, mentionPatterns };
}

let cached: CompiledIndex | null = null;

export function getSkillIndex(): CompiledIndex {
  if (!cached) cached = compileIndex();
  return cached;
}

/** Number of canonical skills in the dictionary. Used by tests. */
export function skillCount(): number {
  return SKILLS.length;
}
