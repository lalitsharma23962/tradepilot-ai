import type { MarketBar } from './marketData';
import { atr, mean, adx, ema, vwap, efficiency } from './marketData';
import { evaluateV32, normalize, wait, TARGET_LADDER, FINAL_TARGET_R } from './strategyV32';
import type { StrategySignalV39, StrategyConfig } from './strategyV32';
import { TRADING_CONFIG } from './tradingConfig';

export type { StrategySignalV39 } from './strategyV32';

export function evaluateV39(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 {
  const bars = (typeof input[0] === 'number' ? [] : (input as MarketBar[])).filter(b => Number.isFinite(b.close) && b.close > 0);
  const baseCfg = {
    ...config,
    minScore: Math.max(TRADING_CONFIG.minScore, config.minScore ?? TRADING_CONFIG.minScore),
    minRiskReward: FINAL_TARGET_R,
    maxRiskReward: FINAL_TARGET_R,
    riskReward: FINAL_TARGET_R,
    skipLegacyPathCapacity: true,
    maxStructuralRiskAtr: TRADING_CONFIG.maxStructuralRiskAtr,
    minStopAtr: TRADING_CONFIG.minStopAtr,
    maxCostFractionOfRisk: TRADING_CONFIG.maxCostFractionOfRisk,
  };

  const signal = evaluateV32(input, baseCfg);
  if (signal.action === 'WAIT') return signal;
  if (signal.family !== 'trend') return wait(signal, ['v39 rejected non-trend family']);
  if (bars.length < 250) return wait(signal, ['v39 requires at least 250 completed 5m bars']);

  const side = signal.action === 'LONG' ? 1 : -1;
  const entry = signal.entry;
  const a14 = atr(bars, 14), a48 = atr(bars, 48), atrRatio = a48 > 0 ? a14 / a48 : 0;
  const adx14 = adx(bars, 14);

  const p = bars.map(b => b.close), e20 = ema(p, 20), e50 = ema(p, 50), sessionVwap = vwap(bars.slice(-288));
  const recent = bars.slice(-13, -1);
  const recentEmaTouch = recent.some(b => b.low <= e50 + a14 * 0.80 && b.high >= e50 - a14 * 0.80);
  const recentVwapTouch = recent.some(b => b.low <= sessionVwap + a14 * 0.80 && b.high >= sessionVwap - a14 * 0.80);
  const pullback = recentEmaTouch || recentVwapTouch;

  const last = bars.at(-1)!, prev = bars.at(-2)!;
  const range = Math.max(last.high - last.low, entry * 1e-8), body = Math.abs(last.close - last.open) / range;
  const closeLocLong = (last.close - last.low) / range, closeLocShort = (last.high - last.close) / range;
  const rejection = side === 1 
    ? last.close >= prev.close && closeLocLong >= 0.45 
    : last.close <= prev.close && closeLocShort >= 0.45;

  const vols = bars.slice(-21, -1).map(b => b.volume).filter(v => Number.isFinite(v) && v > 0), avgVol = mean(vols), volRatio = avgVol > 0 ? last.volume / avgVol : 1;
  const volumeConfirmed = avgVol <= 0 || volRatio >= 0.80;

  const momentumEfficiency = efficiency(p.slice(-24));
  const distanceToEma20 = Math.abs(entry - e20) / Math.max(a14, entry * 1e-8);

  const cost = 2 * ((config.feeBps ?? TRADING_CONFIG.feeBps) + (config.slippageBps ?? TRADING_CONFIG.slippageBps)) / 10000;
  const costFraction = entry * cost / Math.max(Math.abs(entry - signal.stopLoss), 1e-12);

  const hourlyConfirmed = signal.reasons.some(r => r === 'Completed-hour confirmation');

  if (adx14 < 14) return wait(signal, [`v39 rejected: 5m ADX ${adx14.toFixed(1)} < 14 trend-strength floor`]);
  if (!pullback) return wait(signal, ['v39 rejected: no recent EMA50/VWAP pullback']);
  if (!rejection) return wait(signal, ['v39 rejected: no decisive pullback rejection candle']);
  if (!volumeConfirmed) return wait(signal, [`v39 rejected: volume ratio ${volRatio.toFixed(2)} < 0.80`]);
  if (atrRatio < 0.60) return wait(signal, [`v39 rejected: ATR regime is contracting (${atrRatio.toFixed(2)}x)`]);
  if (distanceToEma20 > 2.5) return wait(signal, ['v39 rejected: entry is too extended from EMA20']);
  if (costFraction > TRADING_CONFIG.maxCostFractionOfRisk) return wait(signal, [`v39 rejected: round-trip cost is ${(costFraction * 100).toFixed(0)}% of 1R`]);
  if (signal.score < TRADING_CONFIG.minScore) return wait(signal, [`v39 rejected: conviction score ${signal.score} < ${TRADING_CONFIG.minScore}`]);

  const risk = Math.abs(signal.entry - signal.stopLoss);
  if (!(risk > 0) || !Number.isFinite(risk)) return wait(signal, ['v39 rejected invalid structural risk']);

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
      'v39: relaxed pullback + rejection + volume',
      'Asymmetric 3R/5R/10R ladder',
    ],
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
