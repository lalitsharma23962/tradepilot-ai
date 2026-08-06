import { runValidation as runV8 } from './backtestV8';
import type { BacktestConfig, ValidationReport, FoldDiagnostic } from './backtestV6';

/**
 * V11: robustness-first, pre-OOS-only profile selection.
 *
 * The final 30% OOS segment and Monte Carlo output are never used to select
 * a strategy/profile. A candidate must pass all three non-overlapping
 * pre-OOS stability folds before V8 is allowed to run the untouched OOS test.
 *
 * This version expands the exit/risk profile search because V10 proved that
 * the original five reward-risk profiles were not sufficient to find a
 * strategy that was stable across all three pre-OOS folds.
 */
const PROFILES = [
  { rewardRisk: 1.6, stopAtr: 1.25 },
  { rewardRisk: 2.0, stopAtr: 1.25 },
  { rewardRisk: 2.4, stopAtr: 1.25 },
  { rewardRisk: 1.6, stopAtr: 1.50 },
  { rewardRisk: 2.0, stopAtr: 1.50 },
  { rewardRisk: 2.4, stopAtr: 1.50 },
  { rewardRisk: 1.6, stopAtr: 1.75 },
  { rewardRisk: 2.0, stopAtr: 1.75 },
  { rewardRisk: 2.4, stopAtr: 1.75 },
  { rewardRisk: 1.6, stopAtr: 2.00 },
  { rewardRisk: 2.0, stopAtr: 2.00 },
  { rewardRisk: 2.4, stopAtr: 2.00 },
  { rewardRisk: 2.0, stopAtr: 2.25 },
  { rewardRisk: 2.4, stopAtr: 2.25 },
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

  const meanPf = mean(pf);
  const worstPf = min(pf);
  const meanRet = mean(ret);
  const worstRet = min(ret);
  const worstDd = max(dd);
  const meanTrades = mean(trades);
  const retSpread = max(ret) - min(ret);
  const ddSpread = max(dd) - min(dd);
  const minimumTrades = minFoldTrades(report);

  // Prefer a profile that is good in its weakest fold, not one that wins by
  // having a single exceptional fold. Drawdown and return dispersion are
  // explicitly penalized to reduce regime-specific overfitting.
  return (
    worstRet * 5 +
    worstPf * 30 +
    meanPf * 15 +
    meanRet * 1.5 +
    Math.min(meanTrades / Math.max(minimumTrades, 1), 4) * 2 -
    worstDd * 0.9 -
    retSpread * 0.35 -
    ddSpread * 0.15
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
        sum + Math.min(f.profitFactor, 3) * 10 + f.returnPct * 2 - f.maxDrawdownPct * 0.35,
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
  if (selectedStrategyId) {
    return runV8(symbol, interval, { ...cfg, rewardRisk: PROFILES[0].rewardRisk, stopAtr: PROFILES[0].stopAtr }, selectedStrategyId);
  }

  // Evaluate every profile independently. Only the three pre-OOS stability
  // folds are inspected during this search; the final 30% stays untouched.
  const reports: ValidationReport[] = [];
  for (const profile of PROFILES) {
    reports.push(await runV8(symbol, interval, {
      ...cfg,
      rewardRisk: profile.rewardRisk,
      stopAtr: profile.stopAtr,
    }));
  }

  const candidate = chooseCandidate(reports);
  if (!candidate) {
    const diagnostic = [...reports].sort((a, b) => {
      const score = (r: ValidationReport) => {
        const values = Object.values(r.foldDiagnostics ?? {}).flat();
        if (!values.length) return -Infinity;
        const passed = values.filter((f) => f.passed).length;
        const avgPf = values.reduce((s, f) => s + Math.min(f.profitFactor, 3), 0) / values.length;
        const avgRet = values.reduce((s, f) => s + f.returnPct, 0) / values.length;
        const avgDd = values.reduce((s, f) => s + f.maxDrawdownPct, 0) / values.length;
        return passed * 100 + avgPf * 10 + avgRet * 2 - avgDd;
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

  // Only now run V8 a second time for the winning pre-OOS profile/strategy.
  // This is the single untouched final OOS evaluation.
  const profile = PROFILES[candidate.reportIndex];
  return runV8(
    symbol,
    interval,
    { ...cfg, rewardRisk: profile.rewardRisk, stopAtr: profile.stopAtr },
    candidate.strategyId,
  );
}

export * from './backtestV8';
