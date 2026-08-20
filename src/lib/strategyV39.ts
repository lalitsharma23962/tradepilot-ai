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
  const a14 = atr(bars, 14);

  const cost = 2 * ((config.feeBps ?? TRADING_CONFIG.feeBps) + (config.slippageBps ?? TRADING_CONFIG.slippageBps)) / 10000;
  const costFraction = entry * cost / Math.max(Math.abs(entry - signal.stopLoss), 1e-12);

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
    reasons: [...signal.reasons, 'v39: 3R/5R/10R asymmetric ladder'],
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
