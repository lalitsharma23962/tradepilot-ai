import { evaluateProductionStrategy as evaluateEntryStrategy, type StrategyConfig, type StrategySignal } from './strategyV32';
import type { MarketBar } from './marketData';

/**
 * v34 separates entry qualification from extreme reward research.
 * Entry/risk qualification uses the normal v32 1.5R-3R feasibility model.
 * 10R/15R is assigned only after a setup passes entry and risk quality.
 * The validation gate in backtestV11 remains unchanged.
 */
const RESEARCH_MIN_R = 10;
const RESEARCH_MAX_R = 15;
const ENTRY_MIN_R = 1.5;
const ENTRY_MAX_R = 3;
const ULTRA_SCORE = 99;

export function evaluateProductionStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignal {
  const entrySignal = evaluateEntryStrategy(input, {
    ...config,
    minRiskReward: ENTRY_MIN_R,
    maxRiskReward: ENTRY_MAX_R,
    riskReward: undefined,
  });

  if (entrySignal.action === 'WAIT') return entrySignal;

  const risk = Math.abs(entrySignal.entry - entrySignal.stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) {
    return { ...entrySignal, action: 'WAIT', strategy: 'No Trade', reasons: [...entrySignal.reasons, 'Invalid structural risk distance'] };
  }

  const targetR = entrySignal.score >= ULTRA_SCORE ? RESEARCH_MAX_R : RESEARCH_MIN_R;
  const takeProfit = entrySignal.action === 'LONG'
    ? entrySignal.entry + risk * targetR
    : entrySignal.entry - risk * targetR;

  return {
    ...entrySignal,
    strategy: 'Production Regime Breakout v34',
    takeProfit,
    riskReward: targetR,
    reasons: [
      ...entrySignal.reasons.filter(reason => !reason.startsWith('Target ')),
      'Entry quality and structural risk qualified independently',
      `Research target ${targetR}R assigned after entry qualification`,
    ],
  };
}

export function evaluateResearchStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignal {
  return evaluateProductionStrategy(input, config);
}

export function evaluateStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignal {
  return evaluateProductionStrategy(input, config);
}
