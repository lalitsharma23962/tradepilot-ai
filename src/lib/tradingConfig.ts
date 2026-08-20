export type TradingMode = 'PAPER';

/**
 * v39: selective BTCUSDT trend-pullback configuration.
 * The economic model uses an asymmetric 3R / 5R / 10R ladder. A setup must
 * pass strict entry/regime filters and the validation gate before production.
 */
export const TRADING_CONFIG = {
  mode: 'PAPER' as TradingMode,
  strategyVersion: 'v39',
  minScore: 78,
  ultraScore: 96,
  researchMinRiskReward: 3,
  researchMaxRiskReward: 10,
  productionMinRiskReward: 10,
  productionMaxRiskReward: 10,
  atrStopMultiple: 0.8,
  minStopAtr: 0.50,
  maxStructuralRiskAtr: 2.5,
  maxCostFractionOfRisk: 0.50,
  swingLookback: 5,
  lookback: 400,
  paperStartingCapital: 50 as number,
  riskPerTradePct: 0.5,
  maxAllocationPct: 20,
  maxPositions: 1,
  cooldownBars: 12,
  feeBps: 10,
  slippageBps: 2,
  minNotionalUsd: 5,
  maxLeverage: 5,
  minLiquidationDistanceAtr: 6,
  maxDailyLossPct: 2,
  maxConsecutiveLosses: 4,
  maxAccountDrawdownPct: 12,
  // Binance Spot-supported intervals only. 45m and 3h are not valid Spot kline intervals.
  timeframes: ['5m', '15m', '30m', '1h', '2h', '4h', '1d'] as const,
  maxBarsInTrade: { '5m': 720, '15m': 240, '30m': 160, '1h': 120, '2h': 80, '4h': 48, '1d': 20 } as Record<string, number>,
  capacitySamples: 20,
  minFoldTrades: 15,
  minTestTrades: 40,
  minProfitFactor: 1.50,
  maxDrawdownPct: 12,
  maxMonteCarloLossProbability: 15,
  preOosFraction: 0.70,
  folds: 3,
  monteCarloRuns: 5000,
} as const;

export type TradingConfig = typeof TRADING_CONFIG;

export function resolveTradingConfig(overrides: Partial<TradingConfig> = {}): TradingConfig {
  return { ...TRADING_CONFIG, ...overrides };
}
