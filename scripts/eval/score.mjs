// Enrichment eval scoring (H1). Pure functions, no I/O — the same bar for both
// providers (provider-parameterized, one target). See EXPERIMENT.md.

const RANK = { critical: 3, high: 2, medium: 1, low: 0 };

/** Criticality is "within one level" when the ordinal distance is ≤ 1. */
export function criticalityWithinOne(expected, actual) {
  if (actual == null || !(actual in RANK) || !(expected in RANK)) return false;
  return Math.abs(RANK[expected] - RANK[actual]) <= 1;
}

/**
 * Score a set of results. Each result: { expected:{category,criticality,riskFlags},
 * output:{category,criticality,riskFlags}|null }. A null output = stub/parse-fail.
 * Micro-averaged risk-flag P/R across analyzed cases.
 */
export function score(results) {
  const total = results.length;
  const analyzed = results.filter((r) => r.output != null);
  const n = analyzed.length;

  let categoryHits = 0;
  let critWithin1 = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const r of analyzed) {
    if (r.output.category === r.expected.category) categoryHits++;
    if (criticalityWithinOne(r.expected.criticality, r.output.criticality)) critWithin1++;
    const predicted = new Set(r.output.riskFlags ?? []);
    const expected = new Set(r.expected.riskFlags ?? []);
    for (const f of predicted) {
      if (expected.has(f)) tp++;
      else fp++;
    }
    for (const f of expected) if (!predicted.has(f)) fn++;
  }

  const pct = (a, b) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
  return {
    total,
    analyzed: n,
    schemaParseRate: pct(n, total),
    categoryAccuracy: pct(categoryHits, n),
    criticalityWithinOne: pct(critWithin1, n),
    riskFlagPrecision: pct(tp, tp + fp),
    riskFlagRecall: pct(tp, tp + fn),
  };
}

/** Compare against the pre-registered H1 bar (EXPERIMENT.md). */
export function verdictAgainstH1(s) {
  const pass =
    (s.categoryAccuracy ?? 0) >= 85 &&
    (s.criticalityWithinOne ?? 0) >= 90 &&
    (s.riskFlagPrecision ?? 0) >= 95 &&
    (s.riskFlagRecall ?? 0) >= 80;
  return pass ? 'MEETS H1' : 'BELOW H1';
}
