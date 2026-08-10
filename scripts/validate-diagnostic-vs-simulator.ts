/**
 * Deterministic validation harness:
 * compares simulateSingleEpisode() (the diagnostic building block) against an
 * inline, exact replica of backtestV11.ts per-trade execution for synthetic
 * episodes covering all four paths plus runner-ratchet and timeout cases.
 *
 * Run with:
 *   npx tsx scripts/validate-diagnostic-vs-simulator.ts
 */
import { simulateSingleEpisode, type EpisodeOutcome } from '../src/lib/strategyV35Diagnostics';
import { runnerProtectedStop } from '../src/lib/runnerProtection';
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
  diagOutcome: EpisodeOutcome;
  simOutcome: EpisodeOutcome;
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
 *   runner-protected stop ratchet (imported from runnerProtection.ts)
 *   timeout at horizon end
 */
function simulateBacktestReplica(e: Episode): { grossR: number; costR: number; netR: number; outcome: EpisodeOutcome } {
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
  let outcome: EpisodeOutcome = 'TIMEOUT_0';

  for (let j = 1; j <= e.horizonBars; j++) {
    const b = completed[e.signalIndex + j];
    if (!b) break;

    const hitStop = e.side === 'LONG' ? b.low <= simulatedStop : b.high >= simulatedStop;
    if (hitStop) {
      const exit = simulatedStop * (1 - runnerSide * slip);
      realizedGross += runnerSide * (exit - entry) * remainingQty;
      realizedFees += (Math.abs(entry * remainingQty) + Math.abs(exit * remainingQty)) * fee;
      outcome = stage === 0 ? 'STOP_0' : stage === 1 ? 'STOP_1' : 'STOP_2';
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
        outcome = 'TP3';
        break;
      }
    }

    if (outcome === 'TP3') break;

    // Runner protection: use the same implementation as the simulator.
    simulatedStop = runnerProtectedStop(runnerSide, entry, finalTargetPrice, simulatedStop, b.high, b.low);

    if (j === e.horizonBars) {
      const exit = b.close * (1 - runnerSide * slip);
      realizedGross += runnerSide * (exit - entry) * remainingQty;
      realizedFees += (Math.abs(entry * remainingQty) + Math.abs(exit * remainingQty)) * fee;
      outcome = stage === 0 ? 'TIMEOUT_0' : stage === 1 ? 'TIMEOUT_1' : 'TIMEOUT_2';
    }
  }

  return {
    grossR: realizedGross / e.stopDistance,
    costR: realizedFees / e.stopDistance,
    netR: (realizedGross - realizedFees) / e.stopDistance,
    outcome,
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
    makeEpisode('STOP_0 LONG stop before TP1', 'LONG', [
      bar(ENTRY, ENTRY, ENTRY - RISK * 1.2, ENTRY - RISK * 1.2),
    ]),
    makeEpisode('STOP_1 LONG TP1 then BE stop', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 1.2, ENTRY, ENTRY + RISK * 0.5),
      bar(ENTRY + RISK * 0.5, ENTRY + RISK * 0.5, ENTRY - RISK * 0.1, ENTRY),
    ]),
    makeEpisode('STOP_2 LONG TP1+TP2 then +0.5R stop', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 1.6, ENTRY, ENTRY + RISK * 1.2),
      bar(ENTRY + RISK * 1.2, ENTRY + RISK * 1.2, ENTRY + RISK * 0.4, ENTRY + RISK * 0.6),
    ]),
    makeEpisode('TP3 LONG full ladder', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 2.2, ENTRY, ENTRY + RISK * 2.1),
    ]),
    makeEpisode('STOP_0 SHORT stop before TP1', 'SHORT', [
      bar(ENTRY, ENTRY + RISK * 1.2, ENTRY, ENTRY + RISK * 1.2),
    ]),
    makeEpisode('STOP_1 SHORT TP1 then BE stop', 'SHORT', [
      bar(ENTRY, ENTRY, ENTRY - RISK * 1.2, ENTRY - RISK * 0.5),
      bar(ENTRY - RISK * 0.5, ENTRY + RISK * 0.1, ENTRY - RISK * 0.5, ENTRY),
    ]),
    makeEpisode('STOP_2 SHORT TP1+TP2 then +0.5R stop', 'SHORT', [
      bar(ENTRY, ENTRY, ENTRY - RISK * 1.6, ENTRY - RISK * 1.2),
      bar(ENTRY - RISK * 1.2, ENTRY - RISK * 0.4, ENTRY - RISK * 1.2, ENTRY - RISK * 0.6),
    ]),
    makeEpisode('TP3 SHORT full ladder', 'SHORT', [
      bar(ENTRY, ENTRY, ENTRY - RISK * 2.2, ENTRY - RISK * 2.1),
    ]),
    makeEpisode('TP3 LONG same-candle TP1/TP2/TP3', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 3, ENTRY, ENTRY + RISK * 2.5),
    ]),
    makeEpisode('STOP_0 LONG same-candle TP1 and stop (stop-first)', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 1.2, ENTRY - RISK * 1.2, ENTRY),
    ]),
    makeEpisode('STOP_2 LONG runner ratchet before TP2 stop', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 0.05, ENTRY, ENTRY + RISK * 0.04), // 10% favorable -> runner moves stop to BE+0.006R
      bar(ENTRY + RISK * 0.04, ENTRY + RISK * 0.04, ENTRY + RISK * 0.005, ENTRY + RISK * 0.01), // hits runner stop
    ]),
    makeEpisode('TIMEOUT_0 LONG no move', 'LONG', [
      bar(ENTRY, ENTRY + RISK * 0.5, ENTRY - RISK * 0.5, ENTRY),
    ]),
  ];

  const rows: SimRow[] = [];
  let passed = 0;
  let failed = 0;
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
    const outcomeMatch = diag.outcome === sim.outcome;
    const deltaR = Math.abs(diag.netR - sim.netR);
    if (outcomeMatch && deltaR <= 0.01) passed++;
    else failed++;

    rows.push({
      name: e.name,
      diagOutcome: diag.outcome,
      simOutcome: sim.outcome,
      diagGrossR: diag.grossR,
      simGrossR: sim.grossR,
      diagCostR: diag.costR,
      simCostR: sim.costR,
      diagNetR: diag.netR,
      simNetR: sim.netR,
      deltaR,
    });
  }

  console.table(rows);
  const mae = rows.reduce((s, r) => s + r.deltaR, 0) / rows.length;
  const maxe = Math.max(...rows.map((r) => r.deltaR));
  console.log(`\nEpisodes: ${rows.length}`);
  console.log(`Passed:   ${passed}`);
  console.log(`Failed:   ${failed}`);
  console.log(`Mean absolute error: ${mae.toFixed(6)}R`);
  console.log(`Max absolute error:  ${maxe.toFixed(6)}R`);

  if (failed > 0 || mae > 0.01 || maxe > 0.01) {
    console.error('\nVALIDATION FAILED');
    process.exit(1);
  } else {
    console.log('\nVALIDATION PASSED');
  }
}

runValidation();
