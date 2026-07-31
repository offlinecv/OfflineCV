// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Compensation extraction — pull a pay range out of a posting's description
 * (#564, job-search-v3 epic #566).
 *
 * US pay-transparency laws (CO, CA, NY, WA, IL, and more) require postings to
 * state a range, and the ATS boards this lane already reads (Greenhouse,
 * Lever, Ashby) reproduce it verbatim in the description text the lane
 * already fetched — nothing new is fetched, nothing new leaves the browser.
 * `extractCompensation` regexes that text entirely on-device.
 *
 * Two invariants the rest of the lane depends on:
 *
 *   - SILENCE IS NEUTRAL. A posting with no extractable range returns
 *     `undefined` here, and every downstream consumer (rank.ts's sort key,
 *     JobResultCard) must treat that identically to "no compensation field at
 *     all" — never as "pays badly." Non-extraction is the common case
 *     (non-US postings, older listings, boards that omit pay) and must never
 *     read as a signal.
 *   - `raw` IS ALWAYS THE MATCHED SUBSTRING. A misparse must be visible, not
 *     a silent wrong number — the card surfaces `raw` in a tooltip so a bad
 *     match is diagnosable rather than trusted blindly.
 *
 * Shapes covered (from the issue): "$180,000 - $240,000", "$180K–$240K",
 * "USD 180000 to 240000", "$95/hour", and single-value forms ("$120,000").
 * A CURRENCY MARKER (symbol or ISO code) IS REQUIRED for a match — a bare
 * number range ("5-10 years", "50-100 employees") is extremely common in
 * posting text and would false-positive constantly without this gate. The
 * tradeoff: a posting that states pay with neither a symbol nor a code (rare
 * in practice) is silently missed, which is the correct failure mode per the
 * silence-is-neutral invariant above — better to under-match than to
 * misreport a random number as a salary.
 *
 * NON-SALARY DOLLAR FIGURES ARE THE HARD PART (job-search-v3 epic #566). A
 * description routinely carries currency figures that are NOT the pay: "raised
 * $5M in Series B", "$250,000 marketing budget", "equity worth $100,000",
 * "customers save $200/month". The extractor MUST NOT read those as a salary,
 * because the parse drives two signals no human vets — the "below your floor"
 * badge and the `COMP_FLOOR_PENALTY` sort demotion. Three guards keep it
 * honest, all scanning EVERY currency match (not just the first) so a leading
 * funding figure is skipped rather than locked in:
 *
 *   1. MAGNITUDE-SUFFIX GUARD. A figure immediately followed by a millions/
 *      billions suffix ("$5M", "$5 million", "$50bn") is funding/valuation, not
 *      a salary shape — the match is rejected outright rather than silently
 *      read as "$5". Never drop the magnitude and keep the number.
 *   2. NO MAGNITUDE→HOURLY INFERENCE. A bare small "$N" is NOT assumed hourly.
 *      `hour` is inferred ONLY from an explicit period token (/hr, per hour,
 *      hourly, …). Without one a small figure is not silently turned into a wage.
 *   3. SALARY-CONTEXT GATE for lone single values, applied DIRECTIONALLY. A
 *      single figure with neither a salary-context word ATTACHED to it
 *      (salary/comp/pay/base/OTE/annual/…) nor a trustworthy standalone period
 *      (explicit annual or hourly — a lone MONTHLY single is usually SaaS
 *      pricing/savings, not pay) is treated as NOT extractable. Attachment is
 *      nearest-figure, not window-membership: each salary word binds to the
 *      single closest figure, so a non-salary figure ("equity worth $100,000")
 *      no longer captures a salary word that sits closer to a LATER figure
 *      ("…, salary $180,000") — the later, truly-salaried figure wins (#566).
 *      Attribution also never crosses a sentence boundary, so "budget of
 *      $250,000. Salary is $150,000" binds "Salary" forward to $150,000.
 *      Aligned with, not a regression of, #564's single-value acceptance: a
 *      genuine single salary still parses when a salary word sits next to it
 *      ("Base pay: $120,000") or it carries an explicit annual/hourly period.
 *      Ranges are exempt — a currency-anchored range that survives the suffix
 *      guard is a deliberate pay statement and wins before singles are scored.
 *
 * The one range shape NOT exempt from that last point is an "and"-separated
 * pair (#699). "and" had to become a separator because "between $X and $Y" is
 * how US pay-transparency boilerplate states a range, but it is also an
 * ordinary conjunction between two unrelated figures — so it carries its own
 * gate (`isTrustedRange`) rather than riding the ranges-are-deliberate
 * exemption.
 */

export type CompensationPeriod = "year" | "hour" | "month";

export interface Compensation {
  min?: number;
  max?: number;
  /** ISO-ish currency code, e.g. "USD", "GBP", "EUR". */
  currency: string;
  period: CompensationPeriod;
  /** The exact matched source substring — surfaced on the card so a misparse
   *  is visible rather than a silent wrong number. */
  raw: string;
}

const CURRENCY_SYMBOL_TO_CODE: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
};

const CUR_SYM = String.raw`\$|£|€`;
const CUR_CODE = String.raw`USD|EUR|GBP|CAD|AUD|NZD|CHF`;

/**
 * A number, either comma-grouped ("180,000", "1,234,567", with an optional
 * decimal tail) or a bare digit run ("180000", "95", "95.5"). The
 * comma-grouped alternative is tried FIRST and must consume the whole
 * grouped number (one-or-more ",ddd" groups) — without that ordering,
 * "180000" would short-match as just "180" (the comma-grouped branch's
 * `\d{1,3}` head) and silently drop the rest of the digits. The bare-digit
 * branch is the fallback for ungrouped numbers.
 */
const NUM = String.raw`\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

/** Range separators: ASCII hyphen, en dash, em dash, "~", or the words "to"
 *  and "and" (word-bounded so "to" never matches inside "photo" etc.). "and"
 *  is here because "between $X and $Y" is the standard phrasing of US
 *  pay-transparency boilerplate (CA/NY/CO/WA) and was previously unreadable
 *  (#699) — but unlike the others it is a common conjunction, so a match on it
 *  carries a guard the punctuation separators don't need. See
 *  `isTrustedRange`. */
const SEP = String.raw`-|–|—|~|\bto\b|\band\b`;

/** Period tokens that require an explicit "/" or "per " prefix to count —
 *  "hour" alone is too generic to trust unprefixed. */
const PERIOD_WORD = String.raw`hour|hr|year|yr|annum|month|mo`;

/** Period ADVERBS are unambiguous on their own, no "/" or "per" needed. */
const PERIOD_ADVERB = String.raw`annually|hourly|monthly|yearly`;

/** A number immediately followed by an optional "K"/"k" suffix (thousands
 *  shorthand), guarded so it doesn't swallow the first letter of an
 *  adjacent word ("180Kubernetes" must not read as "180K"). */
function numWithK(numGroup: string, kGroup: string): string {
  return String.raw`(?<${numGroup}>${NUM})\s*(?:(?<${kGroup}>[kK])(?![a-zA-Z]))?`;
}

/** A mandatory currency marker — either a symbol or a word-bounded ISO code.
 *  Mandatory (no trailing `?`) so every match is anchored to an actual
 *  currency mention, never a bare number. */
function currencyGroup(symName: string, codeName: string): string {
  return String.raw`(?:(?<${symName}>${CUR_SYM})|\b(?<${codeName}>${CUR_CODE})\b)`;
}

const PERIOD_TAIL = String.raw`(?:\s*(?:\/|per\s+)\s*(?<per1>${PERIOD_WORD})\b)?(?:\s*\b(?<per2>${PERIOD_ADVERB})\b)?`;

/** Range shape: currency + num [+K] + separator + [currency] + num [+K] +
 *  optional period. Tried before `SINGLE_RE` so a genuine range always wins
 *  over accidentally matching just its first number. The separator is captured
 *  (`sep`) so `isTrustedRange` can tell an "and" match — which needs proof it is
 *  a range at all — from the unambiguous punctuation separators. */
const RANGE_RE = new RegExp(
  currencyGroup("sym1", "code1") +
    String.raw`\s*` +
    numWithK("num1", "k1") +
    String.raw`\s*(?<sep>${SEP})\s*` +
    String.raw`(?:${currencyGroup("sym2", "code2")}\s*)?` +
    numWithK("num2", "k2") +
    PERIOD_TAIL,
  "gi",
);

/** Single-value shape: currency + num [+K] + optional period. No range
 *  separator required. */
const SINGLE_RE = new RegExp(
  currencyGroup("sym1", "code1") + String.raw`\s*` + numWithK("num1", "k1") + PERIOD_TAIL,
  "gi",
);

/**
 * A millions/billions magnitude suffix immediately after a matched figure.
 * "$5M" / "$5 million" / "$50bn" is funding, valuation, or market size — never
 * a salary shape — so a match trailed by one is rejected rather than read as
 * the bare number with its magnitude silently dropped (#566). Anchored at the
 * start of the post-match remainder; word-bounded so "$90K bonus" (a "b" word)
 * is not mistaken for a "$90 billion" suffix.
 */
const MAGNITUDE_SUFFIX_RE = /^\s*(?:million|billion|mm|bn|m|b)\b/i;

/**
 * A salary/pay context word. Proximity to a lone single figure is what
 * distinguishes "Base pay: $120,000" (a salary) from "$250,000 marketing
 * budget" or "equity worth $100,000" (not). Word-bounded so it keys on the
 * actual token, not a substring of an unrelated word. "annual"/"annually" are
 * included as period-flavoured context so a bare "annual $115,000" — a real
 * salary shape whose only marker is the period word — is extractable (#566).
 * The tradeoff: "annual budget $250,000" can now match, but a lone high budget
 * figure rarely trips the floor, and a false-negative on real pay is the worse
 * failure mode than an occasional benign over-match.
 */
const SALARY_CONTEXT_RE =
  /\b(?:salary|salaries|compensation|comp|pay|base|ote|wage|wages|earn|earnings|remuneration|stipend|annual|annually)\b/i;

/** Global twin of `SALARY_CONTEXT_RE` for enumerating every salary-word
 *  occurrence (with position) — needed for the directional nearest-figure
 *  attribution below, which a single boolean `.test()` cannot express. */
const SALARY_CONTEXT_GLOBAL_RE = new RegExp(SALARY_CONTEXT_RE.source, "gi");

/** Maximum character gap between a salary word and the figure it may attach to.
 *  Beyond this the word is unrelated. Mirrors the previous 60-char left window,
 *  now applied in EITHER direction since a qualifier can trail the figure
 *  ("$150,000 base salary") as well as precede it. */
const SALARY_WINDOW = 60;

/** Sentence-boundary characters a salary word may NOT bind across. Without this,
 *  a trailing punctuation gap ("$250,000. Salary…" — only ". " wide) would read
 *  as nearer than the salary word's own introductory clause (" Salary is …"),
 *  so the label would bind backwards to the previous sentence's figure. A colon
 *  is deliberately NOT a boundary — "Base pay: $120,000" must still bind. */
const SENTENCE_BOUNDARY_RE = /[.;!?\n]/;

function parseNum(raw: string, kFlag: string | undefined): number {
  const value = parseFloat(raw.replace(/,/g, ""));
  return kFlag ? value * 1000 : value;
}

function resolveCurrency(sym: string | undefined, code: string | undefined): string | undefined {
  if (code) return code.toUpperCase();
  if (sym) return CURRENCY_SYMBOL_TO_CODE[sym];
  return undefined;
}

/**
 * Resolve a period token/adverb to the normalized field. When the text carries
 * NO explicit period marker the period defaults to yearly — the overwhelmingly
 * common unstated case for salaried listings. A missing marker is NEVER read as
 * hourly from magnitude alone (#566): a bare small "$N" must not become an
 * hourly wage on a guess; `hour` requires an explicit /hr, per hour, or hourly
 * token.
 */
function resolvePeriod(per1: string | undefined, per2: string | undefined): CompensationPeriod {
  const token = (per1 ?? per2 ?? "").toLowerCase();
  if (token === "hour" || token === "hr" || token === "hourly") return "hour";
  if (token === "month" || token === "mo" || token === "monthly") return "month";
  if (["year", "yr", "annum", "annually", "yearly"].includes(token)) return "year";
  return "year";
}

/** A structurally valid `Compensation` plus whether its period is a
 *  trustworthy standalone salary marker (explicit annual/hourly; a lone monthly
 *  single is not). The flag lets the single-figure selector rank a
 *  period-carrying figure below a salary-word-attached one without re-deriving
 *  it. */
type RawCandidate = Compensation & { hasTrustedPeriod: boolean };

/**
 * Build a `Compensation` from one regex match, applying only the magnitude
 * guard (#566) and structural checks. Does NOT apply the salary-context gate —
 * that is directional and the caller's job (ranges skip it entirely; singles
 * apply the nearest-figure rule in `bestSingle`). Returns `undefined` when the
 * match is not a structurally valid currency figure.
 */
function candidateFrom(text: string, match: RegExpMatchArray): RawCandidate | undefined {
  const groups = match.groups;
  if (!groups || match.index === undefined) return undefined;

  // Guard 1 — magnitude suffix: "$5M"/"$5 billion" is funding, not salary.
  if (MAGNITUDE_SUFFIX_RE.test(text.slice(match.index + match[0].length))) return undefined;

  const currency = resolveCurrency(groups.sym1, groups.code1);
  if (!currency) return undefined;

  const num1 = parseNum(groups.num1, groups.k1);
  if (!Number.isFinite(num1)) return undefined;

  const num2Raw = groups.num2;
  const num2 = typeof num2Raw === "string" ? parseNum(num2Raw, groups.k2) : undefined;

  const period = resolvePeriod(groups.per1, groups.per2);
  const hasExplicitPeriod = Boolean(groups.per1 || groups.per2);
  // A lone MONTHLY single with no salary context is usually SaaS pricing/
  // savings, not pay — so a month period is NOT a trustworthy standalone marker.
  const hasTrustedPeriod = hasExplicitPeriod && period !== "month";

  const min = num2 !== undefined ? Math.min(num1, num2) : num1;
  const max = num2 !== undefined ? Math.max(num1, num2) : num1;
  return { min, max, currency, period, raw: match[0].trim(), hasTrustedPeriod };
}

/** Drop the ranking metadata, yielding the public `Compensation`. */
function stripMeta(c: RawCandidate): Compensation {
  return { min: c.min, max: c.max, currency: c.currency, period: c.period, raw: c.raw };
}

interface SingleFigure {
  match: RegExpMatchArray;
  index: number;
  length: number;
}

/**
 * Every currency-anchored single figure in `text`, in position order. Includes
 * magnitude-suffixed figures ("$5M") on purpose: they still count as a figure
 * that can sit BETWEEN a salary word and another figure, so a salary word never
 * leapfrogs a funding figure to bind to a farther salary. The magnitude figure
 * itself is still rejected at extraction time by `candidateFrom`.
 */
function collectSingleFigures(text: string): SingleFigure[] {
  const figs: SingleFigure[] = [];
  for (const match of text.matchAll(SINGLE_RE)) {
    const groups = match.groups;
    if (!groups || match.index === undefined) continue;
    if (!resolveCurrency(groups.sym1, groups.code1)) continue;
    if (!Number.isFinite(parseNum(groups.num1, groups.k1))) continue;
    figs.push({ match, index: match.index, length: match[0].length });
  }
  return figs;
}

/**
 * Character gap between a salary-word span [ws,we) and a figure span [fs,fe),
 * or `Infinity` if a sentence boundary sits between them (the word cannot bind
 * across it). 0 if they overlap.
 */
function salaryGap(text: string, ws: number, we: number, fs: number, fe: number): number {
  if (fe <= ws) {
    // figure entirely before the word — reject if a boundary intervenes.
    return SENTENCE_BOUNDARY_RE.test(text.slice(fe, ws)) ? Infinity : ws - fe;
  }
  if (fs >= we) {
    // figure entirely after the word.
    return SENTENCE_BOUNDARY_RE.test(text.slice(we, fs)) ? Infinity : fs - we;
  }
  return 0;
}

/**
 * Figure start-indices that a salary word ATTACHES to, by the directional
 * nearest-figure rule (#566). Each salary word binds to the single closest
 * figure within `SALARY_WINDOW` that it can reach WITHOUT crossing a sentence
 * boundary. A word equidistant between two reachable figures is a TIE and
 * attaches to NEITHER — ambiguous attribution is dropped rather than guessed,
 * protecting the never-a-false-below-floor invariant. Together these stop a
 * non-salary figure ("equity worth $100,000") from validating itself off a
 * salary word that actually introduces a later figure ("…, salary $180,000").
 */
function salaryAttachedIndices(text: string, figs: SingleFigure[]): Set<number> {
  const attached = new Set<number>();
  for (const w of text.matchAll(SALARY_CONTEXT_GLOBAL_RE)) {
    if (w.index === undefined) continue;
    const ws = w.index;
    const we = w.index + w[0].length;
    let bestGap = Infinity;
    let bestIndex = -1;
    let tie = false;
    for (const f of figs) {
      const g = salaryGap(text, ws, we, f.index, f.index + f.length);
      if (g < bestGap) {
        bestGap = g;
        bestIndex = f.index;
        tie = false;
      } else if (g === bestGap && g !== Infinity) {
        tie = true;
      }
    }
    if (bestIndex >= 0 && bestGap <= SALARY_WINDOW && !tie) attached.add(bestIndex);
  }
  return attached;
}

/**
 * Words that may introduce an "and"-separated range, immediately before the
 * figure. In English "and" joins two endpoints into a RANGE essentially only
 * inside the "between … and …" construction; "from … and …" and "in the range
 * of … and …" are the loose variants that show up in real posting boilerplate.
 * End-anchored, and tested against the text PRECEDING the match, so the intro
 * word must sit adjacent to the first figure rather than anywhere earlier in
 * the sentence.
 */
const AND_RANGE_INTRO_RE = /\b(?:between|from|range\s+of)\s*$/i;

/**
 * Whether a `RANGE_RE` match may be trusted as a pay range (#699).
 *
 * The punctuation separators and "to" are unambiguous range markers, so they
 * pass unconditionally — this gate exists only for "and", which is a far more
 * common word and joins two UNRELATED figures far more often than two endpoints
 * ("a $500 and $2,000 relocation", "we raised $10,000,000 and $5,000,000"). A
 * false range is worse than a missed one: a miss drops the comp axis and
 * `rateJobs` renormalizes the remaining weights, whereas a false range actively
 * mis-scores. So an "and" pair must clear two independent tests:
 *
 *   1. AN INTRO WORD immediately precedes it (`AND_RANGE_INTRO_RE`). Without
 *      this, every adjacent currency pair in a description reads as pay.
 *   2. IT ASCENDS. A range runs low→high; the other common "between … and …"
 *      construction is an ENUMERATION ("choose between $15,000 and $7,500
 *      depending on distance"), and descending order is the tell. Note this is
 *      deliberately scoped to "and" — `candidateFrom` normalizes with
 *      Math.min/max, so a descending punctuation range keeps its existing
 *      behaviour and no other separator changes.
 *
 * Measured against a labelled corpus of both shapes, each clause is
 * load-bearing: dropping the intro test admits 8 false ranges, dropping the
 * ascending test admits the enumeration above.
 */
function isTrustedRange(text: string, match: RegExpMatchArray): boolean {
  const groups = match.groups;
  if (!groups || match.index === undefined) return false;
  if (groups.sep?.toLowerCase() !== "and") return true;

  if (!AND_RANGE_INTRO_RE.test(text.slice(0, match.index))) return false;

  if (typeof groups.num2 !== "string") return false;
  const num1 = parseNum(groups.num1, groups.k1);
  const num2 = parseNum(groups.num2, groups.k2);
  return Number.isFinite(num1) && Number.isFinite(num2) && num2 > num1;
}

/** First accepted range across ALL matches of `RANGE_RE` — a currency-anchored
 *  range that survives the magnitude guard is a deliberate pay statement, so a
 *  leading non-salary figure is skipped and the first real range wins. An "and"
 *  match that fails `isTrustedRange` is SKIPPED, not aborted on, so a later
 *  genuine range in the same description still wins. */
function firstRange(text: string): Compensation | undefined {
  for (const match of text.matchAll(RANGE_RE)) {
    if (!isTrustedRange(text, match)) continue;
    const c = candidateFrom(text, match);
    if (c) return stripMeta(c);
  }
  return undefined;
}

/**
 * Pick the best single-figure salary via directional attribution (#566).
 * Priority, highest first:
 *   1. A figure a salary word ATTACHES to (nearest-figure rule) — this beats a
 *      period-only figure regardless of position, so "$45/hour … real salary
 *      $180,000" resolves to the $180,000 salary, not the contractor rate.
 *   2. A figure carrying a trustworthy standalone period (explicit annual/
 *      hourly), when no salary-attached figure exists ("$95/hour").
 * Within a priority the EARLIEST figure by position wins — deterministic, and
 * for co-attached figures ("base salary $120,000 … OTE $200,000") the earliest
 * is the base/primary figure, the conservative floor-comparison choice. A
 * figure with neither signal is never returned. Ranges win before this runs.
 */
function bestSingle(text: string): Compensation | undefined {
  const figs = collectSingleFigures(text);
  if (figs.length === 0) return undefined;
  const attached = salaryAttachedIndices(text, figs);

  let attachedComp: Compensation | undefined;
  let periodComp: Compensation | undefined;
  for (const f of figs) {
    const c = candidateFrom(text, f.match);
    if (!c) continue; // magnitude-suffixed / structurally invalid → not a salary
    if (attached.has(f.index)) {
      attachedComp ??= stripMeta(c);
    } else if (c.hasTrustedPeriod) {
      periodComp ??= stripMeta(c);
    }
  }
  return attachedComp ?? periodComp;
}

/**
 * Extract a compensation range from free text (a posting's `description`).
 * Returns `undefined` when no trustworthy currency-anchored salary is found —
 * the neutral, common case (#566: a non-salary dollar figure returns undefined
 * rather than a guessed wage). Ranges are tried before single values so a
 * genuine range always wins over matching just its first number; among singles,
 * salary attachment is DIRECTIONAL (nearest-figure) so a non-salary figure never
 * captures a salary word that belongs to a later figure. Never throws.
 */
export function extractCompensation(text: string): Compensation | undefined {
  if (!text) return undefined;
  return firstRange(text) ?? bestSingle(text);
}

/** Full-time-equivalent hours/year (40hr × 52wk) — the standard approximation
 *  used to compare an hourly or monthly range against an annual floor. */
const HOURS_PER_YEAR = 2080;
const MONTHS_PER_YEAR = 12;

/** Annualize one `Compensation` figure so it can be compared against a
 *  user-entered annual floor, regardless of the posting's stated period. */
function annualize(amount: number, period: CompensationPeriod): number {
  if (period === "hour") return amount * HOURS_PER_YEAR;
  if (period === "month") return amount * MONTHS_PER_YEAR;
  return amount;
}

/**
 * True when `comp`'s best-case (top of range) figure still falls below
 * `floor` — the SOFT signal `rank.ts` reads for its sort-key penalty and
 * `JobResultCard` reads for the "below your floor" badge (#564). NEVER a
 * hard filter — callers must keep the posting either way.
 *
 * Neutral (false) whenever there is nothing safe to compare:
 *   - no `comp` (nothing extracted — silence is neutral, the core invariant)
 *   - no `floor` set
 *   - `comp.currency !== "USD"` — the floor is a plain number with no
 *     currency of its own (assumed USD, matching the deep-link/keyword
 *     lane's US-centric defaults); comparing a non-USD figure against it
 *     would silently misreport an FX mismatch as "underpaying."
 */
export function isBelowFloor(comp: Compensation | undefined, floor: number | undefined): boolean {
  if (!comp || floor === undefined) return false;
  if (comp.currency !== "USD") return false;
  const best = comp.max ?? comp.min;
  if (best === undefined) return false;
  return annualize(best, comp.period) < floor;
}

/**
 * Below this annualized figure, an extracted "compensation" is not a plausible
 * full-time salary — it is almost always a misparse (a "$300" fee/stipend, a
 * bare number the period defaulted to yearly, a dropped "million"). The rating's
 * comp axis (#561) uses this to REJECT such a value rather than let a garbage
 * $300/yr tank a genuinely strong fit. Deliberately loose (a real salary clears
 * it by an order of magnitude); it only screens out the obviously-not-a-salary.
 */
const PLAUSIBLE_ANNUAL_COMP_MIN = 10000;

/**
 * The annualized top-of-range for a comp (`max ?? min`), period-normalized so an
 * hourly/monthly posting compares fairly against a yearly one — or `undefined`
 * when there is no figure OR it is below `PLAUSIBLE_ANNUAL_COMP_MIN` (a misparse
 * the rating should ignore, not trust). The single place the rating reads a
 * posting's pay, so a comp too small to be real never enters a `JobRating`.
 */
export function annualizedTop(comp: Compensation): number | undefined {
  const top = comp.max ?? comp.min;
  if (top === undefined) return undefined;
  const annual = annualize(top, comp.period);
  return annual >= PLAUSIBLE_ANNUAL_COMP_MIN ? annual : undefined;
}

/** Format a `Compensation` for the card face, e.g. "$180K–$240K/yr" or
 *  "$95/hr". Non-USD currencies show the ISO code as a prefix since there's
 *  no universal symbol convention to lean on. */
export function formatCompensationRange(comp: Compensation): string {
  const symbol =
    comp.currency === "USD"
      ? "$"
      : comp.currency === "GBP"
        ? "£"
        : comp.currency === "EUR"
          ? "€"
          : `${comp.currency} `;
  const fmt = (n: number) => `${symbol}${Math.round(n).toLocaleString("en-US")}`;
  const periodSuffix = comp.period === "hour" ? "/hr" : comp.period === "month" ? "/mo" : "/yr";
  const body =
    comp.min !== undefined && comp.max !== undefined && comp.min !== comp.max
      ? `${fmt(comp.min)}–${fmt(comp.max)}`
      : fmt(comp.max ?? comp.min ?? 0);
  return `${body}${periodSuffix}`;
}
