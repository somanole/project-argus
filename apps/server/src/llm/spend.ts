import type { TokenUsage } from './types.js';

/**
 * The spend meter. The HARD control is a per-run TOKEN cap — tokens are measured, so
 * the cap is deterministic and provider-agnostic (never a fabricated number, rule 5).
 * A USD figure is also produced for the E-economics report, but it is an ESTIMATE from
 * a published-price table and is labelled as such; when a model's price is unknown the
 * estimate is null (we don't guess a dollar figure).
 */

// Published-price ESTIMATES, USD per 1M tokens. Confirm/refresh at the E-economics
// slice (S6.2); these drive only the reported estimate, never the hard cap.
const PRICING_USD_PER_1M: Record<string, { input: number; output: number }> = {
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

export interface SpendSnapshot {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated cost in USD, or null when the model's price isn't known. */
  estimatedUsd: number | null;
}

export class SpendMeter {
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(private readonly model: string) {}

  add(usage: TokenUsage): void {
    this.calls++;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  /** True once this run has consumed its token budget (0/undefined cap = unlimited). */
  capReached(maxTokens: number | undefined): boolean {
    return maxTokens != null && maxTokens > 0 && this.totalTokens() >= maxTokens;
  }

  snapshot(): SpendSnapshot {
    const price = PRICING_USD_PER_1M[this.model];
    const estimatedUsd = price
      ? Number(((this.inputTokens / 1e6) * price.input + (this.outputTokens / 1e6) * price.output).toFixed(4))
      : null;
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens(),
      estimatedUsd,
    };
  }
}
