import { runValidation as runV8 } from './backtestV8';
import type { BacktestConfig, ValidationReport, FoldDiagnostic } from './backtestV6';

/**
 * V12: robustness-first, pre-OOS-only profile selection.
 *
 * The final 30% OOS segment is never inspected while searching profiles.
 * A candidate must pass all three non-overlapping pre-OOS stability folds.
 * Profile search now also varies holding time so exits are tested as a
 * research dimension rather than assuming one fixed 48-bar exit horizon.
 *
 * Selection deliberately favors the weakest/recent fold and penalizes
 * performance dispersion between folds. This is intended to reduce
 * regime-specific overfitting rather than maximize aggregate backtest PnL.
 */
const PROFILES = [
  { rewardRisk: 1.6, stopAtr: 1.25, maxBarsInTrade: 48 },
  { rewardRisk: 2.0, stopAtr: 1.25, maxBarsInTrade: 48 },
  { rewardRisk: 2.4, stopAtr: 1.25, maxBarsInTrade: 48 },
  { rewardRisk: 1.6, stopAtr: 1.50, maxBarsInTrade: 48 },
  { rewardRisk: 2.0, stopAtr: 1.50, maxBarsInTrade: 48 },
  { rewardRisk: 2.4, stopAtr: 1.50, maxBarsInTrade: 48 },
  { rewardRisk: 1.6, stopAtr: 1.75, maxBarsInTrade: 48 },
  { rewardRisk: 2.0, stopAtr: 1.75, maxBarsInTrade: 48 },
  { rewardRisk: 2.4, stopAtr: 1.75, maxBarsInTrade: 48 },
  { rewardRisk: 1.6, stopAtr: 2.00, maxBarsInTrade: 48 },
  { rewardRisk: 2.0, stopAtr: 2.00, maxBarsInTrade: 48 },
  { rewardRisk: 2.4, stopAtr: 2.00, maxBarsInTrade: 48 },
  { rewardRisk: 2.0, stopAtr: 2.25, maxBarsInTrade: 48 },
  { rewardRisk: 2.4, stopAtr: 2.25, maxBarsInTrade: 48 },
  // Additional exit profiles: shorter holding horizons.
  { rewardRisk: 1.5, stopAtr: 1.00, maxBarsInTrade: 36 },
  { rewardRisk: 1.8, stopAtr: 1.25, maxBarsInTrade: 36 },
  { rewardRisk: 2.2, stopAtr: 1.50, maxBarsInTrade: 36 },
  { rewardRisk: 2.6, stopAtr: 1.75, maxBarsInTrade: 36 },
  // Additional exit profiles: allow strong trends more time to resolve.
  { rewardRisk: 1.8, stopAtr: 1.50, maxBarsInTrade: 72 },
  { rewardRisk: 2.2, stopAtr: 1.75, maxBarsInTrade: 72 },
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

function passesFold(report: ValidationReport, fold: FoldDiagnostic): boolean {
  const minimumTrades = minFoldTrades(report);
  return (
    fold.trades >= minimumTrades &&
    fold.returnPct > MIN_RETURN &&
    fold.profitFactor >= MIN_PF &&
    fold.maxDrawdownPct <= MAX_DD
  );
}

function isStable(report: ValidationReport, folds: FoldDiagnostic[]): boolean {
  return folds.length === 3 && folds.every((f) => passesFold(report, f));
}

function stabilityScore(report: ValidationReport, folds: FoldDiagnostic[]): number {
  if (!isStable(report, folds)) return -Infinity;

  // Fold 3 is the most recent pre-OOS regime, so it gets the highest weight.
  // None of these folds touch the final 30% OOS segment.
  const weights = [0.25, 0.30, 0.45];
  const weighted = (selector: (f: FoldDiagnostic) => number) =>
    folds.reduce((sum, f, i) => sum + selector(f) * weights[i], 0);

  const pf = folds.map((f) => Math.min(f.profitFactor, 3));
  const ret = folds.map((f) => f.returnPct);
  const dd = folds.map((f) => f.maxDrawdownPct);
  const trades = folds.map((f) => f.trades);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const min = (xs: number[]) => Math.min(...xs);
  const max = (xs: number[]) => Math.max(...xs);
  const minimumTrades = minFoldTrades(report);

  const meanPf = mean(pf);
  const worstPf = min(pf);
  const meanRet = mean(ret);
  const worstRet = min(ret);
  const worstDd = max(dd);
  const meanTrades = mean(trades);
  const retSpread = max(ret) - min(ret);
  const ddSpread = max(dd) - min(dd);
  const weightedRet = weighted((f) => f.returnPct);
  const weightedPf = weighted((f) => Math.min(f.profitFactor, 3));
  const weightedDd = weighted((f) => f.maxDrawdownPct);
  const weightedTrades = weighted((f) => f.trades);

  // The score rewards a good recent regime, but only after all three folds
  // have passed. Dispersion penalties make a single exceptional period less
  // valuable than consistent performance.
  return (
    worstRet * 5 +
    worstPf * 30 +
    meanPf * 10 +
    weightedPf * 18 +
    meanRet * 1.0 +
    weightedRet * 2.0 +
    Math.min(meanTrades / Math.max(minimumTrades, 1), 4) * 1.5 +
    Math.min(weightedTrades / Math.max(minimumTrades, 1), 4) * 1.0 -
    worstDd * 0.9 -
    weightedDd * 0.35 -
    retSpread * 0.55 -
    ddSpread * 0.20
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
  let best: {
    report: ValidationReport;
    strategy: string;
    passed: number;
    score: number;
  } | null = null;

  for (const report of reports) {
    for (const strategy of report.strategies) {
      const folds = foldsFor(report, strategy.id);
      if (folds.length !== 3) continue;
      const passed = folds.filter((f) => passesFold(report, f)).length;
      const score = folds.reduce((sum, f, i) => {
        const recentWeight = [0.25, 0.30, 0.45][i];
        return sum + recentWeight * (
          Math.min(f.profitFactor, 3) * 10 +
          f.returnPct * 2 -
          f.maxDrawdownPct * 0.35
        );
      }, 0);
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
    return runV8(
      symbol,
      interval,
      { ...cfg, rewardRisk: PROFILES[0].rewardRisk, stopAtr: PROFILES[0].stopAtr, maxBarsInTrade: PROFILES[0].maxBarsInTrade },
      selectedStrategyId,
    );
  }

  // Evaluate each exit/risk profile independently. Only the three pre-OOS
  // stability folds are inspected during this search; the final 30% remains
  // completely untouched until a candidate passes all three folds.
  const reports: ValidationReport[] = [];
  for (const profile of PROFILES) {
    reports.push(await runV8(symbol, interval, {
      ...cfg,
      rewardRisk: profile.rewardRisk,
      stopAtr: profile.stopAtr,
      maxBarsInTrade: profile.maxBarsInTrade,
    }));
  }

  const candidate = chooseCandidate(reports);
  if (!candidate) {
    const diagnostic = [...reports].sort((a, b) => {
      const score = (r: ValidationReport) => {
        const values = Object.values(r.foldDiagnostics ?? {}).flat();
        if (!values.length) return -Infinity;
        const passed = values.filter((f) => f.passed).length;
        const weighted = values.reduce((s, f, i) => {
          const w = [0.25, 0.30, 0.45][Math.min(i, 2)];
          return s + w * (Math.min(f.profitFactor, 3) * 10 + f.returnPct * 2 - f.maxDrawdownPct);
        }, 0);
        return passed * 100 + weighted;
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
      research: {
        ...diagnostic.research,
        selectionMethod: '20 exit profiles; three non-overlapping pre-OOS folds; all 3 folds required; recent-fold weighted robustness; fold-dispersion penalties; untouched 30% OOS; costs included in every trade.',
        coverage: [
          ...diagnostic.research.coverage,
          'multi-horizon exit profiles',
          'recent pre-OOS regime weighting',
          'fold return/drawdown dispersion penalty',
          'three-fold regime consistency gate',
        ],
      },
    };
  }

  // Only after a profile/strategy passes all three pre-OOS folds do we run V8
  // for the winning profile. This is the single untouched final OOS evaluation.
  const profile = PROFILES[candidate.reportIndex];
  return runV8(
    symbol,
    interval,
    {
      ...cfg,
      rewardRisk: profile.rewardRisk,
      stopAtr: profile.stopAtr,
      maxBarsInTrade: profile.maxBarsInTrade,
    },
    candidate.strategyId,
  );
}

export * from './backtestV8';
