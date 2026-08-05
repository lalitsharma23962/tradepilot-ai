export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type BacktestConfig = {
  initialCapital: number;
  feeBps: number;
  slippageBps: number;
  riskPerTradePct: number;
  maxPositionPct: number;
  leverage: number;
  stopAtr: number;
  rewardRisk: number;
  maxBarsInTrade: number;
};

export type StrategyResult = {
  id: string;
  name: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  netPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  avgTrade: number;
  score: number;
};

export type ValidationReport = {
  symbol: string;
  interval: string;
  candles: number;
  costs: { feeBps: number; slippageBps: number };
  strategies: StrategyResult[];
  walkForward: {
    trainBars: number;
    validationBars: number;
    testBars: number;
    selectedStrategy: string;
    test: StrategyResult | null;
  };
  monteCarlo: {
    simulations: number;
    probabilityOfLoss: number;
    medianReturnPct: number;
    p05ReturnPct: number;
    p95MaxDrawdownPct: number;
  };
  generatedAt: string;
};

export const MAX_STRATEGIES = 10;
export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialCapital: 10000,
  feeBps: 10,
  slippageBps: 2,
  riskPerTradePct: 0.35,
  maxPositionPct: 20,
  leverage: 10,
  stopAtr: 1.5,
  rewardRisk: 2.2,
  maxBarsInTrade: 48,
};

export const STRATEGIES = [
  { id: 'ema-trend', name: 'EMA Trend + Momentum' },
  { id: 'breakout', name: 'Donchian Breakout' },
  { id: 'pullback', name: 'EMA Pullback' },
  { id: 'rsi-reversion', name: 'RSI Mean Reversion' },
  { id: 'bollinger', name: 'Bollinger Reversion' },
  { id: 'macd', name: 'MACD Trend' },
  { id: 'range-break', name: 'Volatility Range Break' },
  { id: 'momentum', name: 'Multi-Horizon Momentum' },
  { id: 'volume-break', name: 'Volume Breakout' },
  { id: 'hybrid', name: 'Regime Hybrid' },
] as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const std = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(mean(xs.map(x => (x - m) ** 2))) : 0; };
const ema = (xs: number[], p: number) => { if (!xs.length) return 0; const k = 2 / (p + 1); let e = xs[0]; for (let i = 1; i < xs.length; i++) e = xs[i] * k + e * (1 - k); return e; };
const atr = (cs: Candle[], p = 14) => { const x = cs.slice(-(p + 1)); return mean(x.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - x[i].close), Math.abs(c.low - x[i].close)))); };
const highest = (xs: number[], n: number) => Math.max(...xs.slice(-n));
const lowest = (xs: number[], n: number) => Math.min(...xs.slice(-n));
const rsi = (xs: number[], p = 14) => { const d = xs.slice(-(p + 1)).slice(1).map((v, i) => v - xs.slice(-(p + 1))[i]); const gains = mean(d.map(x => Math.max(x, 0))); const losses = mean(d.map(x => Math.max(-x, 0))); return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses); };

function signal(strategyId: string, cs: Candle[]): 1 | -1 | 0 {
  if (cs.length < 120) return 0;
  const closes = cs.map(c => c.close);
  const last = closes.at(-1)!;
  const e10 = ema(closes, 10), e20 = ema(closes, 20), e50 = ema(closes, 50), e100 = ema(closes, 100);
  const a = atr(cs);
  if (!a || !Number.isFinite(a)) return 0;
  const r = rsi(closes);
  const prior = closes.slice(0, -1);
  const hi20 = highest(prior, 20), lo20 = lowest(prior, 20);
  const hi50 = highest(prior, 50), lo50 = lowest(prior, 50);
  const sd20 = std(closes.slice(-20)), mid20 = mean(closes.slice(-20));
  const upper = mid20 + 2 * sd20, lower = mid20 - 2 * sd20;
  const macd = ema(closes, 12) - ema(closes, 26);
  const macdPrev = ema(closes.slice(0, -1), 12) - ema(closes.slice(0, -1), 26);
  const momentum = last / closes[Math.max(0, closes.length - 21)] - 1;
  const vol = cs.at(-1)!.volume, avgVol = mean(cs.slice(-20).map(c => c.volume));

  switch (strategyId) {
    case 'ema-trend': return e20 > e50 && e50 > e100 && last > e10 ? 1 : e20 < e50 && e50 < e100 && last < e10 ? -1 : 0;
    case 'breakout': return last > hi20 ? 1 : last < lo20 ? -1 : 0;
    case 'pullback': return e20 > e50 && last > e20 && closes.slice(-5).some(x => x <= e20) ? 1 : e20 < e50 && last < e20 && closes.slice(-5).some(x => x >= e20) ? -1 : 0;
    case 'rsi-reversion': return r < 28 && last > closes.at(-2)! ? 1 : r > 72 && last < closes.at(-2)! ? -1 : 0;
    case 'bollinger': return last < lower && last > closes.at(-2)! ? 1 : last > upper && last < closes.at(-2)! ? -1 : 0;
    case 'macd': return macd > 0 && macd > macdPrev && last > e50 ? 1 : macd < 0 && macd < macdPrev && last < e50 ? -1 : 0;
    case 'range-break': return last > hi50 && a / last > 0.003 ? 1 : last < lo50 && a / last > 0.003 ? -1 : 0;
    case 'momentum': return momentum > 0.008 && last > e20 ? 1 : momentum < -0.008 && last < e20 ? -1 : 0;
    case 'volume-break': return vol > avgVol * 1.5 && last > hi20 ? 1 : vol > avgVol * 1.5 && last < lo20 ? -1 : 0;
    case 'hybrid': return e20 > e50 && momentum > 0.004 && r > 50 && r < 72 ? 1 : e20 < e50 && momentum < -0.004 && r < 50 && r > 28 ? -1 : 0;
    default: return 0;
  }
}

function simulate(cs: Candle[], strategyId: string, cfg: BacktestConfig): StrategyResult {
  let equity = cfg.initialCapital, peak = equity, maxDd = 0, wins = 0, losses = 0;
  const pnls: number[] = [];
  const fee = cfg.feeBps / 10000, slip = cfg.slippageBps / 10000;
  let open: { side: 1 | -1; entry: number; stop: number; target: number; qty: number; bars: number } | null = null;

  for (let i = 120; i < cs.length; i++) {
    const window = cs.slice(0, i + 1);
    const c = cs[i];
    if (open) {
      open.bars++;
      const hitStop = open.side === 1 ? c.low <= open.stop : c.high >= open.stop;
      const hitTarget = open.side === 1 ? c.high >= open.target : c.low <= open.target;
      if (hitStop || hitTarget || open.bars >= cfg.maxBarsInTrade) {
        const rawExit = hitStop ? open.stop : hitTarget ? open.target : c.close;
        const exit = rawExit * (1 - open.side * slip);
        const gross = open.side * (exit - open.entry) * open.qty;
        const fees = (Math.abs(open.entry * open.qty) + Math.abs(exit * open.qty)) * fee;
        const pnl = gross - fees;
        equity += pnl; pnls.push(pnl);
        if (pnl > 0) wins++; else if (pnl < 0) losses++;
        open = null;
      }
    }
    if (!open) {
      const side = signal(strategyId, window);
      if (!side) { peak = Math.max(peak, equity); maxDd = Math.max(maxDd, (peak - equity) / peak * 100); continue; }
      const entry = c.close * (1 + side * slip);
      const a = atr(window);
      const riskDistance = Math.max(a * cfg.stopAtr, entry * 0.002);
      const stop = entry - side * riskDistance;
      const target = entry + side * riskDistance * cfg.rewardRisk;
      const riskBudget = equity * cfg.riskPerTradePct / 100;
      const riskQty = riskBudget / riskDistance;
      const allocationQty = equity * cfg.maxPositionPct / 100 * cfg.leverage / entry;
      const qty = Math.max(0, Math.min(riskQty, allocationQty));
      if (qty > 0) open = { side, entry, stop, target, qty, bars: 0 };
    }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak * 100);
  }
  const grossProfit = pnls.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter(x => x < 0).reduce((a, b) => a + b, 0));
  const pf = grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const winRate = pnls.length ? wins / pnls.length * 100 : 0;
  const netPnl = equity - cfg.initialCapital;
  const score = netPnl > 0 ? netPnl / cfg.initialCapital * 100 + Math.min(pf, 5) * 3 + winRate / 20 - maxDd * 0.75 : netPnl / cfg.initialCapital * 100 - maxDd;
  return { id: strategyId, name: STRATEGIES.find(s => s.id === strategyId)?.name ?? strategyId, trades: pnls.length, wins, losses, winRate, profitFactor: pf, netPnl, returnPct: netPnl / cfg.initialCapital * 100, maxDrawdownPct: maxDd, avgTrade: pnls.length ? mean(pnls) : 0, score };
}

export async function fetchHistoricalCandles(symbol = 'BTCUSDT', interval = '5m', limit = 1000): Promise<Candle[]> {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Math.min(1000, Math.max(200, limit))}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Historical market data request failed (${response.status}).`);
  const rows = await response.json() as unknown[][];
  return rows.map(r => ({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) })).filter(c => [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite));
}

function monteCarlo(returns: number[], simulations = 2000, seed = 0x51a7): ValidationReport['monteCarlo'] {
  if (!returns.length) return { simulations, probabilityOfLoss: 100, medianReturnPct: 0, p05ReturnPct: 0, p95MaxDrawdownPct: 0 };
  let s = seed >>> 0;
  const rand = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
  const endings: number[] = [], dds: number[] = [];
  for (let run = 0; run < simulations; run++) {
    let eq = 1, peak = 1, dd = 0;
    for (let i = 0; i < returns.length; i++) { const r = returns[Math.floor(rand() * returns.length)]; eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak * 100); }
    endings.push((eq - 1) * 100); dds.push(dd);
  }
  endings.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  const q = (xs: number[], p: number) => xs[Math.floor((xs.length - 1) * p)] ?? 0;
  return { simulations, probabilityOfLoss: endings.filter(x => x < 0).length / simulations * 100, medianReturnPct: q(endings, 0.5), p05ReturnPct: q(endings, 0.05), p95MaxDrawdownPct: q(dds, 0.95) };
}

export async function runValidation(symbol = 'BTCUSDT', interval = '5m', cfg: Partial<BacktestConfig> = {}): Promise<ValidationReport> {
  const config = { ...DEFAULT_BACKTEST_CONFIG, ...cfg, maxPositionPct: clamp(cfg.maxPositionPct ?? DEFAULT_BACKTEST_CONFIG.maxPositionPct, 1, 20), leverage: clamp(cfg.leverage ?? DEFAULT_BACKTEST_CONFIG.leverage, 1, 10) };
  const candles = await fetchHistoricalCandles(symbol, interval, 1000);
  const strategies = STRATEGIES.slice(0, MAX_STRATEGIES).map(s => simulate(candles, s.id, config)).sort((a, b) => b.score - a.score);
  const trainEnd = Math.floor(candles.length * 0.6), validationEnd = Math.floor(candles.length * 0.8);
  const train = candles.slice(0, trainEnd), validation = candles.slice(trainEnd, validationEnd), test = candles.slice(validationEnd);
  const trainRanked = STRATEGIES.slice(0, MAX_STRATEGIES).map(s => simulate(train, s.id, config)).sort((a, b) => b.score - a.score);
  const selected = trainRanked[0]?.id ?? STRATEGIES[0].id;
  const selectedValidation = simulate(validation, selected, config);
  const finalSelected = selectedValidation.returnPct > 0 && selectedValidation.profitFactor >= 1 ? selected : (trainRanked[1]?.id ?? selected);
  const testResult = test.length >= 120 ? simulate(test, finalSelected, config) : null;
  const best = strategies.find(s => s.id === finalSelected) ?? strategies[0];
  const returns = candles.length > 1 ? candles.slice(1).map((c, i) => (c.close / candles[i].close) - 1).filter(r => Number.isFinite(r)) : [];
  return { symbol, interval, candles: candles.length, costs: { feeBps: config.feeBps, slippageBps: config.slippageBps }, strategies, walkForward: { trainBars: train.length, validationBars: validation.length, testBars: test.length, selectedStrategy: best?.name ?? finalSelected, test: testResult }, monteCarlo: monteCarlo(returns), generatedAt: new Date().toISOString() };
}
