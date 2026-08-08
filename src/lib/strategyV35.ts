import { evaluateProductionStrategy as evaluateEntryStrategy, type StrategyConfig, type StrategySignal } from './strategyV32';
export type { StrategyConfig, StrategySignal } from './strategyV32';
import type { MarketBar } from './marketData';

/**
 * v35: high-conviction entry qualification followed by extreme-R research
 * targets. The validation gate remains unchanged.
 *
 * v35 deliberately does NOT invent a second stop model. Entry qualification,
 * structural-stop construction, and path-capacity measurement remain the
 * proven v32 model. The only research-layer change is the target assigned
 * after an already-qualified entry: 10R by default and 15R for ultra-score
 * entries. A target is never downgraded when it is infeasible.
 */
const ENTRY_MIN_R = 1.5;
const ENTRY_MAX_R = 3;
const MIN_ENTRY_SCORE = 94;
const ULTRA_SCORE = 94;
const RESEARCH_MIN_R = 10;
const RESEARCH_MAX_R = 15;

export function evaluateProductionStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {},
): StrategySignal {
  // Keep v32's original structural-risk geometry intact. v35 is a target
  // research layer, not a replacement stop model.
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
  const targetDistance = risk * targetR;

  // Hard feasibility veto: a 10R/15R target must be supported by the same
  // historical path-capacity measurement used by v32. Never substitute a
  // smaller target just to create a trade.
  if (targetDistance > entrySignal.pathCapacity) {
    return {
      ...entrySignal,
      action: 'WAIT',
      strategy: 'No Trade',
      takeProfit: entrySignal.entry,
      riskReward: 0,
      reasons: [
        ...entrySignal.reasons,
        `${targetR}R target (${targetDistance.toFixed(2)}) exceeds measured path capacity (${entrySignal.pathCapacity.toFixed(2)})`,
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
