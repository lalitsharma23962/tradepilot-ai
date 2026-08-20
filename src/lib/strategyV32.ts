import type { MarketBar } from './marketData';
import { atr, adx, ema } from './marketData';
import { TRADING_CONFIG } from './tradingConfig';

export const FINAL_TARGET_R = 10;

export const TARGET_LADDER = [
  { r: 3, fraction: 0.33, moveStopToBreakeven: true },
  { r: 5, fraction: 0.33, moveStopToBreakeven: false },
  { r: 10, fraction: 0.34, moveStopToBreakeven: false },
] as const;

export interface TargetLevel {
  r: number;
  fraction: number;
  price: number;
  moveStopToBreakeven: boolean;
}

export interface StrategyConfig {
  minScore: number;
  minRiskReward: number;
  maxRiskReward: number;
  riskReward: number;
  skipLegacyPathCapacity?: boolean;
  maxStructuralRiskAtr?: number;
  minStopAtr?: number;
  maxCostFractionOfRisk?: number;
  feeBps?: number;
  slippageBps?: number;
}

export interface StrategySignalV39 {
  action: 'LONG' | 'SHORT' | 'WAIT';
  family: string;
  strategy: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  score: number;
  targets: TargetLevel[];
  finalTargetR: number;
  reasons: string[];
}

export function wait(signal?: Partial<StrategySignalV39>, extraReasons: string[] = []): StrategySignalV39 {
  return {
    action: 'WAIT',
    family: signal?.family ?? 'none',
    strategy: signal?.strategy ?? 'None',
    entry: signal?.entry ?? 0,
    stopLoss: signal?.stopLoss ?? 0,
    takeProfit: signal?.takeProfit ?? 0,
    riskReward: 0,
    score: signal?.score ?? 0,
    targets: [],
    finalTargetR: 0,
    reasons: [...(signal?.reasons ?? []), ...extraReasons],
  };
}

export function normalize(val: number, min: number, max: number): number {
  if (max === min) return 0;
  return Math.min(1, Math.max(0, (val - min) / (max - min)));
}

export function evaluateV32(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 {
  const bars = (typeof input[0] === 'number' ? [] : (input as MarketBar[])).filter(b => Number.isFinite(b.close) && b.close > 0);
  if (bars.length < 50) return wait(undefined, ['Insufficient bars']);

  const last = bars.at(-1)!;
  const entry = last.close;
  const p = bars.map(b => b.close);
  const e20 = ema(p, 20);
  const e50 = ema(p, 50);
  const a14 = atr(bars, 14);

  const isLong = entry > e20 && e20 > e50;
  const isShort = entry < e20 && e20 < e50;

  if (!isLong && !isShort) return wait(undefined, ['No clear EMA alignment']);

  const side = isLong ? 1 : -1;
  const stopAtr = config.minStopAtr ?? TRADING_CONFIG.minStopAtr ?? 0.5;
  const stopLoss = entry - side * (a14 * stopAtr);
  const risk = Math.abs(entry - stopLoss);

  if (!(risk > 0) || !Number.isFinite(risk)) return wait(undefined, ['Invalid risk calculation']);

  const score = Math.round(75 + normalize(adx(bars, 14), 10, 40) * 20);

  const targets = TARGET_LADDER.map(level => ({
    r: level.r,
    fraction: level.fraction,
    price: entry + side * risk * level.r,
    moveStopToBreakeven: level.moveStopToBreakeven,
  }));

  return {
    action: isLong ? 'LONG' : 'SHORT',
    family: 'trend',
    strategy: 'Trend v32 Base',
    entry,
    stopLoss,
    takeProfit: entry + side * risk * FINAL_TARGET_R,
    riskReward: FINAL_TARGET_R,
    score,
    targets,
    finalTargetR: FINAL_TARGET_R,
    reasons: ['Base trend signal generated'],
  };
}
