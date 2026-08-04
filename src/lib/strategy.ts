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
  riskPerTradePct?: number;
}

const DEFAULT_CONFIG: StrategyConfig = {
  minScore: 90,
  minRiskReward: 10,
  maxRiskReward: 15,
  atrStopMultiple: 1.0,
  lookback: 180,
};

function ema(values: number[], period: number): number {
  if (!values.length) return 0;
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
  const slice = values.slice(-n);
  return slice.length ? Math.max(...slice) : 0;
}

function recentLow(values: number[], n: number): number {
  const slice = values.slice(-n);
  return slice.length ? Math.min(...slice) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Selective paper-trading model.
 *
 * This is intentionally a filter, not a prediction oracle. There is no
 * mathematically valid "100% sure" market trade. A 10R-15R target is only
 * accepted when the observed series itself provides enough projected room.
 */
export function evaluateStrategy(prices: number[], config: Partial<StrategyConfig> = {}): StrategySignal {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const clean = prices.filter((p) => Number.isFinite(p) && p > 0).slice(-cfg.lookback);
  const entry = clean[clean.length - 1] ?? 0;

  if (clean.length < 120 || entry <= 0) {
    return waitSignal(entry, ['Not enough history for selective confirmation']);
  }

  const ema10 = ema(clean, 10);
  const ema20 = ema(clean, 20);
  const ema50 = ema(clean, 50);
  const ema100 = ema(clean, 100);
  const atr = atrLike(clean, 20);
  const atrFast = atrLike(clean, 8);
  const volatility = atr / entry;
  const fast = clean.slice(-12);
  const medium = clean.slice(-30);
  const slope12 = slope(fast);
  const slopeNorm = slope12 / entry;
  const mediumMean = mean(medium);
  const mediumStd = std(medium);
  const z = mediumStd > 0 ? (entry - mediumMean) / mediumStd : 0;

  const prior = clean.slice(0, -1);
  const high12 = recentHigh(prior, 12);
  const low12 = recentLow(prior, 12);
  const high20 = recentHigh(prior, 20);
  const low20 = recentLow(prior, 20);
  const high50 = recentHigh(prior, 50);
  const low50 = recentLow(prior, 50);
  const range50 = high50 - low50;

  const compressionRatio = atr > 0 ? atrFast / atr : 1;
  const compressed = compressionRatio < 0.85;

  let longScore = 0;
  let shortScore = 0;
  const longReasons: string[] = [];
  const shortReasons: string[] = [];

  if (ema20 > ema50 && ema50 > ema100) {
    longScore += 25;
    longReasons.push('trend aligned bullish (20>50>100 EMA)');
  }
  if (ema20 < ema50 && ema50 < ema100) {
    shortScore += 25;
    shortReasons.push('trend aligned bearish (20<50<100 EMA)');
  }

  const momentumThreshold = Math.max(volatility * 0.08, 0.00015);
  if (slopeNorm > momentumThreshold) {
    longScore += 20;
    longReasons.push('positive momentum confirmed');
  }
  if (slopeNorm < -momentumThreshold) {
    shortScore += 20;
    shortReasons.push('negative momentum confirmed');
  }

  const longBreakout = entry > high20;
  const shortBreakdown = entry < low20;
  const longReclaim = entry > ema20 && fast.slice(0, 6).some((p) => p <= ema20) && entry > high12;
  const shortReclaim = entry < ema20 && fast.slice(0, 6).some((p) => p >= ema20) && entry < low12;

  if (longBreakout) {
    longScore += 20;
    longReasons.push('20-bar breakout');
  } else if (longReclaim) {
    longScore += 18;
    longReasons.push('EMA20 pullback/reclaim');
  }
  if (shortBreakdown) {
    shortScore += 20;
    shortReasons.push('20-bar breakdown');
  } else if (shortReclaim) {
    shortScore += 18;
    shortReasons.push('EMA20 pullback/reclaim');
  }

  if (entry > high50) {
    longScore += 15;
    longReasons.push('50-bar structure expansion');
  }
  if (entry < low50) {
    shortScore += 15;
    shortReasons.push('50-bar structure expansion');
  }

  if (volatility >= 0.0007 && volatility <= 0.018) {
    longScore += longScore > 0 ? 10 : 0;
    shortScore += shortScore > 0 ? 10 : 0;
    if (longScore > 0) longReasons.push('volatility regime acceptable');
    if (shortScore > 0) shortReasons.push('volatility regime acceptable');
  }

  if (compressed && (longBreakout || longReclaim)) {
    longScore += 10;
    longReasons.push('breakout followed volatility compression');
  }
  if (compressed && (shortBreakdown || shortReclaim)) {
    shortScore += 10;
    shortReasons.push('breakdown followed volatility compression');
  }

  if (z > 1.8) longScore -= 18;
  if (z < -1.8) shortScore -= 18;

  const side: Side = longScore >= shortScore ? 'LONG' : 'SHORT';
  const score = Math.max(longScore, shortScore);
  const reasons = side === 'LONG' ? longReasons : shortReasons;
  const structuralTrigger = side === 'LONG' ? (longBreakout || longReclaim) : (shortBreakdown || shortReclaim);

  if (score < cfg.minScore) {
    return waitSignal(entry, [`Score ${Math.max(0, Math.round(score))}/100 below ${cfg.minScore}`, ...reasons], score);
  }
  if (!structuralTrigger) {
    return waitSignal(entry, ['No breakout/reclaim trigger', ...reasons], score);
  }
  if (atr <= 0 || range50 <= 0) {
    return waitSignal(entry, ['Invalid volatility/structure measurement'], score);
  }

  const stopDistance = Math.max(atr * cfg.atrStopMultiple, entry * 0.0018);
  const stopLoss = side === 'LONG' ? entry - stopDistance : entry + stopDistance;

  const momentumProjection = Math.abs(slope12) * 72;
  const structureProjection = range50 * 1.15;
  const continuationProjection = Math.abs(ema10 - ema50) * 2.5;
  const projectedMove = Math.max(momentumProjection, structureProjection, continuationProjection);
  const projectedR = projectedMove / stopDistance;

  if (!Number.isFinite(projectedR) || projectedR < cfg.minRiskReward) {
    return waitSignal(entry, [
      `Score ${Math.round(score)}/100 passed`,
      `Defensible R ${Number.isFinite(projectedR) ? projectedR.toFixed(1) : '0.0'}x below ${cfg.minRiskReward}x minimum`,
      ...reasons,
    ], score);
  }

  const riskReward = clamp(projectedR, cfg.minRiskReward, cfg.maxRiskReward);
  const takeProfit = side === 'LONG'
    ? entry + stopDistance * riskReward
    : entry - stopDistance * riskReward;

  const strategy = reasons.some((r) => r.includes('breakout') || r.includes('breakdown'))
    ? 'Breakout + Trend Confluence v4'
    : 'Pullback + Trend Confluence v4';

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

function waitSignal(entry: number, reasons: string[], score = 0): StrategySignal {
  const normalizedScore = Math.round(clamp(score, 0, 100));
  return {
    action: 'WAIT',
    score: normalizedScore,
    confidence: normalizedScore,
    strategy: 'No Trade',
    entry,
    stopLoss: entry,
    takeProfit: entry,
    riskReward: 0,
    reasons,
  };
}
