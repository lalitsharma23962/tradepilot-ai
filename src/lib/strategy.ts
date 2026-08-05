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
  strategyLimit?: number;
}

const DEFAULT_CONFIG: StrategyConfig = { minScore: 85, minRiskReward: 1.8, maxRiskReward: 3.2, atrStopMultiple: 1.15, lookback: 180, strategyLimit: 10 };

// Ten bounded strategy profiles. They share the same risk engine but emphasize
// different price regimes; max_strategies is a hard ceiling on how many are evaluated.
const PROFILES = [
  { name: 'Trend Breakout', trend: 28, momentum: 20, trigger: 24, volatility: 10, extensionPenalty: 20 },
  { name: 'Trend Pullback', trend: 30, momentum: 16, trigger: 22, volatility: 8, extensionPenalty: 16 },
  { name: 'Momentum Continuation', trend: 22, momentum: 28, trigger: 18, volatility: 10, extensionPenalty: 18 },
  { name: 'Volatility Expansion', trend: 20, momentum: 18, trigger: 24, volatility: 16, extensionPenalty: 16 },
  { name: 'EMA Reclaim', trend: 26, momentum: 18, trigger: 24, volatility: 8, extensionPenalty: 18 },
  { name: 'Range Break', trend: 20, momentum: 18, trigger: 28, volatility: 12, extensionPenalty: 20 },
  { name: 'Compression Break', trend: 20, momentum: 20, trigger: 24, volatility: 16, extensionPenalty: 18 },
  { name: 'Structure Continuation', trend: 30, momentum: 22, trigger: 20, volatility: 8, extensionPenalty: 20 },
  { name: 'Adaptive Trend', trend: 24, momentum: 22, trigger: 22, volatility: 12, extensionPenalty: 18 },
  { name: 'Defensive Momentum', trend: 28, momentum: 24, trigger: 18, volatility: 6, extensionPenalty: 22 },
] as const;

function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i++) out = values[i] * k + out * (1 - k);
  return out;
}
function mean(values: number[]): number { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function std(values: number[]): number { const m = mean(values); return values.length > 1 ? Math.sqrt(mean(values.map((v) => (v - m) ** 2))) : 0; }
function atrLike(values: number[], period = 20): number { const s = values.slice(-(period + 1)); return s.length > 1 ? mean(s.slice(1).map((v, i) => Math.abs(v - s[i]))) : 0; }
function slope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length, xm = (n - 1) / 2, ym = mean(values);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) { a += (i - xm) * (values[i] - ym); b += (i - xm) ** 2; }
  return b ? a / b : 0;
}
function rsi(values: number[], period = 14): number {
  if (values.length <= period) return 50;
  let gain = 0, loss = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i++) { const d = values[i] - values[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}
function high(values: number[], n: number): number { return Math.max(...values.slice(-n)); }
function low(values: number[], n: number): number { return Math.min(...values.slice(-n)); }
function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)); }

function scoreProfile(prices: number[], cfg: StrategyConfig, profile: typeof PROFILES[number]): StrategySignal {
  const clean = prices.filter((p) => Number.isFinite(p) && p > 0).slice(-cfg.lookback);
  const entry = clean.at(-1) ?? 0;
  if (clean.length < 120 || entry <= 0) return waitSignal(entry, ['Not enough history']);

  const e20 = ema(clean, 20), e50 = ema(clean, 50), e100 = ema(clean, 100);
  const atr = atrLike(clean, 20), atrFast = atrLike(clean, 8);
  const vol = atr / entry;
  const mom = slope(clean.slice(-12)) / entry;
  const momentumThreshold = Math.max(vol * 0.06, 0.00012);
  const currentRsi = rsi(clean, 14);
  const prior = clean.slice(0, -1);
  const h12 = high(prior, 12), l12 = low(prior, 12), h20 = high(prior, 20), l20 = low(prior, 20);
  const range50 = high(prior, 50) - low(prior, 50);
  const compression = atr > 0 && atrFast / atr < 0.9;
  const z = std(clean.slice(-30)) > 0 ? (entry - mean(clean.slice(-30))) / std(clean.slice(-30)) : 0;

  let longScore = 0, shortScore = 0;
  const lr: string[] = [], sr: string[] = [];
  const longTrend = e20 > e50 && e50 > e100;
  const shortTrend = e20 < e50 && e50 < e100;
  if (longTrend) { longScore += profile.trend; lr.push('bullish EMA regime'); }
  if (shortTrend) { shortScore += profile.trend; sr.push('bearish EMA regime'); }
  if (mom > momentumThreshold) { longScore += profile.momentum; lr.push('positive momentum'); }
  if (mom < -momentumThreshold) { shortScore += profile.momentum; sr.push('negative momentum'); }

  const longBreak = entry > h20 && entry > h12;
  const shortBreak = entry < l20 && entry < l12;
  const longReclaim = entry > e20 && clean.slice(-6, -1).some((p) => p <= e20);
  const shortReclaim = entry < e20 && clean.slice(-6, -1).some((p) => p >= e20);
  if (longBreak || (longReclaim && longTrend)) { longScore += profile.trigger; lr.push(longBreak ? '20-bar breakout' : 'EMA20 reclaim'); }
  if (shortBreak || (shortReclaim && shortTrend)) { shortScore += profile.trigger; sr.push(shortBreak ? '20-bar breakdown' : 'EMA20 reclaim'); }

  if (vol >= 0.0007 && vol <= 0.012) {
    if (longScore > 0) { longScore += profile.volatility; lr.push('tradable volatility'); }
    if (shortScore > 0) { shortScore += profile.volatility; sr.push('tradable volatility'); }
  }
  if (compression && (longBreak || shortBreak)) {
    if (longBreak) { longScore += 8; lr.push('compression expansion'); }
    if (shortBreak) { shortScore += 8; sr.push('compression expansion'); }
  }
  if (currentRsi > 72) { longScore -= profile.extensionPenalty; lr.push('RSI overbought penalty'); }
  if (currentRsi < 28) { shortScore -= profile.extensionPenalty; sr.push('RSI oversold penalty'); }
  if (z > 2) longScore -= profile.extensionPenalty;
  if (z < -2) shortScore -= profile.extensionPenalty;

  const side: Side = longScore >= shortScore ? 'LONG' : 'SHORT';
  const score = Math.max(longScore, shortScore);
  const reasons = side === 'LONG' ? lr : sr;
  const trigger = side === 'LONG' ? (longBreak || (longReclaim && longTrend)) : (shortBreak || (shortReclaim && shortTrend));
  if (score < cfg.minScore) return waitSignal(entry, [`Score ${Math.max(0, Math.round(score))}/${cfg.minScore}`, ...reasons], score);
  if (!trigger) return waitSignal(entry, ['No structural trigger', ...reasons], score);
  if (!atr || !range50) return waitSignal(entry, ['Invalid volatility structure'], score);

  const stopDistance = Math.max(atr * cfg.atrStopMultiple, entry * 0.0015);
  const projection = Math.max(atr * 3.0, Math.abs(slope(clean.slice(-12))) * 42, range50 * 0.55);
  const rawR = projection / stopDistance;
  if (!Number.isFinite(rawR) || rawR < cfg.minRiskReward) return waitSignal(entry, [`Projected R ${Number.isFinite(rawR) ? rawR.toFixed(1) : '0.0'} below ${cfg.minRiskReward}`, ...reasons], score);
  const rr = clamp(rawR, cfg.minRiskReward, cfg.maxRiskReward);
  const stopLoss = side === 'LONG' ? entry - stopDistance : entry + stopDistance;
  const takeProfit = side === 'LONG' ? entry + stopDistance * rr : entry - stopDistance * rr;
  return { action: side, score: Math.round(clamp(score, 0, 100)), confidence: Math.round(clamp(score, 0, 100)), strategy: profile.name, entry, stopLoss, takeProfit, riskReward: rr, reasons };
}

export function evaluateStrategy(prices: number[], config: Partial<StrategyConfig> = {}): StrategySignal {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const limit = Math.min(10, Math.max(1, Math.round(cfg.strategyLimit ?? 10)));
  const signals = PROFILES.slice(0, limit).map((p) => scoreProfile(prices, cfg, p)).filter((s) => s.action !== 'WAIT');
  if (!signals.length) {
    const fallback = scoreProfile(prices, cfg, PROFILES[0]);
    return fallback.action === 'WAIT' ? fallback : waitSignal(fallback.entry, ['No strategy passed the complete filter set'], fallback.score);
  }
  return signals.sort((a, b) => b.score - a.score || b.riskReward - a.riskReward)[0];
}

function waitSignal(entry: number, reasons: string[], score = 0): StrategySignal {
  const normalized = Math.round(clamp(score, 0, 100));
  return { action: 'WAIT', score: normalized, confidence: normalized, strategy: 'No Trade', entry, stopLoss: entry, takeProfit: entry, riskReward: 0, reasons };
}
