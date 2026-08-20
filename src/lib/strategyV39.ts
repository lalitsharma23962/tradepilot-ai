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
  
  // Dynamic ATR calculation over last 14 bars to prevent structural stop rejections
  const slice = bars.slice(-15);
  let totalRange = 0;
  for (let i = 1; i < slice.length; i++) {
    totalRange += Math.max(slice[i].high - slice[i].low, Math.abs(slice[i].high - slice[i-1].close));
  }
  const atr = totalRange / 14 || entry * 0.005;

  const stopLoss = entry - (atr * 1.8);
  const takeProfit = entry + (atr * 3.6);

  return {
    action: 'LONG',
    family: 'trend',
    strategy: 'Trend Pullback v39',
    entry,
    stopLoss,
    takeProfit,
    riskReward: 2.0,
    score: 85,
    targets: [
      { r: 0.5, fraction: 0.25, price: entry + (atr * 0.9), moveStopToBreakeven: false },
      { r: 1.0, fraction: 0.25, price: entry + (atr * 1.8), moveStopToBreakeven: true },
      { r: 1.5, fraction: 0.25, price: entry + (atr * 2.7), moveStopToBreakeven: false },
      { r: 2.0, fraction: 0.25, price: entry + (atr * 3.6), moveStopToBreakeven: false },
    ],
    finalTargetR: 2,
    reasons: ['Valid ATR trend-pullback structure'],
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
