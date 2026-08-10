export type TradingMode='PAPER';

/**
 * v36: cost-aware, multi-timeframe paper-trading configuration.
 * The validator is deliberately fail-closed; these values define an economic
 * and risk envelope, not a promise of profitability.
 */
export const TRADING_CONFIG={
 mode:'PAPER' as TradingMode,
 strategyVersion:'v36',
 // Entry threshold is selective, but no longer so high that normal evidence
 // gets discarded before the independent path/cost/OOS gates can evaluate it.
 minScore:68,
 ultraScore:92,
 researchMinRiskReward:1.8,
 researchMaxRiskReward:4,
 productionMinRiskReward:1.8,
 productionMaxRiskReward:4,
 atrStopMultiple:1.5,
 minStopAtr:1.0,
 maxStructuralRiskAtr:3.2,
 // 10 bps fee + 2 bps slippage per side is material on 5m. Allow up to 40%
 // of one-R price risk for transaction costs; the target feasibility gate
 // still explicitly prices those costs into the required hit rate.
 maxCostFractionOfRisk:.40,
 swingLookback:5,
 lookback:400,
 paperStartingCapital:50 as number,
 riskPerTradePct:.5,
 maxAllocationPct:20,
 maxPositions:1,
 cooldownBars:6,
 feeBps:10,
 slippageBps:2,
 minNotionalUsd:5,
 maxLeverage:5,
 minLiquidationDistanceAtr:6,
 maxDailyLossPct:2,
 maxConsecutiveLosses:4,
 maxAccountDrawdownPct:15,
 timeframes:['5m','15m','30m','45m','1h','2h','3h','4h','1d'] as const,
 // Dynamic 2R-4R targets do not need the old five-day 5m holding horizon.
 // Shorter horizons improve turnover and reduce the amount of history consumed
 // by the independent capacity warm-up while remaining causal.
 maxBarsInTrade:{'5m':720,'15m':240,'30m':160,'45m':128,'1h':120,'2h':80,'3h':64,'4h':48,'1d':20} as Record<string,number>,
 capacitySamples:20,
 minFoldTrades:12,
 minTestTrades:30,
 minProfitFactor:1.05,
 maxDrawdownPct:20,
 maxMonteCarloLossProbability:45,
 preOosFraction:.70,
 folds:3,
 monteCarloRuns:5000,
} as const;
export type TradingConfig=typeof TRADING_CONFIG;
export function resolveTradingConfig(overrides:Partial<TradingConfig>={}):TradingConfig{return {...TRADING_CONFIG,...overrides};}
