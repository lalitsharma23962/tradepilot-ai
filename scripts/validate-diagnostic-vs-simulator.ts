/**
 * Deterministic validation harness:
 * compares simulateSingleEpisode() (the diagnostic building block) against an
 * inline, exact replica of backtestV11.ts per-trade execution for synthetic
 * episodes covering all four paths.
 *
 * Run with:
 *   npx tsx scripts/validate-diagnostic-vs-simulator.ts
 */
import { simulateSingleEpisode } from '../src/lib/strategyV35Diagnostics';
import type { MarketBar } from '../src/lib/marketData';

interface Episode {
  name: string;
  bars: MarketBar[];
  signalIndex: number;
  side: 'LONG' | 'SHORT';
  stopDistance: number;
  horizonBars: number;
  feeBps: number;
  slippageBps: number;
}

interface SimRow {
  name: string;
  path: string;
  diagGrossR: number;
  simGrossR: number;
  diagCostR: number;
  simCostR: number;
  diagNetR: number;
  simNetR: number;
  deltaR: number;
}

const FEE_BPS = 10;
const SLIP_BPS = 2;
const ENTRY = 50000;
const ATR = 500; // 1% ATR
const RISK = 1 * ATR; // 1 ATR stop

function bar(o: number, h: number, l: number, c: number, v = 1): MarketBar {
  return { openTime: Date.now(), open: o, high: h, low: l, close: c, volume: v };
}

/**
 * Inline exact replica of backtestV11.ts per-trade execution for one episode.
 * Mirrors:
 *   entry = next open * (1 + side*slip)
 *   stop-first check
 *   TP1/TP2/TP3 partial exits with slippage and fees
 *   breakeven after TP1, +0.5R after TP2
 *   runner-protected stop ratchet
 *   timeout at horizon end
 */
function simulateBacktestReplica(e: Episode): { grossR: number; costR: number; netR: number; path: 'P0' | 'P1' | 'P2' | 'P3' } {
  const completed = e.bars;
  const runnerSide = e.side === 'LONG' ? 1 : -1;
  const fee = e.feeBps / 10000;
  const slip = e.slippageBps / 10000;
  const targetMultiples = [1, 1.5, 2];
  const allocations = [0.25, 0.25, 0.5];

  const fillBar = completed[e.signalIndex + 1];
  const entry = fillBar.open * (1 + runnerSide * slip);
  const initialStop = entry - runnerSide * e.stopDistance;
  const finalTargetPrice = entry + runnerSide * e.stopDistance * targetMultiples.at(-1)!;

  const initialQty = 1;
  let remainingQty = initialQty;
  let realizedGross = 0;
  let realizedFees = 0;
  let simulatedStop = initialStop;
  let stage = 0;
  let outcome: 'P0' | 'P1' | 'P2' | 'P3' = 'P0';

  for (let j = 1; j <= e.horizonBars; j++) {
    const b = completed[e.signalIndex + j];
    if (!b) break;

    const hitStop = e.side === 'LONG' ? b.low <= simulatedStop : b.high >= simulatedStop;
    if (hitStop) {
      const exit = simulatedStop * (1 - runnerSide * slip);
      realizedGross += runnerSide * (exit - entry) * remainingQty;
      realizedFees += (Math.abs(entry * remainingQty) + Math.abs(exit * remainingQty)) * fee;
      outcome = `P${stage}` as 'P0' | 'P1' | 'P2' | 'P3';
      break;
    }

    while (stage < targetMultiples.length) {
      const target = entry + runnerSide * e.stopDistance * targetMultiples[stage];
      const hitTarget = e.side === 'LONG' ? b.high >= target : b.low <= target;
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
      else if (stage === 2) simulatedStop = entry + runnerSide * e.stopDistance * 0.5;

      if (remainingQty <= Math.max(initialQty * 1e-9, 1e-12)) {
        outcome = 'P3';
        break;
      }
    }

    if (outcome === 'P3') break;

    // Runner protection (same logic as src/lib/runnerProtection.ts)
    const targetDistance = Math.abs(finalTargetPrice - entry);
    const favorable = runnerSide === 1 ? b.high - entry : entry - b.low;
    const favorableTargetFraction = favorable / targetDistance;
    const RUNNER_BREAKEVEN_TARGET_FRACTION = 0.10;
    const RUNNER_LOCK_TARGET_FRACTION = 0.20;
    const RUNNER_LOCK_KEEP_TARGET_FRACTION = 0.05;
    const RUNNER_TRAIL_START_TARGET_FRACTION = 0.30;
    const RUNNER_TRAIL_GIVEBACK_TARGET_FRACTION = 0.10;
    const RUNNER_COST_BUFFER_TARGET_FRACTION = 0.003;
    let desired = simulatedStop;
    if (favorableTargetFraction >= RUNNER_TRAIL_START_TARGET_FRACTION) {
      desired = entry + runnerSide * (favorableTargetFraction - RUNNER_TRAIL_GIVEBACK_TARGET_FRACTION) * targetDistance;
    } else if (favorableTargetFraction >= RUNNER_LOCK_TARGET_FRACTION) {
      desired = entry + runnerSide * RUNNER_LOCK_KEEP_TARGET_FRACTION * targetDistance;
    } else if (favorableTargetFraction >= RUNNER_BREAKEVEN_TARGET_FRACTION) {
      desired = entry + runnerSide * RUNNER_COST_BUFFER_TARGET_FRACTION * targetDistance;
    }
    simulatedStop = runnerSide === 1 ? Math.max(simulatedStop, desired) : Math.min(simulatedStop, desired);

    if (j === e.horizonBars) {
      const exit = b.close * (1 - runnerSide * slip);
      realizedGross += runnerSide * (exit - entry) * remainingQty;
      realizedFees += (Math.abs(entry * remainingQty) + Math.abs(exit * remainingQty)) * fee;
      outcome = `P${stage}` as 'P0' | 'P1' | 'P2' | 'P3';
    }
  }

  return {
    grossR: realizedGross / e.stopDistance,
    costR: realizedFees / e.stopDistance,
    netR: (realizedGross - realizedFees) / e.stopDistance,
    path: outcome,
  };
}

function runValidation(): void {
  const lookback = 80;
  const signalIndex = lookback - 1;
  const baseHistory = Array.from({ length: lookback }, () => bar(ENTRY, ENTRY + ATR, ENTRY - ATR, ENTRY));

  const makeEpisode = (name: string, side: 'LONG' | 'SHORT', extraBars: MarketBar[]): Episode => ({
    name,
    bars: [...baseHistory, ...extraBars],
    signalIndex,
    side,
    stopDistance: RISK,
    horizonBars: extraBars.length,
    feeBps: FEE_BPS,
    slippageBps: SLIP_BPS,
  });

  const episodes: Episode[] = [
    makeEpisode('P0 LONG stop before TP1', 'LONG', [
      bar(ENTRY, ENTRY, ENTRY - RISK * 1.2, ENTRY - RISK * 1.2),
    ]),
    makeEpisode('P1 LONG TP1 then BE stop', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 1.2, ENTRY, ENTRY + RISK * 0.5),
      bar(ENTRY + RISK * 0.5, ENTRY + RISK * 0.5, ENTRY - RISK * 0.1, ENTRY),
    ]),
    makeEpisode('P2 LONG TP1+TP2 then +0.5R stop', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 1.6, ENTRY, ENTRY + RISK * 1.2),
      bar(ENTRY + RISK * 1.2, ENTRY + RISK * 1.2, ENTRY + RISK * 0.4, ENTRY + RISK * 0.6),
    ]),
    makeEpisode('P3 LONG full ladder', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 2.2, ENTRY, ENTRY + RISK * 2.1),
    ]),
    makeEpisode('P0 SHORT stop before TP1', 'SHORT', [
      bar(ENTRY, ENTRY + RISK * 1.2, ENTRY, ENTRY + RISK * 1.2),
    ]),
    makeEpisode('P1 SHORT TP1 then BE stop', 'SHORT', [
      bar(ENTRY, ENTRY, ENTRY - RISK * 1.2, ENTRY - RISK * 0.5),
      bar(ENTRY - RISK * 0.5, ENTRY + RISK * 0.1, ENTRY - RISK * 0.5, ENTRY),
    ]),
    makeEpisode('P2 SHORT TP1+TP2 then +0.5R stop', 'SHORT', [
      bar(ENTRY, ENTRY, ENTRY - RISK * 1.6, ENTRY - RISK * 1.2),
      bar(ENTRY - RISK * 1.2, ENTRY - RISK * 0.4, ENTRY - RISK * 1.2, ENTRY - RISK * 0.6),
    ]),
    makeEpisode('P3 SHORT full ladder', 'SHORT', [
      bar(ENTRY, ENTRY, ENTRY - RISK * 2.2, ENTRY - RISK * 2.1),
    ]),
    makeEpisode('P3 LONG same-candle TP1/TP2/TP3', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 3, ENTRY, ENTRY + RISK * 2.5),
    ]),
    makeEpisode('P0 LONG same-candle TP1 and stop (stop-first)', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 1.2, ENTRY - RISK * 1.2, ENTRY),
    ]),
    makeEpisode('P2 LONG runner ratchet before TP2 stop', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 0.05, ENTRY, ENTRY + RISK * 0.04), // 10% favorable -> runner moves stop to BE+0.006R
      bar(ENTRY + RISK * 0.04, ENTRY + RISK * 0.04, ENTRY + RISK * 0.005, ENTRY + RISK * 0.01), // hits runner stop
    ]),
  ];

  const rows: SimRow[] = [];
  for (const e of episodes) {
    const diag = simulateSingleEpisode(
      e.bars,
      e.signalIndex,
      e.side,
      e.stopDistance,
      e.horizonBars,
      e.feeBps,
      e.slippageBps,
    )!;
    const sim = simulateBacktestReplica(e);

    rows.push({
      name: e.name,
      path: diag.path,
      diagGrossR: diag.grossR,
      simGrossR: sim.grossR,
      diagCostR: diag.costR,
      simCostR: sim.costR,
      diagNetR: diag.netR,
      simNetR: sim.netR,
      deltaR: Math.abs(diag.netR - sim.netR),
    });
  }

  console.table(rows);
  const mae = rows.reduce((s, r) => s + r.deltaR, 0) / rows.length;
  const maxe = Math.max(...rows.map((r) => r.deltaR));
  console.log(`\nMean absolute error: ${mae.toFixed(6)}R`);
  console.log(`Max absolute error:  ${maxe.toFixed(6)}R`);

  if (mae > 0.01 || maxe > 0.01) {
    console.error('\nVALIDATION FAILED: diagnostic vs simulator mismatch > 0.01R');
    process.exit(1);
  } else {
    console.log('\nVALIDATION PASSED: diagnostic matches simulator within 0.01R');
  }
}

runValidation();
