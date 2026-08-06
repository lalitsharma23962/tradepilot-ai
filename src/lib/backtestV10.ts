import { runValidation as runV8 } from './backtestV8';
import type { BacktestConfig, ValidationReport, FoldDiagnostic } from './backtestV6';

/**
 * V10: stability-first, pre-OOS-only strategy/profile selection.
 *
 * The final OOS segment and Monte Carlo output are never used for selection.
 * A candidate must pass every pre-OOS stability fold before V10 will force it
 * into the V8 engine for the single untouched OOS evaluation.
 */
const PROFILES = [
  { rewardRisk: 1.6 },
  { rewardRisk: 2.0 },
  { rewardRisk: 2.4 },
  { rewardRisk: 2.8 },
  { rewardRisk: 3.2 },
] as const;

const MIN_PF = 1.05;
const MAX_DD = 20;
const MIN_RETURN = 0;

function minFoldTrades(report: ValidationReport): number {
  const foldSize = report.walkForward.trainBars || 0;
  return Math.max(12, Math.min(30, Math.floor(foldSize / 400)));
}

function foldsFor(report: ValidationReport, strategyId: string): FoldDiagnostic[] {
  const direct = report.foldDiagnostics?.[strategyId];
  if (Array.isArray(direct)) return direct;

  // Be tolerant of older diagnostics keyed by display name.
  const strategy = report.strategies.find((s) => s.id === strategyId);
  if (!strategy) return [];
  const byName = report.foldDiagnostics?.[strategy.name];
  return Array.isArray(byName) ? byName : [];
}

function isStable(report: ValidationReport, folds: FoldDiagnostic[]): boolean {
  const minimumTrades = minFoldTrades(report);
  return folds.length === 3 && folds.every((f) =>
    f.trades >= minimumTrades &&
    f.returnPct > MIN_RETURN &&
    f.profitFactor >= MIN_PF &&
    f.maxDrawdownPct <= MAX_DD,
  );
}

function stabilityScore(report: ValidationReport, folds: FoldDiagnostic[]): number {
  if (!isStable(report, folds)) return -Infinity;

  const pf = folds.map((f) => Math.min(f.profitFactor, 3));
  const ret = folds.map((f) => f.returnPct);
  const dd = folds.map((f) => f.maxDrawdownPct);
  const trades = folds.map((f) => f.trades);

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const min = (xs: number[]) => Math.min(...xs);
  const max = (xs: number[]) => Math.max(...xs);

  // Reward consistency, not a single exceptional fold.
  const meanPf = mean(pf);
  const meanRet = mean(ret);
  const worstRet = min(ret);
  const worstPf = min(pf);
  const worstDd = max(dd);
  const meanTrades = mean(trades);
  const retSpread = max(ret) - min(ret);
  const minimumTrades = minFoldTrades(report);

  return (
    meanPf * 30 +
    worstPf * 25 +
    meanRet * 2 +
    worstRet * 4 +
    Math.min(meanTrades / Math.max(minimumTrades, 1), 4) * 2 -
    worstDd * 0.8 -
    retSpread * 0.25
  );
}

function chooseCandidate(reports: ValidationReport[]): { reportIndex: number; strategyId: string } | null {
  let best: { reportIndex: number; strategyId: string; score: number } | null = null;

  reports.forEach((report, reportIndex) => {
    for (const strategy of report.strategies) {
      const folds = foldsFor(report, strategy.id);
      const score = stabilityScore(report, folds);
      if (!Number.isFinite(score)) continue;
      if (!best || score > best.score) {
        best = { reportIndex, strategyId: strategy.id, score };
      }
    }
  });

  return best ? { reportIndex: best.reportIndex, strategyId: best.strategyId } : null;
}

function diagnosticReason(reports: ValidationReport[]): string {
  let best: { report: ValidationReport; strategy: string; passed: number; score: number } | null = null;

  for (const report of reports) {
    for (const strategy of report.strategies) {
      const folds = foldsFor(report, strategy.id);
      if (folds.length !== 3) continue;
      const minimumTrades = minFoldTrades(report);
      const passed = folds.filter((f) =>
        f.trades >= minimumTrades &&
        f.returnPct > MIN_RETURN &&
        f.profitFactor >= MIN_PF &&
        f.maxDrawdownPct <= MAX_DD,
      ).length;
      const score = folds.reduce((sum, f) =>
        sum + Math.min(f.profitFactor, 3) * 10 + f.returnPct - f.maxDrawdownPct * 0.25,
      0);
      if (!best || passed > best.passed || (passed === best.passed && score > best.score)) {
        best = { report, strategy: strategy.name, passed, score };
      }
    }
  }

  if (!best) return 'No strategy produced complete pre-OOS fold diagnostics.';
  const minimumTrades = minFoldTrades(best.report);
  return `No strategy passed all 3 pre-OOS stability folds. Closest candidate: ${best.strategy} (${best.passed}/3 folds passed; minimum ${minimumTrades} trades/fold, PF >= ${MIN_PF}, positive return, DD <= ${MAX_DD}%).`;
}

export async function runValidation(
  symbol = 'BTCUSDT',
  interval = '1h',
  cfg: Partial<BacktestConfig> = {},
  selectedStrategyId?: string,
): Promise<ValidationReport> {
  // If the UI/operator explicitly asks for a strategy, preserve that request;
  // V8 still applies the unchanged hard validation gate and untouched OOS test.
  if (selectedStrategyId) {
    return runV8(symbol, interval, { ...cfg, rewardRisk: PROFILES[0].rewardRisk }, selectedStrategyId);
  }

  // First pass: evaluate every exit profile independently. Only pre-OOS fold
  // diagnostics are inspected here. The untouched final OOS segment is never
  // used to choose a profile or strategy.
  const reports: ValidationReport[] = [];
  for (const profile of PROFILES) {
    reports.push(await runV8(symbol, interval, { ...cfg, rewardRisk: profile.rewardRisk }));
  }

  const candidate = chooseCandidate(reports);
  if (!candidate) {
    // Nothing demonstrated stable pre-OOS behavior. Return the most useful
    // diagnostic report, but do not manufacture an eligible strategy or run
    // an OOS test for a strategy that failed the stability screen.
    const diagnostic = [...reports].sort((a, b) => {
      const score = (r: ValidationReport) => {
        const values = Object.values(r.foldDiagnostics ?? {}).flat();
        if (!values.length) return -Infinity;
        const passed = values.filter((f) => f.passed).length;
        const avgPf = values.reduce((s, f) => s + Math.min(f.profitFactor, 3), 0) / values.length;
        const avgRet = values.reduce((s, f) => s + f.returnPct, 0) / values.length;
        return passed * 100 + avgPf * 10 + avgRet;
      };
      return score(b) - score(a);
    })[0];

    return {
      ...diagnostic,
      walkForward: {
        ...diagnostic.walkForward,
        selectedStrategy: '',
        validation: null,
        test: null,
      },
      gate: {
        ...diagnostic.gate,
        status: 'REJECTED',
        reasons: [
          diagnosticReason(reports),
          ...diagnostic.gate.reasons.filter((r) => !r.toLowerCase().includes('selected strategy')),
        ],
      },
    };
  }

  // Second pass: re-run V8 once for the winning pre-OOS-only strategy/profile.
  // V8 performs the one untouched final OOS test and Monte Carlo gate.
  return runV8(
    symbol,
    interval,
    { ...cfg, rewardRisk: PROFILES[candidate.reportIndex].rewardRisk },
    candidate.strategyId,
  );
}

export * from './backtestV8';
