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
  minScore: 88,
  minRiskReward: 10,
  maxRiskReward: 15,
  atrStopMultiple: 1.0,
  lookback: 160,
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
 * Selective paper-trading setup.
 *
 * Important: this deliberately does NOT claim that any trade is "100% sure".
 * It only enters when the available simulated price history supports a very
 * strong confluence and a mathematically defensible 10R-15R target.
 */
export function evaluateStrategy(prices: number[], config: Partial<StrategyConfig> = {}): StrategySignal {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const clean = prices.filter((p) => Number.isFinite(p) && p > 0).slice(-cfg.lookback);
  const entry = clean[clean.length - 1] ?? 0;

  if (clean.length < 100 || entry <= 0) {
    return waitSignal(entry, ['Not enough market history for the selective model']);
  }

  const ema20 = ema(clean, 20);
  const ema50 = ema(clean, 50);
  const ema100 = ema(clean, 100);
  const fast = clean.slice(-12);
  const medium = clean.slice(-30);
  const atr = atrLike(clean, 20);
  const volatility = atr / entry;
  const slope12 = slope(fast);
  const slopeNorm = slope12 / entry;

  const prior = clean.slice(0, -1);
  const high20 = recentHigh(prior, 20);
  const low20 = recentLow(prior, 20);
  const high50 = recentHigh(prior, 50);
  const low50 = recentLow(prior, 50);
  const range50 = high50 - low50;
  const z = std(medium) > 0 ? (entry - mean(medium)) / std(medium) : 0;

  let longScore = 0;
  let shortScore = 0;
  const longReasons: string[] = [];
  const shortReasons: string[] = [];

  // 100-point model: trend 30 + momentum 20 + breakout 20 + structure 15 + volatility 15.
  if (ema20 > ema50 && ema50 > ema100) {
    longScore += 30;
    longReasons.push('EMA20 > EMA50 > EMA100');
  }
  if (ema20 < ema50 && ema50 < ema100) {
    shortScore += 30;
    shortReasons.push('EMA20 < EMA50 < EMA100');
  }

  // Normalize momentum by price. Do not multiply slope by entry again: that
  // was a dimensional error in v2 and could manufacture unrealistic R values.
  if (slopeNorm > volatility * 0.10) {
    longScore += 20;
    longReasons.push('momentum materially positive vs volatility');
  }
  if (slopeNorm < -volatility * 0.10) {
    shortScore += 20;
    shortReasons.push('momentum materially negative vs volatility');
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
    longScore += 15;
    longReasons.push('50-bar structure breakout');
  }
  if (entry < low50) {
    shortScore += 15;
    shortReasons.push('50-bar structure breakdown');
  }

  if (volatility >= 0.0007 && volatility <= 0.03) {
    if (longScore > 0) {
      longScore += 15;
      longReasons.push('volatility regime acceptable');
    }
    if (shortScore > 0) {
      shortScore += 15;
      shortReasons.push('volatility regime acceptable');
    }
  }

  // Do not chase a statistically stretched move.
  if (z > 2.0) longScore -= 15;
  if (z < -2.0) shortScore -= 15;

  const side: Side = longScore >= shortScore ? 'LONG' : 'SHORT';
  const score = Math.max(longScore, shortScore);
  const reasons = side === 'LONG' ? longReasons : shortReasons;

  if (score < cfg.minScore) {
    return waitSignal(entry, [`Score ${Math.max(0, Math.round(score))}/100 below ${cfg.minScore}`, ...reasons]);
  }

  if (atr <= 0 || range50 <= 0) {
    return waitSignal(entry, ['Invalid volatility/structure measurement']);
  }

  // Risk is volatility-based. The target is NOT fabricated by multiplying
  // slope by entry. It is estimated from actual price displacement.
  const stopDistance = Math.max(atr * cfg.atrStopMultiple, entry * 0.0025);
  const stopLoss = side === 'LONG' ? entry - stopDistance : entry + stopDistance;

  // 60-bar continuation estimate from observed price-per-bar momentum.
  const momentumProjection = Math.abs(slope12) * 60;
  const structureProjection = range50 * 1.25;
  const projectedMove = Math.max(momentumProjection, structureProjection);
  const projectedR = projectedMove / stopDistance;

  // Strict 10R floor: if the market history cannot plausibly support it,
  // WAIT rather than manufacture a 10R target just to satisfy the setting.
  if (!Number.isFinite(projectedR) || projectedR < cfg.minRiskReward) {
    return waitSignal(entry, [
      `Score ${Math.round(score)}/100 passed`,
      `Defensible R ${Number.isFinite(projectedR) ? projectedR.toFixed(1) : '0.0'}x below ${cfg.minRiskReward}x minimum`,
      ...reasons,
    ]);
  }

  const riskReward = clamp(projectedR, cfg.minRiskReward, cfg.maxRiskReward);
  const takeProfit = side === 'LONG'
    ? entry + stopDistance * riskReward
    : entry - stopDistance * riskReward;

  const strategy = reasons.some((r) => r.includes('breakout') || r.includes('breakdown'))
    ? 'Breakout Confluence v3'
    : 'Trend Momentum Confluence v3';

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
