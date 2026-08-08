import { evaluateProductionStrategy as evaluateEntryStrategy, type StrategyConfig, type StrategySignal } from './strategyV32';
export type { StrategyConfig, StrategySignal } from './strategyV32';
import type { MarketBar } from './marketData';

/**
 * v35: high-conviction entry qualification followed by extreme-R research
 * targets. The validation gate remains unchanged.
 *
 * The important correction here is risk geometry: a 10R/15R target is only
 * useful if the structural stop is tight enough that the target is reachable
 * without turning every signal into a multi-ATR gamble. v32's generic risk
 * floor was designed for 1.5R-3R production targets, so v35 uses a tighter,
 * setup-local structural stop configuration while keeping the v32 entry
 * qualification itself intact.
 */
const ENTRY_MIN_R = 1.5;
const ENTRY_MAX_R = 3;
const MIN_ENTRY_SCORE = 96;
const ULTRA_SCORE = 99;
const RESEARCH_MIN_R = 10;
const RESEARCH_MAX_R = 15;

// Extreme-R research needs tighter geometry than the ordinary v32 target.
// These are strategy parameters, not validation-gate changes.
const EXTREME_ATR_STOP_MULTIPLE = 1.0;
const EXTREME_MAX_STRUCTURAL_RISK_ATR = 1.05;
const EXTREME_SWING_LOOKBACK = 3;

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
    atrStopMultiple: EXTREME_ATR_STOP_MULTIPLE,
    maxStructuralRiskAtr: Math.min(
      EXTREME_MAX_STRUCTURAL_RISK_ATR,
      config.maxStructuralRiskAtr ?? EXTREME_MAX_STRUCTURAL_RISK_ATR,
    ),
    swingLookback: Math.min(
      EXTREME_SWING_LOOKBACK,
      config.swingLookback ?? EXTREME_SWING_LOOKBACK,
    ),
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

  // The target must still be supported by the same historical path-capacity
  // measurement used by the base strategy. This is a feasibility veto, not a
  // way to downgrade 10R/15R into a smaller reward target.
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
      'A+ entry qualified independently from extreme-RR research target',
      `Extreme-R target geometry uses ${EXTREME_SWING_LOOKBACK}-bar structural stop`,
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
