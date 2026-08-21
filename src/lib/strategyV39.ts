import type { MarketBar } from './marketData';

export interface StrategyConfig {
  atrPeriod?: number;
  atrMultStop?: number;
  atrMultTp?: number;
  minRiskReward?: number;
  minScore?: number;
  htf1h?: MarketBar[];
  htf4h?: MarketBar[];
}

export interface TargetLadderStep {
  r: number;
  fraction: number;
  price: number;
  moveStopToBreakeven: boolean;
}

export interface StrategySignalV39 {
  action: 'LONG' | 'SHORT' | 'WAIT';
  family: string;
  strategy: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  score: number;
  targets: TargetLadderStep[];
  finalTargetR: number;
  reasons: string[];
}

export type StrategySignal = StrategySignalV39;

function ema(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

function atr(bars: MarketBar[], period: number): number {
  if (bars.length <= period) return NaN;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const current = bars[i];
    const previous = bars[i - 1];
    tr.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }
  return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function adx(bars: MarketBar[], period = 14): number {
  if (bars.length < period * 2 + 1) return NaN;
  const dx: number[] = [];

  for (let i = period; i < bars.length; i += 1) {
    let trSum = 0;
    let plus = 0;
    let minus = 0;

    for (let j = i - period + 1; j <= i; j += 1) {
      const current = bars[j];
      const previous = bars[j - 1];
      const trueRange = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      );
      const upMove = current.high - previous.high;
      const downMove = previous.low - current.low;
      trSum += trueRange;

      if (upMove > downMove && upMove > 0) plus += upMove;
      else if (downMove > upMove && downMove > 0) minus += downMove;
    }

    const plusDi = trSum ? (100 * plus) / trSum : 0;
    const minusDi = trSum ? (100 * minus) / trSum : 0;
    dx.push(
      plusDi + minusDi === 0
        ? 0
        : (100 * Math.abs(plusDi - minusDi)) / (plusDi + minusDi)
    );
  }

  return dx.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, dx.length);
}

function rsi(bars: MarketBar[], period = 14): number {
  if (bars.length <= period) return NaN;
  let gains = 0;
  let losses = 0;

  for (let i = bars.length - period; i < bars.length; i += 1) {
    const change = bars[i].close - bars[i - 1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return 100;
  const relativeStrength = (gains / period) / (losses / period);
  return 100 - 100 / (1 + relativeStrength);
}

function macdHistogram(values: number[]): number {
  if (values.length < 35) return NaN;
  const macdSeries: number[] = [];

  for (let i = 26; i <= values.length; i += 1) {
    const window = values.slice(0, i);
    macdSeries.push(ema(window, 12) - ema(window, 26));
  }

  if (macdSeries.length < 9) return NaN;
  return macdSeries.at(-1)! - ema(macdSeries, 9);
}

function aggregate(bars: MarketBar[], size: number): MarketBar[] {
  const result: MarketBar[] = [];
  for (let i = 0; i + size <= bars.length; i += size) {
    const group = bars.slice(i, i + size);
    result.push({
      openTime: group[0].openTime,
      open: group[0].open,
      high: Math.max(...group.map((bar) => bar.high)),
      low: Math.min(...group.map((bar) => bar.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, bar) => sum + bar.volume, 0),
    });
  }
  return result;
}

function wait(entry: number, reasons: string[]): StrategySignalV39 {
  return {
    action: 'WAIT',
    family: 'TrendPullback',
    strategy: 'Trend Pullback v39',
    entry,
    stopLoss: 0,
    takeProfit: 0,
    riskReward: 0,
    score: 0,
    targets: [],
    finalTargetR: 0,
    reasons,
  };
}

export function evaluateV39(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {}
): StrategySignalV39 {
  const atrPeriod = config.atrPeriod ?? 14;
  const stopMult = config.atrMultStop ?? 1.5;
  const minScore = config.minScore ?? 82;
  const bars: MarketBar[] =
    Array.isArray(input) && input.length > 0
      ? typeof input[0] === 'number'
        ? (input as number[]).map((value, index) => ({
            openTime: index,
            open: value,
            high: value,
            low: value,
            close: value,
            volume: 0,
          }))
        : (input as MarketBar[])
      : [];

  if (bars.length < 240) {
    return wait(0, ['Insufficient 5m history for multi-timeframe regime analysis']);
  }

  const h1 = config.htf1h ?? aggregate(bars, 12);
  const h4 = config.htf4h ?? aggregate(bars, 48);
  if (h1.length < 210 || h4.length < 210) {
    return wait(
      bars.at(-1)?.close ?? 0,
      ['Insufficient completed 1h/4h history for EMA 200 confirmation']
    );
  }

  const closes5 = bars.map((bar) => bar.close);
  const closes1h = h1.map((bar) => bar.close);
  const closes4h = h4.map((bar) => bar.close);
  const last = bars.at(-1)!;
  const previous = bars.at(-2)!;
  const entry = last.close;

  const atr5 = atr(bars, atrPeriod);
  const ema20_5 = ema(closes5, 20);
  const ema50_5 = ema(closes5, 50);
  const ema20_1h = ema(closes1h, 20);
  const ema50_1h = ema(closes1h, 50);
  const ema200_1h = ema(closes1h, 200);
  const ema20_4h = ema(closes4h, 20);
  const ema50_4h = ema(closes4h, 50);
  const ema200_4h = ema(closes4h, 200);
  const adx5 = adx(bars);
  const adx1h = adx(h1);
  const rsi5 = rsi(bars);
  const macd5 = macdHistogram(closes5);

  const values = [
    atr5,
    ema20_5,
    ema50_5,
    ema20_1h,
    ema50_1h,
    ema200_1h,
    ema20_4h,
    ema50_4h,
    ema200_4h,
    adx5,
    adx1h,
    rsi5,
    macd5,
  ];
  if (!values.every(Number.isFinite)) {
    return wait(entry, ['Indicator warm-up incomplete']);
  }

  const longTrend =
    h1.at(-1)!.close > ema20_1h &&
    ema20_1h > ema50_1h &&
    ema50_1h > ema200_1h &&
    h4.at(-1)!.close > ema20_4h &&
    ema20_4h > ema50_4h &&
    ema50_4h > ema200_4h;

  const shortTrend =
    h1.at(-1)!.close < ema20_1h &&
    ema20_1h < ema50_1h &&
    ema50_1h < ema200_1h &&
    h4.at(-1)!.close < ema20_4h &&
    ema20_4h < ema50_4h &&
    ema50_4h < ema200_4h;

  if (adx5 < 25 || adx1h < 20) {
    return wait(entry, ['Sideways/weak regime rejected: ADX below trend-strength threshold']);
  }

  const bullishPullback =
    previous.low <= ema50_5 &&
    last.close > ema20_5 &&
    last.close > last.open &&
    last.close > previous.high;

  const bearishPullback =
    previous.high >= ema50_5 &&
    last.close < ema20_5 &&
    last.close < last.open &&
    last.close < previous.low;

  const volumeAverage = bars.slice(-21, -1).reduce((sum, bar) => sum + bar.volume, 0) / 20;
  const volumeConfirmed = volumeAverage <= 0 || last.volume >= volumeAverage * 1.15;

  let action: 'LONG' | 'SHORT' | 'WAIT' = 'WAIT';
  const reasons: string[] = [];

  if (longTrend && bullishPullback && rsi5 >= 50 && rsi5 <= 72 && macd5 > 0) {
    action = 'LONG';
    reasons.push(
      '1h/4h EMA20>50>200 alignment',
      '5m EMA20/50 pullback reclaim',
      'bullish rejection and breakout candle',
      'RSI momentum confirmation',
      'positive MACD histogram confirmation'
    );
  } else if (shortTrend && bearishPullback && rsi5 >= 28 && rsi5 <= 50 && macd5 < 0) {
    action = 'SHORT';
    reasons.push(
      '1h/4h EMA20<50<200 alignment',
      '5m EMA20/50 pullback rejection',
      'bearish rejection and breakdown candle',
      'RSI momentum confirmation',
      'negative MACD histogram confirmation'
    );
  } else {
    return wait(entry, ['No qualified multi-timeframe pullback setup']);
  }

  if (!volumeConfirmed) {
    return wait(entry, ['Volume confirmation failed']);
  }

  const swingLow = Math.min(...bars.slice(-6, -1).map((bar) => bar.low));
  const swingHigh = Math.max(...bars.slice(-6, -1).map((bar) => bar.high));
  const structuralBuffer = atr5 * 0.15;
  let riskDistance =
    action === 'LONG'
      ? Math.max(entry - swingLow + structuralBuffer, atr5 * 0.8)
      : Math.max(swingHigh - entry + structuralBuffer, atr5 * 0.8);
  riskDistance = Math.min(riskDistance, atr5 * 2.5);

  if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
    return wait(entry, ['Invalid structural stop']);
  }

  // Confidence is an evidence score, not a prediction of win probability.
  let score = 40; // Mandatory 1h + 4h trend alignment.
  score += 20; // Pullback/reclaim confirmation.
  if (adx5 >= 30) score += 5;
  if (adx1h >= 25) score += 5;
  if (action === 'LONG' && rsi5 >= 55 && rsi5 <= 68) score += 5;
  if (action === 'SHORT' && rsi5 >= 32 && rsi5 <= 45) score += 5;
  if ((action === 'LONG' && macd5 > 0) || (action === 'SHORT' && macd5 < 0)) score += 5;
  if (volumeConfirmed) score += 5;
  if (last.close > ema20_5 && last.close < ema20_5 + atr5 * 1.25) score += action === 'LONG' ? 5 : 0;
  if (last.close < ema20_5 && last.close > ema20_5 - atr5 * 1.25) score += action === 'SHORT' ? 5 : 0;
  score = Math.min(100, score);

  if (score < minScore) {
    return wait(entry, ['Conviction score below threshold']);
  }

  const stopLoss = action === 'LONG' ? entry - riskDistance : entry + riskDistance;
  const takeProfit = action === 'LONG' ? entry + riskDistance * 2 : entry - riskDistance * 2;
  const riskReward = 2;

  return {
    action,
    family: 'TrendPullback',
    strategy: 'Trend Pullback v39',
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    score,
    targets: [
      {
        r: 2,
        fraction: 1,
        price: takeProfit,
        moveStopToBreakeven: false,
      },
    ],
    finalTargetR: 2,
    reasons,
  };
}

export function evaluateProductionStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {}
): StrategySignalV39 {
  return evaluateV39(input, {
    ...config,
    minRiskReward: 2,
    atrMultTp: 3,
    minScore: config.minScore ?? 82,
  });
}

export function evaluateResearchStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {}
): StrategySignalV39 {
  return evaluateProductionStrategy(input, config);
}

export function evaluateStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {}
): StrategySignalV39 {
  return evaluateProductionStrategy(input, config);
}
