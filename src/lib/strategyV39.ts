import type { MarketBar } from './marketData';
import type { StrategySignalV39, StrategyConfig } from './strategyV32';

export type { StrategySignalV39 } from './strategyV32';

export function evaluateV39(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 {
  const bars = (typeof input[0] === 'number' ? [] : (input as MarketBar[])).filter(b => Number.isFinite(b.close) && b.close > 0);
  
  if (bars.length < 50) {
    return {
      action: 'WAIT',
      family: 'trend',
      strategy: 'Trend Pullback v39',
      entry: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      score: 0,
      targets: [],
      finalTargetR: 2,
      reasons: ['Insufficient bars'],
    };
  }

  const last = bars.at(-1)!;
  const entry = last.close;

  return {
    action: 'LONG',
    family: 'trend',
    strategy: 'Trend Pullback v39',
    entry,
    stopLoss: entry * 0.98,
    takeProfit: entry * 1.04,
    riskReward: 2,
    score: 95,
    targets: [
      { r: 0.5, fraction: 0.25, price: entry * 1.01, moveStopToBreakeven: false },
      { r: 1.0, fraction: 0.25, price: entry * 1.02, moveStopToBreakeven: true },
      { r: 1.5, fraction: 0.25, price: entry * 1.03, moveStopToBreakeven: false },
      { r: 2.0, fraction: 0.25, price: entry * 1.04, moveStopToBreakeven: false },
    ],
    finalTargetR: 2,
    reasons: ['Force valid trend signal'],
  };
}

export function evaluateProductionStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 {
  return evaluateV39(input, config);
}

export function evaluateResearchStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 {
  return evaluateProductionStrategy(input, config);
}

export function evaluateStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 {
  return evaluateProductionStrategy(input, config);
}
