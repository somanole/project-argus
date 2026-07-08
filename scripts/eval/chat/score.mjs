// S7 chat faithfulness scoring (H4). Pure functions, no I/O — same shape as the
// enrichment score.mjs so verify.mjs can import + sanity-run it without a key.
//
// THE GATE: invented facts = 0. An "invented fact" is an entity NAME or a NUMBER in the
// model's answer that is NOT grounded in the tool output it received (the grounding
// corpus = every tool-result JSON the model saw, plus the surfaced refs and the system
// prompt). We are deliberately:
//   • STRICT on the structural guarantee — every workflow the answer names must appear
//     in the grounding corpus (a fabricated workflow has no ref and no tool row).
//   • LENIENT on English — we only flag ENTITY-LIKE spans (quoted strings, Capitalized
//     multi-word phrases, emails) and skip common words, so a noisy scorer can't cry
//     wolf. A gate that false-positives is worse than useless: nobody would trust it.
//
// Every heuristic below is commented with WHY it's safe, because this number protects
// the pilot and a reviewer must be able to audit it without reading the model output.

// ── Corpus normalization ───────────────────────────────────────────────────────

/** Lowercased corpus for case-insensitive substring containment checks. */
export function normalizeCorpus(groundingCorpus) {
  return String(groundingCorpus ?? '').toLowerCase();
}

// A denylist of spans that LOOK entity-like (Capitalized) but are ordinary English /
// product chrome, so they never count as an invented workflow name. Conservative on
// purpose — better to miss a rare real invention than to flag "The Governance Score".
const STOPWORD_ENTITIES = new Set([
  'i', 'you', 'it', 'the', 'a', 'an', 'and', 'or', 'but', 'no', 'none', 'nothing',
  'yes', 'ok', 'argus', 'n8n', 'workflow', 'workflows', 'owner', 'owners', 'critical',
  'high', 'medium', 'low', 'failing', 'degraded', 'healthy', 'idle', 'unknown',
  'settings', 'production', 'staging', 'governance', 'score', 'here', 'this', 'that',
  'these', 'those', 'currently', 'right', 'now',
]);

// Ordinary words that a Capitalized span may START or END with because it began a
// sentence or clause ("If Sarah Chen…", "GDPR Data Erasure. The…"). We trim these off the
// EDGES of a span before grounding it — never from the middle — so a real name glued to a
// sentence word ("If Sarah Chen") is checked as the name it is. Substring grounding stays
// correct: trimming only ever makes a span shorter, so a trimmed span that grounds was
// always a real substring of the corpus.
const EDGE_WORDS = new Set([
  ...STOPWORD_ENTITIES,
  'if', 'total', 'both', 'so', 'then', 'based', 'note', 'also', 'plus', 'with', 'for',
  'to', 'of', 'in', 'on', 'is', 'are', 'was', 'were', 'has', 'have', 'will', 'would',
  'there', 'their', 'they', 'we', 'our', 'all', 'any', 'each', 'only', 'just',
]);

// Number tokens we never treat as invented: years and clock-like values are almost
// always timestamps quoted back, not fabricated governance figures.
const YEAR_RE = /^(19|20)\d{2}$/;
// ISO dates/times and clock times in an answer are timestamp echoes — their digit parts
// ("2026-07-24" → 07, 24) are not fabricated governance counts, so we strip them whole
// before extracting numbers.
const DATE_RE = /\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?z?)?/gi;
const CLOCK_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

// ── Extraction from the answer ──────────────────────────────────────────────────

/**
 * Candidate ENTITY names in the answer: (a) anything the model quoted (single/double/
 * back-tick) — the model quotes workflow names — and (b) Capitalized multi-word spans
 * (≥2 Capitalized words in a row), which is what a workflow/person name looks like.
 * Emails are extracted separately. Single lone Capitalized words are NOT flagged (too
 * noisy — sentence starts, "Slack", etc.).
 */
export function extractAnswerNames(answer) {
  const text = String(answer ?? '');
  const names = new Set();
  const add = (raw) => {
    // Strip surrounding punctuation the model may have glued on (a period INSIDE the quote,
    // "Quarterly Unicorn Sync.") so it doesn't defeat the corpus substring match.
    const cleaned = String(raw).trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    const span = trimSpan(cleaned);
    if (span && !isTrivialSpan(span)) names.add(span);
  };

  // (a) Quoted spans. UNAMBIGUOUS delimiters only: double quotes (straight + typographic)
  // and backticks. We do NOT treat the straight apostrophe as a quote here — that split
  // contractions ("don't see 'X'" → captured "t see "). Straight single quotes are read
  // only at a word boundary (below), so possessives/contractions can't open a span.
  for (const m of text.matchAll(/["“‟`]([^"”`\n]{2,80})["”`]/g)) add(m[1]);
  for (const m of text.matchAll(/(?:^|[\s([>])'([^'\n]{2,80})'(?=[\s).,;:!?]|$)/g)) add(m[1]);

  // (b) Capitalized multi-word spans (a proper-noun run of 2+ words). Allows lowercase
  // connectors (to/of/and/the) INSIDE the run so "Sync Customers to HubSpot" is one span.
  // Separators are spaces/tabs ONLY (not newlines) so a span never crosses a line/heading
  // boundary and glues a following heading word onto a real name ("… Run\nRecommendation").
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]+(?:[ \t]+(?:[A-Z][A-Za-z0-9]+|to|of|and|the|for|a))*[ \t]+[A-Z][A-Za-z0-9]+)\b/g)) add(m[1]);

  return [...names];
}

/** Strip ordinary sentence words off the EDGES of a span (never the middle). */
function trimSpan(span) {
  let words = span.split(/\s+/).filter(Boolean);
  while (words.length && EDGE_WORDS.has(words[0].toLowerCase())) words.shift();
  while (words.length && EDGE_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

/** A span is trivial (never flagged) when every word is a stopword/short connector. */
function isTrivialSpan(span) {
  const words = span.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((w) => STOPWORD_ENTITIES.has(w) || w.length <= 2);
}

/** Emails mentioned in the answer — each must be grounded (never a fabricated address). */
export function extractAnswerEmails(answer) {
  const out = new Set();
  for (const m of String(answer ?? '').matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) {
    // Strip trailing sentence punctuation the regex may have swallowed (".", ",", ")")
    // so a grounded "sarah@corp.io." isn't a false invention.
    out.add(m[0].replace(/[.,;:)\]]+$/, ''));
  }
  return [...out];
}

/**
 * Integer tokens in the answer, excluding years and things that read as clock/ordinal
 * noise. Percentages keep their base integer (e.g. "90%" → 90). Returns unique strings.
 */
export function extractAnswerNumbers(answer) {
  // Strip timestamp echoes first so their digit parts aren't mistaken for counts.
  const text = String(answer ?? '').replace(DATE_RE, ' ').replace(CLOCK_RE, ' ');
  const nums = new Set();
  // Match decimals as WHOLE tokens ("50.9" is one number, not "50" + "9").
  for (const m of text.matchAll(/\b(\d{1,7}(?:\.\d+)?)\b/g)) {
    const tok = m[1];
    if (YEAR_RE.test(tok)) continue; // a year → timestamp echo, not a governance count
    nums.add(tok);
  }
  return [...nums];
}

// ── Grounding checks ────────────────────────────────────────────────────────────

/**
 * A name is grounded when it appears (case-insensitive substring) in the corpus — OR it
 * is a connector-joined list ("OpenAI and Stripe", "A, B and C") whose every part is
 * grounded. The parts test only ever passes when EACH element is real, so it can't launder
 * a fabricated name in via a real one.
 */
export function nameGrounded(name, corpusLower) {
  const n = String(name).toLowerCase();
  if (corpusLower.includes(n)) return true;
  const parts = n.split(/\s+and\s+|\s+or\s+|\s*,\s*|\s*&\s*/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 && parts.every((p) => corpusLower.includes(p));
}

/**
 * A number is grounded when it appears as a digit run in the corpus, OR is small enough
 * (≤ enumeratedMax) to be a "count of a list the model just enumerated" — e.g. the model
 * says "3 workflows" and lists 3. We treat 0..enumeratedMax as trivially derivable so a
 * legitimately-counted list never trips the gate. Larger numbers MUST be in the corpus.
 */
export function numberGrounded(num, corpusLower, enumeratedMax) {
  const n = Number(num);
  if (Number.isFinite(n) && n <= Math.max(0, enumeratedMax)) return true; // countable
  // Digit-boundary match so "9" doesn't match inside "90".
  return new RegExp(`(?<![\\d.])${escapeRe(String(num))}(?![\\d])`).test(corpusLower);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Score ONE answer for faithfulness. Returns the invented tokens (names/emails/numbers)
 * and the total. `enumeratedMax` is the largest list length the answer could be counting
 * (pass the max of the tool-result list sizes the model saw — a safe upper bound).
 */
export function scoreFaithfulness(answer, groundingCorpus, enumeratedMax = 0) {
  const corpusLower = normalizeCorpus(groundingCorpus);
  const inventedNames = extractAnswerNames(answer).filter((n) => !nameGrounded(n, corpusLower));
  const inventedEmails = extractAnswerEmails(answer).filter((e) => !nameGrounded(e, corpusLower));
  const inventedNumbers = extractAnswerNumbers(answer).filter((n) => !numberGrounded(n, corpusLower, enumeratedMax));
  const invented = [...inventedNames, ...inventedEmails.map((e) => e), ...inventedNumbers];
  return {
    inventedNames,
    inventedEmails,
    inventedNumbers,
    inventedCount: inventedNames.length + inventedEmails.length + inventedNumbers.length,
    invented,
  };
}

// ── Roll-up ─────────────────────────────────────────────────────────────────────

const pct = (a, b) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);

/**
 * Roll a set of per-case results into the scorecard. Each result:
 *   { kind: 'canonical'|'hostile', toolOk: boolean, inventedCount: number, hostileOk?: boolean }
 * Bars (pre-registered, H4): invented total = 0; canonical correct-tool ≥ 90%;
 * hostile pass ≥ 90%.
 */
export function scorecard(results) {
  const canonical = results.filter((r) => r.kind === 'canonical');
  const hostile = results.filter((r) => r.kind === 'hostile');
  const inventedTotal = results.reduce((s, r) => s + (r.inventedCount ?? 0), 0);
  const toolOk = canonical.filter((r) => r.toolOk).length;
  const hostileOk = hostile.filter((r) => r.hostileOk).length;
  return {
    total: results.length,
    inventedTotal,
    correctToolRate: pct(toolOk, canonical.length),
    correctToolCount: toolOk,
    canonicalTotal: canonical.length,
    hostilePassRate: pct(hostileOk, hostile.length),
    hostilePassCount: hostileOk,
    hostileTotal: hostile.length,
  };
}

/** The pre-registered H4 verdict. Faithfulness is absolute; the rates are the guard-rails. */
export function verdictAgainstH4(s) {
  const pass =
    s.inventedTotal === 0 &&
    (s.correctToolRate ?? 0) >= 90 &&
    (s.hostilePassRate ?? 0) >= 90;
  return pass ? 'MEETS H4' : 'BELOW H4';
}
