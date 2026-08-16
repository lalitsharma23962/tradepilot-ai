import type { MarketBar } from './marketData';
import type { StrategyConfig, StrategySignal } from './strategyV32';
import { evaluateProductionStrategy as evaluateV32 } from './strategyV32';
import { FINAL_TARGET_R, TARGET_LADDER } from './targetLadder';
import { TRADING_CONFIG } from './tradingConfig';

/**
 * v39: quality-first trend-pullback production selector.
 *
 * The v38 production selector opened too many low-quality breakout signals
 * (the observed validation run was PF 0.21 / -38% return).  v39 deliberately
 * stops treating every candidate family as equally eligible.  It uses the
 * more selective v32 directional/retest logic and only permits trend signals
 * into the production execution path. Validation gates remain authoritative.
 */
export type StrategySignalV39 = StrategySignal & {
  targets?: Array<{ r:number; fraction:number; price:number; moveStopToBreakeven?:boolean }>;
  finalTargetR?: number;
};

function normalize(signal: StrategySignal): StrategySignalV39 {
  if (signal.action === 'WAIT') return signal;
  const side = signal.action === 'LONG' ? 1 : -1;
  const risk = Math.abs(signal.entry - signal.stopLoss);
  if (!(risk > 0) || !Number.isFinite(risk)) return signal;
  const targets = TARGET_LADDER.map(level => ({
    r: level.r,
    fraction: level.fraction,
    price: signal.entry + side * risk * level.r,
    moveStopToBreakeven: level.moveStopToBreakeven,
  }));
  return {
    ...signal,
    strategy: 'Trend Pullback v39',
    takeProfit: signal.entry + side * risk * FINAL_TARGET_R,
    riskReward: FINAL_TARGET_R,
    targets,
    finalTargetR: FINAL_TARGET_R,
    reasons: [
      ...signal.reasons,
      'v39 production selector: trend/retest family only',
      'Fixed 1:2 final target with 1R / 1.5R / 2R execution ladder',
      'Validation remains the profitability gate; no threshold bypass',
    ],
  };
}

function toBars(input: number[] | MarketBar[]): MarketBar[] {
  if (!input.length) return [];
  if (typeof input[0] === 'number') {
    return (input as number[]).map((close, i) => ({ openTime:i, open:close, high:close, low:close, close, volume:0 }));
  }
  return input as MarketBar[];
}

export function evaluateProductionStrategy(input:number[]|MarketBar[], config:Partial<StrategyConfig>={}):StrategySignalV39 {
  const cfg = {
    ...config,
    // Keep the repository's strict validation threshold, but do not permit
    // the low-score default to create production entries.
    minScore: Math.max(TRADING_CONFIG.minScore, config.minScore ?? TRADING_CONFIG.minScore),
    minRiskReward: FINAL_TARGET_R,
    maxRiskReward: FINAL_TARGET_R,
    riskReward: FINAL_TARGET_R,
  };
  const signal = evaluateV32(input, cfg);
  if (signal.action === 'WAIT') return signal;

  // v32 can produce several research families.  Production v39 intentionally
  // accepts only the trend family, which is the strongest family in the latest
  // observed validation evidence and avoids the over-trading breakout path.
  if (signal.family !== 'trend') {
    return {
      ...signal,
      action: 'WAIT',
      strategy: 'No Trade',
      entry: signal.entry,
      stopLoss: signal.entry,
      takeProfit: signal.entry,
      riskReward: 0,
      family: 'none',
      pathCapacity: signal.pathCapacity,
      reasons: [...signal.reasons, 'v39 rejected non-trend production family'],
    };
  }

  return normalize(signal);
}

export function evaluateResearchStrategy(input:number[]|MarketBar[], config:Partial<StrategyConfig>={}):StrategySignalV39 {
  return evaluateProductionStrategy(input, config);
}

export function evaluateStrategy(input:number[]|MarketBar[], config:Partial<StrategyConfig>={}):StrategySignalV39 {
  return evaluateProductionStrategy(input, config);
}
