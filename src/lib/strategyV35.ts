import { evaluateProductionStrategy as evaluateEntryStrategy, type StrategyConfig, type StrategySignal } from './strategyV32';
export type { StrategyConfig, StrategySignal } from './strategyV32';
import type { MarketBar } from './marketData';
import { TRADING_CONFIG } from './tradingConfig';

/**
 * v35: qualify the entry with the proven v32 model first, then assign the
 * research target. v35 never weakens the entry gate just to manufacture a
 * 10R/15R trade, and never silently downgrades an infeasible target.
 */
const ENTRY_MIN_R = 1.5;
const ENTRY_MAX_R = 3;
const RESEARCH_MIN_R = TRADING_CONFIG.researchMinRiskReward;
const RESEARCH_MAX_R = TRADING_CONFIG.researchMaxRiskReward;

export function evaluateProductionStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {},
): StrategySignal {
  const minEntryScore = TRADING_CONFIG.minScore;
  const ultraScore = TRADING_CONFIG.ultraScore;

  const entrySignal = evaluateEntryStrategy(input, {
    ...config,
    minScore: Math.max(minEntryScore, config.minScore ?? minEntryScore),
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

  const targetR = entrySignal.score >= ultraScore ? RESEARCH_MAX_R : RESEARCH_MIN_R;
  const targetDistance = risk * targetR;
  const pathCapacity = entrySignal.pathCapacity;

  // v32's path-capacity metric is measured from the same OHLC/ATR context
  // used to qualify the entry. Because v35 changes the target after that
  // qualification, the new target must be checked again here.
  if (!Number.isFinite(pathCapacity) || targetDistance > pathCapacity) {
    if (config.funnel) {
      config.funnel.rejectedPathCapacity++;
      // v32 increments this bucket before v35 applies its second target
      // feasibility check. Undo that provisional count so the UI's
      // "signals opened" value represents actual v35-accepted signals.
      config.funnel.tradesOpened = Math.max(0, config.funnel.tradesOpened - 1);
    }
    return {
      ...entrySignal,
      action: 'WAIT',
      strategy: 'No Trade',
      takeProfit: entrySignal.entry,
      riskReward: 0,
      reasons: [
        ...entrySignal.reasons,
        `${targetR}R target (${targetDistance.toFixed(2)}) exceeds measured path capacity (${Number.isFinite(pathCapacity) ? pathCapacity.toFixed(2) : 'invalid'})`,
      ],
    };
  }

  const takeProfit = entrySignal.action === 'LONG'
    ? entrySignal.entry + targetDistance
    : entrySignal.entry - targetDistance;

  return {
    ...entrySignal,
    strategy: 'Production Regime Breakout v35',
    takeProfit,
    riskReward: targetR,
    reasons: [
      ...entrySignal.reasons.filter(reason => !reason.startsWith('Target ')),
      'A+ entry qualified independently from extreme-R research target',
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
