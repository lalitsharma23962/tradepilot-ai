import type { MarketBar } from './marketData';

export interface StrategyConfig { atrPeriod?: number; atrMultStop?: number; atrMultTp?: number; minRiskReward?: number; }
export interface TargetLadderStep { r: number; fraction: number; price: number; moveStopToBreakeven: boolean; }
export interface StrategySignalV39 { action: 'LONG' | 'SHORT' | 'WAIT'; family: string; strategy: string; entry: number; stopLoss: number; takeProfit: number; riskReward: number; score: number; targets: TargetLadderStep[]; finalTargetR: number; reasons: string[]; }

export function evaluateV39(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 {
  const atrPeriod = config.atrPeriod ?? 14;
  const atrMultStop = config.atrMultStop ?? 1.5;
  const minRR = config.minRiskReward ?? 2.0;
  let bars: MarketBar[] = [];
  if (Array.isArray(input) && input.length > 0) {
    if (typeof input[0] === 'number') bars = (input as number[]).map((val) => ({ openTime: 0, open: val, high: val, low: val, close: val, volume: 0 }));
    else bars = input as MarketBar[];
  }
  if (bars.length <= atrPeriod) return { action: 'WAIT', family: 'TrendFollow', strategy: 'V39_ATR_Breakout', entry: 0, stopLoss: 0, takeProfit: 0, riskReward: 0, score: 0, targets: [], finalTargetR: 0, reasons: ['Insufficient historical data for ATR calculation'] };
  const trValues: number[] = [];
  for (let i = 1; i < bars.length; i++) { const c = bars[i], p = bars[i - 1]; trValues.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))); }
  const atr = trValues.slice(-atrPeriod).reduce((sum, val) => sum + val, 0) / atrPeriod;
  const lastBar = bars[bars.length - 1], prevBar = bars[bars.length - 2], entry = lastBar.close;
  const smaPeriod = Math.min(20, bars.length);
  const sma = bars.slice(-smaPeriod).reduce((sum, b) => sum + b.close, 0) / smaPeriod;
  let action: 'LONG' | 'SHORT' | 'WAIT' = 'WAIT';
  const reasons: string[] = [];
  if (lastBar.close > sma && lastBar.close > prevBar.high) { action = 'LONG'; reasons.push('Price closed above SMA and previous bar high'); }
  else if (lastBar.close < sma && lastBar.close < prevBar.low) { action = 'SHORT'; reasons.push('Price closed below SMA and previous bar low'); }
  else reasons.push('Price consolidating within range');
  if (action === 'WAIT' || atr === 0) return { action: 'WAIT', family: 'TrendFollow', strategy: 'V39_ATR_Breakout', entry, stopLoss: 0, takeProfit: 0, riskReward: 0, score: 0, targets: [], finalTargetR: 0, reasons };
  const stopDistance = atr * atrMultStop;
  const tpDistance = stopDistance * 2;
  const stopLoss = action === 'LONG' ? entry - stopDistance : entry + stopDistance;
  const takeProfit = action === 'LONG' ? entry + tpDistance : entry - tpDistance;
  const riskReward = 2;
  if (riskReward < minRR) return { action: 'WAIT', family: 'TrendFollow', strategy: 'V39_ATR_Breakout', entry, stopLoss, takeProfit, riskReward, score: 0, targets: [], finalTargetR: 0, reasons: ['Risk to Reward ratio below threshold'] };
  return { action, family: 'TrendFollow', strategy: 'V39_ATR_Breakout', entry, stopLoss, takeProfit, riskReward, score: 80, targets: [{ r: 2, fraction: 1, price: takeProfit, moveStopToBreakeven: false }], finalTargetR: 2, reasons };
}
export function evaluateProductionStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 { return evaluateV39(input, config); }
export function evaluateResearchStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 { return evaluateProductionStrategy(input, config); }
export function evaluateStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 { return evaluateProductionStrategy(input, config); }
