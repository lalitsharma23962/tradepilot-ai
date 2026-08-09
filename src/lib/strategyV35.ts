import { evaluateProductionStrategy as evaluateEntryStrategy, type StrategyConfig, type StrategySignal } from './strategyV32';
export type { StrategyConfig, StrategySignal } from './strategyV32';
import type { MarketBar } from './marketData';
import { TRADING_CONFIG } from './tradingConfig';
import { runnerProtectedStop } from './runnerProtection';

const ENTRY_MIN_R = 1.5;
const ENTRY_MAX_R = 3;
const RESEARCH_MIN_R = TRADING_CONFIG.researchMinRiskReward;
const RESEARCH_MAX_R = TRADING_CONFIG.researchMaxRiskReward;
const DEFAULT_CAPACITY_HORIZON = TRADING_CONFIG.maxBarsInTrade['5m'];
export const MIN_INDEPENDENT_SAMPLES = 20;

const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
const percentile = (v: number[], q: number) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const x = (s.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(x), hi = Math.ceil(x);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (x - lo);
};
const atrAt = (bars: MarketBar[], endExclusive: number, period = 20) => {
  const start = Math.max(1, endExclusive - period);
  const ranges: number[] = [];
  for (let i = start; i < endExclusive; i++) {
    const b = bars[i], p = bars[i - 1];
    ranges.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  return mean(ranges);
};
interface CapacityEvidence { capacityPrice: number; targetBeforeStopRate: number; samples: number; }

/**
 * v35 extreme-R feasibility uses only completed historical forward paths.
 * The simulated stop ratchet deliberately mirrors the shared execution helper:
 * current stop/target are checked first for each bar, then runner protection is
 * applied for the next bar. This keeps the research gate causal and execution-parity.
 */
function independentPathCapacity(input: number[] | MarketBar[], side: 'LONG' | 'SHORT', currentAtr: number, currentRisk: number, targetR: number, horizonBars: number, capacityQuantile: number): CapacityEvidence {
  const unavailable: CapacityEvidence = { capacityPrice: 0, targetBeforeStopRate: 0, samples: 0 };
  if (!input.length || typeof input[0] === 'number' || !(currentAtr > 0) || !(currentRisk > 0) || horizonBars < 1) return unavailable;
  const bars = input as MarketBar[];
  const requiredLookback = MIN_INDEPENDENT_SAMPLES * horizonBars;
  if (bars.length < horizonBars + requiredLookback + 21) return unavailable;
  const completed = bars.slice(0, -1);
  const last = completed.length - horizonBars;
  const first = Math.max(20, last - requiredLookback);
  if (last <= first) return unavailable;
  const currentRiskAtr = currentRisk / currentAtr;
  if (!Number.isFinite(currentRiskAtr) || currentRiskAtr <= 0) return unavailable;
  const excursions: number[] = [];
  let targetBeforeStop = 0;
  let samples = 0;
  const runnerSide = side === 'LONG' ? 1 : -1;

  for (let i = last - 1; i >= first; i -= horizonBars) {
    const atr = atrAt(completed, i + 1);
    if (!(atr > 0) || !Number.isFinite(atr)) continue;
    const start = completed[i].close;
    const stopDistance = currentRiskAtr * atr;
    const targetDistance = targetR * stopDistance;
    if (!(stopDistance > 0) || !(targetDistance > 0)) continue;

    let mfe = 0;
    let simulatedStop = runnerSide === 1 ? start - stopDistance : start + stopDistance;
    const simulatedTarget = runnerSide === 1 ? start + targetDistance : start - targetDistance;
    let outcome: 'TARGET' | 'STOP' | 'TIMEOUT' = 'TIMEOUT';

    for (let j = 1; j <= horizonBars; j++) {
      const b = completed[i + j];
      const favorable = side === 'LONG' ? b.high - start : start - b.low;
      mfe = Math.max(mfe, favorable);

      // Match backtest execution ordering: an existing stop/target is tested
      // before the runner helper is allowed to ratchet the stop for this bar.
      const hitStop = side === 'LONG' ? b.low <= simulatedStop : b.high >= simulatedStop;
      const hitTarget = side === 'LONG' ? b.high >= simulatedTarget : b.low <= simulatedTarget;
      if (hitStop) { outcome = 'STOP'; break; }
      if (hitTarget) { outcome = 'TARGET'; break; }

      simulatedStop = runnerProtectedStop(
        runnerSide,
        start,
        simulatedTarget,
        simulatedStop,
        b.high,
        b.low,
      );
    }

    excursions.push(mfe / atr);
    samples++;
    if (outcome === 'TARGET') targetBeforeStop++;
  }

  if (samples < MIN_INDEPENDENT_SAMPLES) return unavailable;
  const capacityAtr = percentile(excursions, capacityQuantile);
  return { capacityPrice: Number.isFinite(capacityAtr) && capacityAtr > 0 ? currentAtr * capacityAtr : 0, targetBeforeStopRate: targetBeforeStop / samples, samples };
}

export function evaluateProductionStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignal {
  const minEntryScore = TRADING_CONFIG.minScore;
  const ultraScore = TRADING_CONFIG.ultraScore;
  const extendedConfig = config as Partial<StrategyConfig> & { capacityBars?: MarketBar[] };
  const entrySignal = evaluateEntryStrategy(input, {
    ...config,
    minScore: Math.max(minEntryScore, config.minScore ?? minEntryScore),
    minRiskReward: ENTRY_MIN_R,
    maxRiskReward: ENTRY_MAX_R,
    riskReward: undefined,
    // v35 owns the authoritative independent extreme-R capacity test.
    skipLegacyPathCapacity: true,
  });
  if (entrySignal.action === 'WAIT') return entrySignal;
  const risk = Math.abs(entrySignal.entry - entrySignal.stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return { ...entrySignal, action: 'WAIT', strategy: 'No Trade', reasons: [...entrySignal.reasons, 'Invalid structural risk distance'] };
  const targetR = entrySignal.score >= ultraScore ? RESEARCH_MAX_R : RESEARCH_MIN_R;
  const targetDistance = risk * targetR;
  const roundTripCost = 2 * ((config.feeBps ?? TRADING_CONFIG.feeBps) + (config.slippageBps ?? TRADING_CONFIG.slippageBps)) / 10000;
  const costInR = risk > 0 ? roundTripCost * entrySignal.entry / risk : Infinity;
  const pfFloor = TRADING_CONFIG.minProfitFactor;
  const economicHitRate = Number.isFinite(costInR) ? (pfFloor * (1 + costInR)) / ((targetR - costInR) + pfFloor * (1 + costInR)) : 1;
  const requiredHitRate = Math.max(0, Math.min(1, economicHitRate));
  const capacityBars = extendedConfig.capacityBars ?? input;
  const currentAtr = independentCurrentAtr(capacityBars);
  const horizonBars = Math.max(1, Math.floor(config.capacityHorizonBars ?? DEFAULT_CAPACITY_HORIZON));
  const capacityQuantile = 1 - requiredHitRate;
  const evidence = independentPathCapacity(capacityBars, entrySignal.action, currentAtr, risk, targetR, horizonBars, capacityQuantile);
  const capacityPass = Number.isFinite(evidence.capacityPrice) && evidence.capacityPrice > 0 && targetDistance <= evidence.capacityPrice;
  const pathOrderPass = evidence.samples >= MIN_INDEPENDENT_SAMPLES && evidence.targetBeforeStopRate >= requiredHitRate;
  if (!capacityPass || !pathOrderPass) {
    if (config.funnel) config.funnel.rejectedPathCapacity++;
    return { ...entrySignal, action: 'WAIT', strategy: 'No Trade', takeProfit: entrySignal.entry, riskReward: 0, pathCapacity: evidence.capacityPrice, reasons: [...entrySignal.reasons, `${targetR}R target requires ${targetDistance.toFixed(2)} price distance`, `Independent excursion capacity ${evidence.capacityPrice > 0 ? evidence.capacityPrice.toFixed(2) : 'unavailable'} over ${horizonBars} bars`, `Historical target-before-stop rate ${(evidence.targetBeforeStopRate * 100).toFixed(1)}% vs required ${(requiredHitRate * 100).toFixed(1)}% (${evidence.samples} samples)`] };
  }
  const takeProfit = entrySignal.action === 'LONG' ? entrySignal.entry + targetDistance : entrySignal.entry - targetDistance;
  return { ...entrySignal, strategy: 'Production Regime Breakout v35', takeProfit, riskReward: targetR, pathCapacity: evidence.capacityPrice, reasons: [...entrySignal.reasons.filter(reason => !reason.startsWith('Target ')), 'A+ entry qualified independently from extreme-R research target', `Research target ${targetR}R assigned after entry qualification`, `Independent capacity ${evidence.capacityPrice.toFixed(2)} supports ${targetDistance.toFixed(2)} target distance`, `Historical target-before-stop rate ${(evidence.targetBeforeStopRate * 100).toFixed(1)}% clears ${(requiredHitRate * 100).toFixed(1)}% economic threshold`] };
}

function independentCurrentAtr(input: number[] | MarketBar[]): number {
  if (!input.length || typeof input[0] === 'number') return 0;
  const bars = input as MarketBar[];
  return bars.length >= 21 ? atrAt(bars, bars.length) : 0;
}
export function evaluateResearchStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignal { return evaluateProductionStrategy(input, config); }
export function evaluateStrategy(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignal { return evaluateProductionStrategy(input, config); }
