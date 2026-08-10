export type TradingMode='PAPER';

/**
 * v37: cost-aware multi-timeframe paper-trading configuration.
 * The final risk/reward target is fixed at 2R; profits are taken progressively
 * at 0.5R, 1R, 1.5R and 2R. These values define an economic/risk envelope,
 * not a promise of profitability.
 */
export const TRADING_CONFIG={
 mode:'PAPER' as TradingMode,
 strategyVersion:'v37',
 minScore:68,
 ultraScore:92,
 researchMinRiskReward:2,
 researchMaxRiskReward:2,
 productionMinRiskReward:2,
 productionMaxRiskReward:2,
 atrStopMultiple:1.5,
 minStopAtr:1.0,
 maxStructuralRiskAtr:3.2,
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
