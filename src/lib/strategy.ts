import type { Side } from './types';

export interface StrategySignal {
  action: Side | 'WAIT';
  score: number;
  confidence: number;
  strategy: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  reasons: string[];
}

export interface StrategyConfig {
  minScore: number;
  minRiskReward: number;
  maxRiskReward: number;
  atrStopMultiple: number;
  lookback: number;
}

const DEFAULT_CONFIG: StrategyConfig = {
  minScore: 82,
  minRiskReward: 10,
  maxRiskReward: 15,
  atrStopMultiple: 1.6,
  lookback: 120,
};

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) result = values[i] * k + result * (1 - k);
  return result;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function atrLike(values: number[], period = 20): number {
  if (values.length < 2) return 0;
  const slice = values.slice(-(period + 1));
  const ranges: number[] = [];
  for (let i = 1; i < slice.length; i++) ranges.push(Math.abs(slice[i] - slice[i - 1]));
  return mean(ranges);
}

function slope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (values[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

function recentHigh(values: number[], n: number): number {
  return Math.max(...values.slice(-n));
}

function recentLow(values: number[], n: number): number {
  return Math.min(...values.slice(-n));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function evaluateStrategy(
  prices: number[],
  config: Partial<StrategyConfig> = {},
): StrategySignal {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const clean = prices.filter((p) => Number.isFinite(p) && p > 0).slice(-cfg.lookback);
  const entry = clean[clean.length - 1] ?? 0;

  if (clean.length < 60 || entry <= 0) {
    return waitSignal(entry, ['Not enough market history']);
  }

  const ema20 = ema(clean, 20);
  const ema50 = ema(clean, 50);
  const ema100 = ema(clean, 100);
  const fast = clean.slice(-12);
  const medium = clean.slice(-30);
  const atr = atrLike(clean, 20);
  const volatility = atr / entry;
  const slope20 = slope(fast) / entry;
  const high20 = recentHigh(clean.slice(0, -1), 20);
  const low20 = recentLow(clean.slice(0, -1), 20);
  const high50 = recentHigh(clean.slice(0, -1), 50);
  const low50 = recentLow(clean.slice(0, -1), 50);
  const z = std(medium) > 0 ? (entry - mean(medium)) / std(medium) : 0;

  let longScore = 0;
  let shortScore = 0;
  const longReasons: string[] = [];
  const shortReasons: string[] = [];

  if (ema20 > ema50 && ema50 > ema100) {
    longScore += 25;
    longReasons.push('EMA trend aligned bullish');
  }
  if (ema20 < ema50 && ema50 < ema100) {
    shortScore += 25;
    shortReasons.push('EMA trend aligned bearish');
  }

  if (slope20 > volatility * 0.08) {
    longScore += 15;
    longReasons.push('short-term momentum positive');
  }
  if (slope20 < -volatility * 0.08) {
    shortScore += 15;
    shortReasons.push('short-term momentum negative');
  }

  if (entry > high20) {
    longScore += 20;
    longReasons.push('20-bar breakout');
  }
  if (entry < low20) {
    shortScore += 20;
    shortReasons.push('20-bar breakdown');
  }

  if (entry > high50) {
    longScore += 10;
    longReasons.push('50-bar structure breakout');
  }
  if (entry < low50) {
    shortScore += 10;
    shortReasons.push('50-bar structure breakdown');
  }

  // Avoid buying an extended upside move or shorting an extended downside move.
  if (z > 1.8) longScore -= 12;
  if (z < -1.8) shortScore -= 12;

  // A tiny volatility regime is not suitable for a high-R target.
  if (volatility < 0.0007) {
    longScore -= 15;
    shortScore -= 15;
  } else {
    if (longScore > 0) longScore += 5;
    if (shortScore > 0) shortScore += 5;
  }

  const side: Side = longScore >= shortScore ? 'LONG' : 'SHORT';
  const score = Math.max(longScore, shortScore);
  const reasons = side === 'LONG' ? longReasons : shortReasons;

  if (score < cfg.minScore) {
    return waitSignal(entry, [`Score ${Math.max(0, Math.round(score))}/100 below ${cfg.minScore}`, ...reasons]);
  }

  const stopDistance = Math.max(atr * cfg.atrStopMultiple, entry * 0.0025);
  const stopLoss = side === 'LONG' ? entry - stopDistance : entry + stopDistance;
  const structuralTargetDistance = side === 'LONG'
    ? Math.max(high50 - entry, atr * 8)
    : Math.max(entry - low50, atr * 8);

  // The engine only accepts a trade when a large asymmetric move is plausible.
  const projectedR = structuralTargetDistance / stopDistance;
  const riskReward = clamp(projectedR, cfg.minRiskReward, cfg.maxRiskReward);
  if (projectedR < cfg.minRiskReward) {
    return waitSignal(entry, [
      `Score ${Math.round(score)}/100 passed`,
      `Projected R ${projectedR.toFixed(1)}x is below ${cfg.minRiskReward}x minimum`,
      ...reasons,
    ]);
  }

  const takeProfit = side === 'LONG'
    ? entry + stopDistance * riskReward
    : entry - stopDistance * riskReward;

  const strategy = longReasons.some((r) => r.includes('breakout')) || shortReasons.some((r) => r.includes('breakdown'))
    ? 'Breakout Confluence'
    : 'Trend Momentum Confluence';

  return {
    action: side,
    score: Math.round(clamp(score, 0, 100)),
    confidence: Math.round(clamp(score, 0, 100)),
    strategy,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    reasons,
  };
}

function waitSignal(entry: number, reasons: string[]): StrategySignal {
  return {
    action: 'WAIT',
    score: 0,
    confidence: 0,
    strategy: 'No Trade',
    entry,
    stopLoss: entry,
    takeProfit: entry,
    riskReward: 0,
    reasons,
  };
}
