import type { Side } from './types';
import type { MarketBar } from './marketData';
import type { StrategyConfig, StrategySignal } from './strategyV32';
import { TRADING_CONFIG } from './tradingConfig';
import { calculateCostInR } from '../engine/units';
import { runnerProtectedStop } from './runnerProtection';
import {
  evaluateProductionStrategy,
  MIN_INDEPENDENT_SAMPLES,
  mean,
  clamp,
  std,
  ema,
  atrAt,
  efficiency,
  slope,
  consistency,
  rsi,
  percentile,
  completedHourly,
} from './strategyV35';

export type { StrategyConfig, StrategySignal } from './strategyV32';

/** Features and outcomes captured at the entry timestamp for offline attribution. */
export interface DiagnosticRecord {
  // Identifiers / context
  timestamp: number;
  timeframe: string;
  symbol: string;

  // Strategy decision
  action: Side | 'WAIT';
  side?: Side;
  family: string;
  rawScore: number;
  minScore: number;
  chosenR: number;

  // Prices / risk
  entry: number;
  stopPrice: number;
  risk: number;
  stopWidthAtr: number;
  costInR: number;

  // Trend / momentum
  ema20: number;
  ema50: number;
  ema100: number;
  ema20Slope: number;
  ema50Slope: number;
  emaAlignedUp: boolean;
  emaAlignedDown: boolean;
  distEma20Atr: number;
  distEma50Atr: number;
  distVwapAtr: number;
  adx: number;
  rsi: number;
  rsiSlope: number;
  roc12: number;
  roc24: number;
  momentumLong: boolean;
  momentumShort: boolean;
  longDirectionalCount: number;
  shortDirectionalCount: number;

  // Volatility
  atr20: number;
  atr12: number;
  atr48: number;
  atrExpansion: number;
  compression: boolean;
  expanding: boolean;
  currentRangeAtr: number;
  bollingerBandwidth: number;
  volPctOfPrice: number;

  // Market structure
  rangeHigh20: number;
  rangeLow20: number;
  distTo20HighAtr: number;
  distTo20LowAtr: number;
  distSwingHighAtr: number;
  distSwingLowAtr: number;
  breakoutLong: boolean;
  breakoutShort: boolean;
  pullbackLong: boolean;
  pullbackShort: boolean;
  reclaimLong: boolean;
  reclaimShort: boolean;
  bodyRatio: number;
  closeLocation: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  consecutiveBullish: number;
  consecutiveBearish: number;
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;

  // Hourly context
  hourlyEma20: number;
  hourlyEma40: number;
  hourlyLong: boolean;
  hourlyShort: boolean;

  // Volume
  volumeRatio20: number;
  volumePercentile20: number;
  volumeExpansion: boolean;

  // Path outcomes (available only when signal was accepted and capacity exists)
  P0?: number;
  P1?: number;
  P2?: number;
  P3?: number;
  samples?: number;
  grossExpectedR?: number;
  expectedTransactionCostR?: number;
  netExpectedR?: number;
  pathGrossR?: Record<'P0' | 'P1' | 'P2' | 'P3', number>;
  pathCostR?: Record<'P0' | 'P1' | 'P2' | 'P3', number>;
  pathNetR?: Record<'P0' | 'P1' | 'P2' | 'P3', number>;
  outcomeCounts?: Record<EpisodeOutcome, number>;
  timeoutRate?: number;
}

const vwap = (bars: MarketBar[]) => {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : bars.at(-1)?.close ?? 0;
};

const adx = (bars: MarketBar[], period = 14) => {
  if (bars.length < period + 2) return { adx: 0, plusDI: 0, minusDI: 0 };
  let plusDM = 0;
  let minusDM = 0;
  let tr = 0;
  for (let i = bars.length - period - 1; i < bars.length - 1; i++) {
    const cur = bars[i + 1];
    const prev = bars[i];
    const up = cur.high - prev.high;
    const down = prev.low - cur.low;
    plusDM += up > down && up > 0 ? up : 0;
    minusDM += down > up && down > 0 ? down : 0;
    tr += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  const atr = tr / period;
  if (!(atr > 0)) return { adx: 0, plusDI: 0, minusDI: 0 };
  const plusDI = (plusDM / period / atr) * 100;
  const minusDI = (minusDM / period / atr) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI + 1e-12) * 100;
  return { adx: dx, plusDI, minusDI };
};

const consecutiveDirectional = (bars: MarketBar[], direction: 1 | -1) => {
  let count = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    const bullish = b.close > b.open;
    if (direction === 1 ? bullish : !bullish) count++;
    else break;
  }
  return count;
};

const swing = (bars: MarketBar[], lookback: number) => {
  const recent = bars.slice(-lookback);
  const highs = recent.map((b) => b.high);
  const lows = recent.map((b) => b.low);
  return { high: Math.max(...highs), low: Math.min(...lows) };
};

export interface PathStats {
  grossR: number;
  costR: number;
  netR: number;
}

/**
 * Raw execution outcome for a single episode.
 * STOP_k  = stop-loss hit after k targets had been reached.
 * TP3     = all three targets filled (100% position closed).
 * TIMEOUT_k = horizon expired after k targets had been reached.
 */
export type EpisodeOutcome =
  | 'STOP_0'
  | 'STOP_1'
  | 'STOP_2'
  | 'TP3'
  | 'TIMEOUT_0'
  | 'TIMEOUT_1'
  | 'TIMEOUT_2';

export interface EpisodeResult extends PathStats {
  outcome: EpisodeOutcome;
  stage: number;
  isTimeout: boolean;
}

export interface FourPathResult {
  P0: number;
  P1: number;
  P2: number;
  P3: number;
  samples: number;
  grossExpectedR: number;
  expectedTransactionCostR: number;
  netExpectedR: number;
  pathGrossR: Record<'P0' | 'P1' | 'P2' | 'P3', number>;
  pathCostR: Record<'P0' | 'P1' | 'P2' | 'P3', number>;
  pathNetR: Record<'P0' | 'P1' | 'P2' | 'P3', number>;
  /** Explicit counts for every raw outcome, including timeouts. */
  outcomeCounts: Record<EpisodeOutcome, number>;
  /** Fraction of episodes that ended by timeout rather than stop/TP3. */
  timeoutRate: number;
}

/**
 * Map a raw episode outcome into the four-path summary bucket used for
 * attribution. TIMEOUT_k is grouped with STOP_k because both represent the
 * realized PnL at stage k; the empirical gross/cost/net R capture the exact
 * exit price (stop fill or timeout close).
 */
function outcomeToPath(outcome: EpisodeOutcome): 'P0' | 'P1' | 'P2' | 'P3' {
  switch (outcome) {
    case 'STOP_0':
    case 'TIMEOUT_0':
      return 'P0';
    case 'STOP_1':
    case 'TIMEOUT_1':
      return 'P1';
    case 'STOP_2':
    case 'TIMEOUT_2':
      return 'P2';
    case 'TP3':
      return 'P3';
  }
}

/**
 * Simulate a single historical episode using the exact discrete-bar execution
 * model from backtestV11.ts:
 *   - signal at close of bar i, fill at open of bar i+1 with entry slippage
 *   - stop-first same-candle ordering
 *   - TP1/TP2/TP3 partial exits with target slippage and per-exit fees
 *   - breakeven stop after TP1, +0.5R stop after TP2
 *   - runner-protected stop ratchet (uses imported runnerProtectedStop)
 *   - timeout at horizonBars
 */
export function simulateSingleEpisode(
  input: MarketBar[],
  signalIndex: number,
  side: Side,
  stopDistance: number,
  horizonBars: number,
  feeBps: number,
  slippageBps: number,
  targetMultiples: readonly number[] = [1, 1.5, 2],
): EpisodeResult | null {
  const completed = input;
  const fillBar = completed[signalIndex + 1];
  if (!fillBar) return null;

  const runnerSide = side === 'LONG' ? 1 : -1;
  const fee = feeBps / 10000;
  const slip = slippageBps / 10000;
  const allocations = targetMultiples.length === 3
    ? [0.25, 0.25, 0.5]
    : targetMultiples.map(() => 1 / targetMultiples.length);

  const entry = fillBar.open * (1 + runnerSide * slip);
  const initialStop = entry - runnerSide * stopDistance;
  const finalTargetPrice = entry + runnerSide * stopDistance * targetMultiples[targetMultiples.length - 1];

  const initialQty = 1;
  let remainingQty = initialQty;
  let realizedGross = 0;
  let realizedFees = 0;
  let simulatedStop = initialStop;
  let stage = 0;
  let outcome: EpisodeOutcome = 'TIMEOUT_0';

  for (let j = 1; j <= horizonBars; j++) {
    const b = completed[signalIndex + j];
    if (!b) break;

    // 1. Stop-first check (pessimistic same-candle handling).
    const hitStop = side === 'LONG' ? b.low <= simulatedStop : b.high >= simulatedStop;
    if (hitStop) {
      const exit = simulatedStop * (1 - runnerSide * slip);
      realizedGross += runnerSide * (exit - entry) * remainingQty;
      realizedFees += (Math.abs(entry * remainingQty) + Math.abs(exit * remainingQty)) * fee;
      outcome = stage === 0 ? 'STOP_0' : stage === 1 ? 'STOP_1' : 'STOP_2';
      break;
    }

    // 2. Sequential target checks within the same bar.
    while (stage < targetMultiples.length) {
      const target = entry + runnerSide * stopDistance * targetMultiples[stage];
      const hitTarget = side === 'LONG' ? b.high >= target : b.low <= target;
      if (!hitTarget) break;

      const q = stage === targetMultiples.length - 1
        ? remainingQty
        : Math.min(remainingQty, initialQty * (allocations[stage] ?? 1 / targetMultiples.length));
      const exit = target * (1 - runnerSide * slip);
      realizedGross += runnerSide * (exit - entry) * q;
      realizedFees += (Math.abs(entry * q) + Math.abs(exit * q)) * fee;
      remainingQty -= q;
      stage++;

      if (stage === 1) simulatedStop = entry;
      else if (stage === 2) simulatedStop = entry + runnerSide * stopDistance * 0.5;

      if (remainingQty <= Math.max(initialQty * 1e-9, 1e-12)) {
        outcome = 'TP3';
        break;
      }
    }

    if (outcome === 'TP3') break;

    // 3. Runner protection ratchet after target/stop processing (real impl).
    simulatedStop = runnerProtectedStop(runnerSide, entry, finalTargetPrice, simulatedStop, b.high, b.low);

    // 4. Timeout at horizon end.
    if (j === horizonBars) {
      const exit = b.close * (1 - runnerSide * slip);
      realizedGross += runnerSide * (exit - entry) * remainingQty;
      realizedFees += (Math.abs(entry * remainingQty) + Math.abs(exit * remainingQty)) * fee;
      outcome = stage === 0 ? 'TIMEOUT_0' : stage === 1 ? 'TIMEOUT_1' : 'TIMEOUT_2';
    }
  }

  const grossR = realizedGross / stopDistance;
  const costR = realizedFees / stopDistance;
  return { outcome, stage, isTimeout: outcome.startsWith('TIMEOUT'), grossR, costR, netR: grossR - costR };
}

/**
 * Execute the same discrete-bar simulation used by backtestV11.ts for each
 * historical episode and return empirical path probabilities plus realized
 * gross/cost/net R averages per path.
 */
export function simulateFourPaths(
  input: MarketBar[],
  side: Side,
  currentAtr: number,
  currentRisk: number,
  horizonBars: number,
  feeBps: number,
  slippageBps: number,
  targetMultiples: readonly number[] = [1, 1.5, 2],
): FourPathResult | null {
  const requiredLookback = MIN_INDEPENDENT_SAMPLES * horizonBars;
  const completed = input.slice(0, -1);
  if (completed.length < requiredLookback + horizonBars + 21) return null;

  const lastStart = completed.length - horizonBars;
  const firstStart = Math.max(20, lastStart - requiredLookback);
  if (lastStart <= firstStart) return null;

  const riskAtr = currentRisk / currentAtr;
  if (!Number.isFinite(riskAtr) || riskAtr <= 0) return null;

  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  let samples = 0;
  let timeouts = 0;
  const pathGross: Record<'P0' | 'P1' | 'P2' | 'P3', number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const pathCost: Record<'P0' | 'P1' | 'P2' | 'P3', number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const pathNet: Record<'P0' | 'P1' | 'P2' | 'P3', number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const outcomeCounts: Record<EpisodeOutcome, number> = {
    STOP_0: 0, STOP_1: 0, STOP_2: 0, TP3: 0,
    TIMEOUT_0: 0, TIMEOUT_1: 0, TIMEOUT_2: 0,
  };

  for (let i = lastStart - 1; i >= firstStart; i -= horizonBars) {
    const sampleAtr = atrAt(completed, i + 1);
    if (!(sampleAtr > 0) || !Number.isFinite(sampleAtr)) continue;

    const stopDistance = riskAtr * sampleAtr;
    if (!(stopDistance > 0)) continue;

    const episode = simulateSingleEpisode(
      completed,
      i,
      side,
      stopDistance,
      horizonBars,
      feeBps,
      slippageBps,
      targetMultiples,
    );
    if (!episode) continue;

    samples++;
    outcomeCounts[episode.outcome]++;
    if (episode.isTimeout) timeouts++;

    const path = outcomeToPath(episode.outcome);
    const { grossR, costR, netR } = episode;
    if (path === 'P0') { p0++; pathGross.P0 += grossR; pathCost.P0 += costR; pathNet.P0 += netR; }
    else if (path === 'P1') { p1++; pathGross.P1 += grossR; pathCost.P1 += costR; pathNet.P1 += netR; }
    else if (path === 'P2') { p2++; pathGross.P2 += grossR; pathCost.P2 += costR; pathNet.P2 += netR; }
    else if (path === 'P3') { p3++; pathGross.P3 += grossR; pathCost.P3 += costR; pathNet.P3 += netR; }
  }

  if (samples < MIN_INDEPENDENT_SAMPLES) return null;

  const P0 = p0 / samples;
  const P1 = p1 / samples;
  const P2 = p2 / samples;
  const P3 = p3 / samples;

  const avg = (sum: number, count: number) => count > 0 ? sum / count : 0;
  const pathGrossR = {
    P0: avg(pathGross.P0, p0),
    P1: avg(pathGross.P1, p1),
    P2: avg(pathGross.P2, p2),
    P3: avg(pathGross.P3, p3),
  };
  const pathCostR = {
    P0: avg(pathCost.P0, p0),
    P1: avg(pathCost.P1, p1),
    P2: avg(pathCost.P2, p2),
    P3: avg(pathCost.P3, p3),
  };
  const pathNetR = {
    P0: avg(pathNet.P0, p0),
    P1: avg(pathNet.P1, p1),
    P2: avg(pathNet.P2, p2),
    P3: avg(pathNet.P3, p3),
  };

  const grossExpectedR = P0 * pathGrossR.P0 + P1 * pathGrossR.P1 + P2 * pathGrossR.P2 + P3 * pathGrossR.P3;
  const expectedTransactionCostR = P0 * pathCostR.P0 + P1 * pathCostR.P1 + P2 * pathCostR.P2 + P3 * pathCostR.P3;
  const netExpectedR = grossExpectedR - expectedTransactionCostR;

  return {
    P0, P1, P2, P3, samples, grossExpectedR, expectedTransactionCostR, netExpectedR,
    pathGrossR, pathCostR, pathNetR, outcomeCounts, timeoutRate: timeouts / samples,
  };
}

export function evaluateWithDiagnostics(
  input: number[] | MarketBar[],
  symbol: string,
  timeframe: string,
  config: Partial<StrategyConfig> & {
    capacityBars?: MarketBar[];
    capacityHorizonBars?: number;
    minScoreOverride?: number;
    targetMultiplesR?: readonly number[];
  } = {},
): DiagnosticRecord {
  const cfg = config;
  const raw = Array.isArray(input) && input.length && typeof input[0] !== 'number'
    ? input as MarketBar[]
    : (input as number[]).map((close, i) => ({ openTime: i, open: close, high: close, low: close, close, volume: 0 }));
  const lookback = cfg.lookback ?? TRADING_CONFIG.lookback;
  const bars = raw.filter((b) => Number.isFinite(b.close) && b.close > 0).slice(-lookback);
  const p = bars.map((b) => b.close);
  const entry = p.at(-1) ?? 0;

  const emptyRecord: DiagnosticRecord = {
    timestamp: bars.at(-1)?.openTime ?? 0,
    timeframe,
    symbol,
    action: 'WAIT',
    family: 'none',
    rawScore: 0,
    minScore: cfg.minScoreOverride ?? cfg.minScore ?? TRADING_CONFIG.minScore,
    chosenR: 0,
    entry,
    stopPrice: entry,
    risk: 0,
    stopWidthAtr: 0,
    costInR: 0,
    ema20: 0,
    ema50: 0,
    ema100: 0,
    ema20Slope: 0,
    ema50Slope: 0,
    emaAlignedUp: false,
    emaAlignedDown: false,
    distEma20Atr: 0,
    distEma50Atr: 0,
    distVwapAtr: 0,
    adx: 0,
    rsi: 50,
    rsiSlope: 0,
    roc12: 0,
    roc24: 0,
    momentumLong: false,
    momentumShort: false,
    longDirectionalCount: 0,
    shortDirectionalCount: 0,
    atr20: 0,
    atr12: 0,
    atr48: 0,
    atrExpansion: 1,
    compression: false,
    expanding: false,
    currentRangeAtr: 0,
    bollingerBandwidth: 0,
    volPctOfPrice: 0,
    rangeHigh20: 0,
    rangeLow20: 0,
    distTo20HighAtr: 0,
    distTo20LowAtr: 0,
    distSwingHighAtr: 0,
    distSwingLowAtr: 0,
    breakoutLong: false,
    breakoutShort: false,
    pullbackLong: false,
    pullbackShort: false,
    reclaimLong: false,
    reclaimShort: false,
    bodyRatio: 0,
    closeLocation: 0.5,
    upperWickRatio: 0,
    lowerWickRatio: 0,
    consecutiveBullish: 0,
    consecutiveBearish: 0,
    higherHighs: false,
    higherLows: false,
    lowerHighs: false,
    lowerLows: false,
    hourlyEma20: 0,
    hourlyEma40: 0,
    hourlyLong: false,
    hourlyShort: false,
    volumeRatio20: 1,
    volumePercentile20: 50,
    volumeExpansion: false,
  };

  if (p.length < 160 || !entry) return emptyRecord;

  const a = atrAt(bars, bars.length, 20);
  const aFast = atrAt(bars, bars.length, 12);
  const aSlow = atrAt(bars, bars.length, 48);
  if (!(a > 0) || !(aSlow > 0)) return emptyRecord;

  const e20 = ema(p, 20);
  const e50 = ema(p, 50);
  const e100 = ema(p, 100);
  const rrsi = rsi(p);
  const prevRsi = rsi(p.slice(0, -1));
  const s12 = slope(p.slice(-12)) / entry;
  const s24 = slope(p.slice(-24)) / entry;
  const s48 = slope(p.slice(-48)) / entry;
  const eff24 = efficiency(p.slice(-24));
  const eff48 = efficiency(p.slice(-48));
  const longCons = consistency(p.slice(-15), 1);
  const shortCons = consistency(p.slice(-15), -1);
  const sep = Math.abs(e20 - e50) / a;
  const expansion = aFast / aSlow;
  const vol = a / entry;

  const up = e20 > e50 && e50 > e100;
  const down = e20 < e50 && e50 < e100;
  const last = bars.at(-1)!;
  const prev = bars.at(-2)!;
  const range = Math.max(last.high - last.low, entry * 1e-8);
  const body = Math.abs(last.close - last.open) / range;
  const closeLoc = (last.close - last.low) / range;
  const barLong = last.close > last.open && last.close >= prev.close && body >= 0.20 && closeLoc >= 0.55;
  const barShort = last.close < last.open && last.close <= prev.close && body >= 0.20 && closeLoc <= 0.45;

  const priorVol = bars.slice(-21, -1).map((b) => b.volume).filter((v) => Number.isFinite(v) && v > 0);
  const avgVol = mean(priorVol);
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : 1;
  const volumeHealthy = avgVol <= 0 || volumeRatio >= 0.70;
  const volPercentile = percentile(priorVol.map((v) => v / avgVol), 0.5) * 100;

  const hourly = completedHourly(bars);
  const hp = hourly.map((b) => b.close);
  const h20 = ema(hp, 20);
  const h40 = ema(hp, 40);
  const hS12 = hp.length >= 12 ? slope(hp.slice(-12)) / Math.max(entry, 1) : 0;
  const hEff24 = efficiency(hp.slice(-24));
  const hLong = hourly.length >= 50 && h20 > h40 && hS12 > 0 && hEff24 >= 0.06;
  const hShort = hourly.length >= 50 && h20 < h40 && hS12 < 0 && hEff24 >= 0.06;

  const longDirectional = (up ? 1 : 0) + (s24 > 0 ? 1 : 0) + (s48 > 0 ? 1 : 0) + (eff24 >= 0.14 ? 1 : 0) + (eff48 >= 0.10 ? 1 : 0) + (longCons >= 0.47 ? 1 : 0) + (sep >= 0.025 ? 1 : 0);
  const shortDirectional = (down ? 1 : 0) + (s24 < 0 ? 1 : 0) + (s48 < 0 ? 1 : 0) + (eff24 >= 0.14 ? 1 : 0) + (eff48 >= 0.10 ? 1 : 0) + (shortCons >= 0.47 ? 1 : 0) + (sep >= 0.025 ? 1 : 0);
  const momentumLong = s12 > Math.max(0.000008, vol * 0.0025) && (s24 > 0 || s48 > 0) && (eff24 >= 0.10 || eff48 >= 0.08);
  const momentumShort = s12 < -Math.max(0.000008, vol * 0.0025) && (s24 < 0 || s48 < 0) && (eff24 >= 0.10 || eff48 >= 0.08);

  const cost = 2 * ((cfg.feeBps ?? TRADING_CONFIG.feeBps) + (cfg.slippageBps ?? TRADING_CONFIG.slippageBps)) / 10000;
  const costAware = vol >= Math.max(0.00020, cost * 0.40) && vol <= 0.05;
  const rangeHigh = Math.max(...p.slice(-21, -1));
  const rangeLow = Math.min(...p.slice(-21, -1));
  const breakoutLongFlag = entry > rangeHigh + a * 0.008 && prev.close <= rangeHigh + a * 0.006;
  const breakoutShortFlag = entry < rangeLow - a * 0.008 && prev.close >= rangeLow - a * 0.006;
  const nearEma = Math.abs(entry - e20) <= a * 1.75;
  const pullbackLongFlag = bars.slice(-12, -1).some((b) => b.low <= e20 + a * 0.35 || b.close <= e20 * 1.002);
  const pullbackShortFlag = bars.slice(-12, -1).some((b) => b.high >= e20 - a * 0.35 || b.close >= e20 * 0.998);
  const reclaimLongFlag = entry > e20 && nearEma && barLong;
  const reclaimShortFlag = entry < e20 && nearEma && barShort;

  const prevFast = atrAt(bars.slice(0, -3), Math.max(0, bars.length - 3), 12);
  const prevSlow = atrAt(bars.slice(0, -3), Math.max(0, bars.length - 3), 48);
  const prevExpansion = prevSlow > 0 ? prevFast / prevSlow : 1;
  const compression = prevExpansion < 0.98;
  const expanding = expansion > Math.max(0.98, prevExpansion * 1.02) && expansion > prevExpansion + 0.01;

  const mid20 = mean(p.slice(-20));
  const sd20 = std(p.slice(-20));
  const upper = mid20 + 2 * sd20;
  const lower = mid20 - 2 * sd20;
  const bandwidth = sd20 > 0 ? (upper - lower) / mid20 : 0;

  const rangeEvidence = (sep <= 0.05 ? 1 : 0) + (eff24 <= 0.32 ? 1 : 0) + (eff48 <= 0.28 ? 1 : 0) + (expansion <= 1.15 ? 1 : 0);
  const rangeRegime = rangeEvidence >= 2;
  const reversionLong = rangeRegime && prevRsi <= 38 && rrsi > prevRsi && entry >= lower - a * 0.25 && entry <= lower + a * 0.55 && barLong;
  const reversionShort = rangeRegime && prevRsi >= 62 && rrsi < prevRsi && entry <= upper + a * 0.25 && entry >= upper - a * 0.55 && barShort;
  const directionalLong = longDirectional >= 3;
  const directionalShort = shortDirectional >= 3;

  const vwapValue = vwap(bars);
  const distVwapAtr = Math.abs(entry - vwapValue) / a;

  const adxValue = adx(bars, 14).adx;

  const swing5 = swing(bars, cfg.swingLookback ?? TRADING_CONFIG.swingLookback);
  const distSwingHighAtr = Math.abs(swing5.high - entry) / a;
  const distSwingLowAtr = Math.abs(entry - swing5.low) / a;

  const recentHighs = bars.slice(-12).map((b) => b.high);
  const recentLows = bars.slice(-12).map((b) => b.low);
  const higherHighsFlag = recentHighs[recentHighs.length - 1] > Math.max(...recentHighs.slice(0, -1));
  const higherLowsFlag = recentLows[recentLows.length - 1] > Math.max(...recentLows.slice(0, -1));
  const lowerHighsFlag = recentHighs[recentHighs.length - 1] < Math.min(...recentHighs.slice(0, -1));
  const lowerLowsFlag = recentLows[recentLows.length - 1] < Math.min(...recentLows.slice(0, -1));

  const roc12v = p.length >= 13 ? (p[p.length - 1] - p[p.length - 13]) / p[p.length - 13] : 0;
  const roc24v = p.length >= 25 ? (p[p.length - 1] - p[p.length - 25]) / p[p.length - 25] : 0;

  const upperWick = (last.high - Math.max(last.open, last.close)) / range;
  const lowerWick = (Math.min(last.open, last.close) - last.low) / range;

  const signal = evaluateProductionStrategy(input, cfg);

  const baseRecord: DiagnosticRecord = {
    timestamp: last.openTime,
    timeframe,
    symbol,
    action: signal.action,
    side: signal.action === 'WAIT' ? undefined : signal.action,
    family: signal.family,
    rawScore: signal.score,
    minScore: cfg.minScoreOverride ?? cfg.minScore ?? TRADING_CONFIG.minScore,
    chosenR: signal.riskReward,
    entry,
    stopPrice: signal.stopLoss,
    risk: Math.abs(entry - signal.stopLoss),
    stopWidthAtr: Math.abs(entry - signal.stopLoss) / a,
    costInR: Math.abs(entry - signal.stopLoss) > 0 ? calculateCostInR(entry, signal.stopLoss, cfg.feeBps ?? TRADING_CONFIG.feeBps, cfg.slippageBps ?? TRADING_CONFIG.slippageBps) : 0,
    ema20: e20,
    ema50: e50,
    ema100: e100,
    ema20Slope: slope(p.slice(-20)) / entry,
    ema50Slope: slope(p.slice(-50)) / entry,
    emaAlignedUp: up,
    emaAlignedDown: down,
    distEma20Atr: (entry - e20) / a,
    distEma50Atr: (entry - e50) / a,
    distVwapAtr,
    adx: adxValue,
    rsi: rrsi,
    rsiSlope: (rrsi - prevRsi) / Math.max(1, prevRsi),
    roc12: roc12v,
    roc24: roc24v,
    momentumLong,
    momentumShort,
    longDirectionalCount: longDirectional,
    shortDirectionalCount: shortDirectional,
    atr20: a,
    atr12: aFast,
    atr48: aSlow,
    atrExpansion: expansion,
    compression,
    expanding,
    currentRangeAtr: range / a,
    bollingerBandwidth: bandwidth,
    volPctOfPrice: vol,
    rangeHigh20: rangeHigh,
    rangeLow20: rangeLow,
    distTo20HighAtr: (rangeHigh - entry) / a,
    distTo20LowAtr: (entry - rangeLow) / a,
    distSwingHighAtr,
    distSwingLowAtr,
    breakoutLong: breakoutLongFlag,
    breakoutShort: breakoutShortFlag,
    pullbackLong: pullbackLongFlag,
    pullbackShort: pullbackShortFlag,
    reclaimLong: reclaimLongFlag,
    reclaimShort: reclaimShortFlag,
    bodyRatio: body,
    closeLocation: closeLoc,
    upperWickRatio: upperWick,
    lowerWickRatio: lowerWick,
    consecutiveBullish: consecutiveDirectional(bars, 1),
    consecutiveBearish: consecutiveDirectional(bars, -1),
    higherHighs: higherHighsFlag,
    higherLows: higherLowsFlag,
    lowerHighs: lowerHighsFlag,
    lowerLows: lowerLowsFlag,
    hourlyEma20: h20,
    hourlyEma40: h40,
    hourlyLong: hLong,
    hourlyShort: hShort,
    volumeRatio20: volumeRatio,
    volumePercentile20: volPercentile,
    volumeExpansion: volumeRatio >= 1.3,
  };

  if (signal.action === 'WAIT') return baseRecord;

  const capacityBars = cfg.capacityBars ?? (raw.length ? raw : []);
  const currentAtr = capacityBars.length >= 21 ? atrAt(capacityBars, capacityBars.length) : 0;
  const horizonBars = Math.max(1, Math.floor(cfg.capacityHorizonBars ?? TRADING_CONFIG.maxBarsInTrade['5m']));

  if (currentAtr > 0 && baseRecord.risk > 0) {
    const paths = simulateFourPaths(
      capacityBars,
      signal.action,
      currentAtr,
      baseRecord.risk,
      horizonBars,
      cfg.feeBps ?? TRADING_CONFIG.feeBps,
      cfg.slippageBps ?? TRADING_CONFIG.slippageBps,
      cfg.targetMultiplesR ?? [1, 1.5, 2],
    );
    if (paths) {
      return { ...baseRecord, ...paths };
    }
  }

  return baseRecord;
}
