import { evaluateProductionStrategy as evaluateEntryStrategy, type StrategyConfig, type StrategySignal } from './strategyV32';
export type { StrategyConfig, StrategySignal } from './strategyV32';
import type { MarketBar } from './marketData';
import { TRADING_CONFIG } from './tradingConfig';

/**
 * v35: qualify the entry with the proven v32 model first, then assign the
 * research target. v35 never weakens the entry gate just to manufacture a
 * 10R/15R trade, and never silently downgrades an infeasible target.
 *
 * Target feasibility is deliberately measured independently from v32's
 * score inputs. v32's old pathCapacity formula reused efficiency, separation
 * and expansion values that also contribute to entry qualification, so it
 * could answer a different question than "has this market historically shown
 * enough directional travel for this target?".
 */
const ENTRY_MIN_R = 1.5;
const ENTRY_MAX_R = 3;
const RESEARCH_MIN_R = TRADING_CONFIG.researchMinRiskReward;
const RESEARCH_MAX_R = TRADING_CONFIG.researchMaxRiskReward;
const CAPACITY_LOOKBACK = 240;
const CAPACITY_HORIZON = 48;
const CAPACITY_QUANTILE = 0.80;

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const percentile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
};
const atrAt = (bars: MarketBar[], endExclusive: number, period = 20) => {
  const start = Math.max(1, endExclusive - period);
  const ranges: number[] = [];
  for (let i = start; i < endExclusive; i++) {
    const b = bars[i], prev = bars[i - 1];
    ranges.push(Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)));
  }
  return mean(ranges);
};

/**
 * Estimate directional travel from already-completed historical windows.
 *
 * At decision time the latest bar is excluded. Each historical sample uses
 * only bars that were already known at that historical starting point, and
 * the current signal's score variables never enter the calculation. This is
 * therefore a forward-excursion statistic over the past, not look-ahead into
 * the current trade's future.
 */
function independentPathCapacity(input: number[] | MarketBar[], side: 'LONG' | 'SHORT', currentAtr: number): number {
  if (!input.length || typeof input[0] === 'number' || !(currentAtr > 0)) return 0;
  const bars = input as MarketBar[];
  const completed = bars.slice(0, -1);
  if (completed.length < CAPACITY_HORIZON + 40) return 0;

  const first = Math.max(20, completed.length - CAPACITY_LOOKBACK - CAPACITY_HORIZON);
  const last = completed.length - CAPACITY_HORIZON;
  const samples: number[] = [];

  for (let i = first; i < last; i++) {
    const atr = atrAt(completed, i + 1);
    if (!(atr > 0) || !Number.isFinite(atr)) continue;
    const start = completed[i].close;
    let mfe = 0;
    for (let j = 1; j <= CAPACITY_HORIZON; j++) {
      const bar = completed[i + j];
      const favorable = side === 'LONG' ? bar.high - start : start - bar.low;
      mfe = Math.max(mfe, favorable);
    }
    if (Number.isFinite(mfe) && mfe > 0) samples.push(mfe / atr);
  }

  if (samples.length < 20) return 0;
  const capacityAtr = percentile(samples, CAPACITY_QUANTILE);
  return Number.isFinite(capacityAtr) && capacityAtr > 0 ? currentAtr * capacityAtr : 0;
}

export function evaluateProductionStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {},
): StrategySignal {
  const minEntryScore = TRADING_CONFIG.minScore;
  const ultraScore = TRADING_CONFIG.ultraScore;

  const entrySignal = evaluateEntryStrategy(input, {
    ...config,
    minScore: Math.max(minEntryScore, config.minScore ?? minEntryScore),
    minRiskReward: ENTRY_MIN_R,
    maxRiskReward: ENTRY_MAX_R,
    riskReward: undefined,
  });

  if (entrySignal.action === 'WAIT') return entrySignal;

  const risk = Math.abs(entrySignal.entry - entrySignal.stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) {
    return {
      ...entrySignal,
      action: 'WAIT',
      strategy: 'No Trade',
      reasons: [...entrySignal.reasons, 'Invalid structural risk distance'],
    };
  }

  const targetR = entrySignal.score >= ultraScore ? RESEARCH_MAX_R : RESEARCH_MIN_R;
  const targetDistance = risk * targetR;
  const currentAtr = independentCurrentAtr(input);
  const independentCapacity = independentPathCapacity(input, entrySignal.action, currentAtr);

  // v35's research target is now checked against historical directional
  // excursion that is independent of the score/entry features. The old v32
  // pathCapacity remains useful for v32's own 1.5R-3R entry qualification,
  // but it is no longer the authority for the 10R/15R research target.
  if (!Number.isFinite(independentCapacity) || independentCapacity <= 0 || targetDistance > independentCapacity) {
    if (config.funnel) {
      config.funnel.rejectedPathCapacity++;
      // v32 increments this bucket before v35 applies the research-target
      // feasibility check. Undo that provisional count for v35-rejected
      // signals so "signals opened" means actually accepted by v35.
      config.funnel.tradesOpened = Math.max(0, config.funnel.tradesOpened - 1);
    }
    return {
      ...entrySignal,
      action: 'WAIT',
      strategy: 'No Trade',
      takeProfit: entrySignal.entry,
      riskReward: 0,
      pathCapacity: independentCapacity,
      reasons: [
        ...entrySignal.reasons,
        `${targetR}R target (${targetDistance.toFixed(2)}) exceeds independent historical capacity (${independentCapacity > 0 ? independentCapacity.toFixed(2) : 'unavailable'})`,
      ],
    };
  }

  const takeProfit = entrySignal.action === 'LONG'
    ? entrySignal.entry + targetDistance
    : entrySignal.entry - targetDistance;

  return {
    ...entrySignal,
    strategy: 'Production Regime Breakout v35',
    takeProfit,
    riskReward: targetR,
    pathCapacity: independentCapacity,
    reasons: [
      ...entrySignal.reasons.filter(reason => !reason.startsWith('Target ')),
      'A+ entry qualified independently from extreme-R research target',
      `Research target ${targetR}R assigned after entry qualification`,
      `Independent historical capacity ${independentCapacity.toFixed(2)} supports target distance ${targetDistance.toFixed(2)}`,
    ],
  };
}

function independentCurrentAtr(input: number[] | MarketBar[]): number {
  if (!input.length || typeof input[0] === 'number') return 0;
  const bars = input as MarketBar[];
  if (bars.length < 21) return 0;
  return atrAt(bars, bars.length);
}

export function evaluateResearchStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {},
): StrategySignal {
  return evaluateProductionStrategy(input, config);
}

export function evaluateStrategy(
  input: number[] | MarketBar[],
  config: Partial<StrategyConfig> = {},
): StrategySignal {
  return evaluateProductionStrategy(input, config);
}
