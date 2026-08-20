export type TradingMode='PAPER';
export const TRADING_CONFIG={
 mode:'PAPER' as TradingMode,
 strategyVersion:'v28',
 minScore:78,
 ultraScore:96,
 researchMinRiskReward:1.5,
 researchMaxRiskReward:3,
 productionMinRiskReward:1.5,
 productionMaxRiskReward:3,
 atrStopMultiple:0.8,
 maxStructuralRiskAtr:2.50,
 swingLookback:5,
 // 720 x 5m bars = 60 hours of context, allowing the strategy to build
 // a higher-timeframe (1h) regime filter without changing paper execution cadence.
 lookback:720,
 riskPerTradePct:.25,
 maxAllocationPct:20,
 maxPositions:3,
 cooldownBars:3,
 feeBps:10,
 slippageBps:2,
 maxBarsInTrade:{'5m':1440,'15m':480,'1h':240,'4h':180} as Record<string,number>,
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
