import { evaluateProductionStrategy as evaluateEntryStrategy, type StrategyConfig, type StrategySignal } from './strategyV32';
import type { MarketBar } from './marketData';

/**
 * v35 fixes the v34 routing mistake: entry qualification comes from the
 * actual v32 implementation, not the v33 replacement that added extreme-RR
 * feasibility vetoes to entry selection.
 *
 * Entry quality is evaluated at 1.5R-3R. Only after that qualification does
 * v35 assign the research/production target of 10R or 15R. The validation
 * gate itself remains unchanged.
 */
const ENTRY_MIN_R = 1.5;
const ENTRY_MAX_R = 3;
const MIN_ENTRY_SCORE = 96;
const ULTRA_SCORE = 99;
const RESEARCH_MIN_R = 10;
const RESEARCH_MAX_R = 15;

export function evaluateProductionStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {},
): StrategySignal {
  const entrySignal = evaluateEntryStrategy(input, {
    ...config,
    minScore: Math.max(MIN_ENTRY_SCORE, config.minScore ?? MIN_ENTRY_SCORE),
    minRiskReward: ENTRY_MIN_R,
    maxRiskReward: ENTRY_MAX_R,
    riskReward: undefined,
  });

  if (entrySignal.action === 'WAIT') return entrySignal;

  const risk = Math.abs(entrySignal.entry - entrySignal.stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) {
    return {
      ...entrySignal,
      action: 'WAIT',
      strategy: 'No Trade',
      reasons: [...entrySignal.reasons, 'Invalid structural risk distance'],
    };
  }

  const targetR = entrySignal.score >= ULTRA_SCORE ? RESEARCH_MAX_R : RESEARCH_MIN_R;
  const takeProfit = entrySignal.action === 'LONG'
    ? entrySignal.entry + risk * targetR
    : entrySignal.entry - risk * targetR;

  return {
    ...entrySignal,
    strategy: 'Production Regime Breakout v35',
    takeProfit,
    riskReward: targetR,
    reasons: [
      ...entrySignal.reasons.filter(reason => !reason.startsWith('Target ')),
      'A+ entry qualified independently from extreme-RR research target',
      `Research target ${targetR}R assigned after entry qualification`,
    ],
  };
}

export function evaluateResearchStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {},
): StrategySignal {
  return evaluateProductionStrategy(input, config);
}

export function evaluateStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {},
): StrategySignal {
  return evaluateProductionStrategy(input, config);
}
