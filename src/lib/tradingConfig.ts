export type TradingMode='PAPER';

/**
 * v36: cost-aware, multi-timeframe paper-trading configuration.
 *
 * The validator is deliberately fail-closed. These values do not promise
 * profitability; they define the economic/risk envelope in which a setup is
 * allowed to be tested and, only after validation, paper traded.
 */
export const TRADING_CONFIG={
 mode:'PAPER' as TradingMode,
 strategyVersion:'v36',

 // Entry conviction. Score is additive; feasibility is a separate gate.
 minScore:78,
 ultraScore:92,

 // 10R/15R are research-only historical ideas, not production gates.
 researchMinRiskReward:1.8,
 researchMaxRiskReward:4,
 productionMinRiskReward:1.8,
 productionMaxRiskReward:4,

 // Stop geometry is expressed entirely in ATR units so the bounds cannot
 // become mathematically contradictory as they did in v35.
 atrStopMultiple:1.5,
 minStopAtr:1.0,
 maxStructuralRiskAtr:3.2,
 maxCostFractionOfRisk:.25,
 swingLookback:5,
 lookback:400,

 // Small-account defaults. Risk is never increased just because equity is low.
 paperStartingCapital:50,
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

 // The engine evaluates every requested timeframe and chooses the best one.
 timeframes:['5m','15m','30m','45m','1h','2h','3h','4h','1d'] as const,
 maxBarsInTrade:{'5m':1440,'15m':480,'30m':320,'45m':256,'1h':240,'2h':160,'3h':128,'4h':96,'1d':30} as Record<string,number>,
 capacitySamples:20,

 // Validation gate remains strict. Nothing here is a profitability promise.
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
