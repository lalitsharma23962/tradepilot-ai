import { runValidation as runV8 } from './backtestV8';
import type { BacktestConfig, ValidationReport } from './backtestV6';

/**
 * V9 keeps the hard validation gate intact, but makes exit-profile selection
 * explicit and pre-OOS-only. A small fixed set of reward/risk profiles is
 * compared using the existing V8 engine, then the strongest pre-OOS profile
 * is returned. The untouched final 30% OOS is never used to choose a profile.
 */
const PROFILES = [
  { rewardRisk: 2.2 },
  { rewardRisk: 2.8 },
  { rewardRisk: 3.2 },
] as const;

function preOosScore(report: ValidationReport): number {
  const entries = Object.values(report.foldDiagnostics ?? {});
  let passed = 0;
  let total = 0;
  let pf = 0;
  let ret = 0;
  let dd = 0;

  for (const folds of entries) {
    for (const f of folds) {
      total++;
      if (f.passed) passed++;
      pf += Math.min(f.profitFactor, 3);
      ret += f.returnPct;
      dd += f.maxDrawdownPct;
    }
  }

  if (!total) return -Infinity;
  return passed * 100 + (pf / total) * 10 + ret / total - (dd / total) * 0.5;
}

export async function runValidation(
  symbol = 'BTCUSDT',
  interval = '1h',
  cfg: Partial<BacktestConfig> = {},
  selectedStrategyId?: string,
): Promise<ValidationReport> {
  const reports: ValidationReport[] = [];

  for (const profile of PROFILES) {
    reports.push(
      await runV8(
        symbol,
        interval,
        { ...cfg, rewardRisk: profile.rewardRisk },
        selectedStrategyId,
      ),
    );
  }

  // Selection uses only pre-OOS fold diagnostics. The final OOS result and
  // Monte Carlo output are deliberately excluded from this comparison.
  reports.sort((a, b) => preOosScore(b) - preOosScore(a));
  return reports[0];
}

export * from './backtestV8';
