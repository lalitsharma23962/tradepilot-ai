import { runValidation as runV8 } from './backtestV8';
import { fetchHistoricalCandles, type Candle } from './backtestV6';
import type { BacktestConfig, ValidationReport, FoldDiagnostic } from './backtestV6';

/** V12: robustness-first, pre-OOS-only profile selection.
 * The sweep reuses one downloaded candle set and screens only the first 70%.
 * The final 30% is evaluated exactly once, after a candidate passes all 3 folds.
 */
const PROFILES = [
  { rewardRisk: 1.5, stopAtr: 1.00, maxBarsInTrade: 36 },
  { rewardRisk: 1.6, stopAtr: 1.25, maxBarsInTrade: 48 },
  { rewardRisk: 2.0, stopAtr: 1.25, maxBarsInTrade: 48 },
  { rewardRisk: 2.4, stopAtr: 1.25, maxBarsInTrade: 48 },
  { rewardRisk: 1.6, stopAtr: 1.50, maxBarsInTrade: 48 },
  { rewardRisk: 2.0, stopAtr: 1.50, maxBarsInTrade: 48 },
  { rewardRisk: 2.4, stopAtr: 1.75, maxBarsInTrade: 48 },
  { rewardRisk: 2.0, stopAtr: 2.00, maxBarsInTrade: 48 },
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
  return fold.trades >= minimumTrades && fold.returnPct > MIN_RETURN && fold.profitFactor >= MIN_PF && fold.maxDrawdownPct <= MAX_DD;
}
function isStable(report: ValidationReport, folds: FoldDiagnostic[]): boolean {
  return folds.length === 3 && folds.every((f) => passesFold(report, f));
}
function stabilityScore(report: ValidationReport, folds: FoldDiagnostic[]): number {
  if (!isStable(report, folds)) return -Infinity;
  const weights = [0.25, 0.30, 0.45];
  const weighted = (selector: (f: FoldDiagnostic) => number) => folds.reduce((sum, f, i) => sum + selector(f) * weights[i], 0);
  const pf = folds.map((f) => Math.min(f.profitFactor, 3));
  const ret = folds.map((f) => f.returnPct);
  const dd = folds.map((f) => f.maxDrawdownPct);
  const trades = folds.map((f) => f.trades);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const min = (xs: number[]) => Math.min(...xs);
  const max = (xs: number[]) => Math.max(...xs);
  const minimumTrades = minFoldTrades(report);
  const meanPf = mean(pf), worstPf = min(pf), meanRet = mean(ret), worstRet = min(ret), worstDd = max(dd), meanTrades = mean(trades);
  return worstRet * 5 + worstPf * 30 + meanPf * 10 + weighted((f) => Math.min(f.profitFactor, 3)) * 18 + meanRet + weighted((f) => f.returnPct) * 2 + Math.min(meanTrades / Math.max(minimumTrades, 1), 4) * 1.5 + Math.min(weighted((f) => f.trades) / Math.max(minimumTrades, 1), 4) - worstDd * 0.9 - weighted((f) => f.maxDrawdownPct) * 0.35 - (max(ret) - min(ret)) * 0.55 - (max(dd) - min(dd)) * 0.20;
}
function chooseCandidate(reports: ValidationReport[]): { reportIndex: number; strategyId: string } | null {
  let best: { reportIndex: number; strategyId: string; score: number } | null = null;
  reports.forEach((report, reportIndex) => report.strategies.forEach((strategy) => {
    const score = stabilityScore(report, foldsFor(report, strategy.id));
    if (Number.isFinite(score) && (!best || score > best.score)) best = { reportIndex, strategyId: strategy.id, score };
  }));
  return best ? { reportIndex: best.reportIndex, strategyId: best.strategyId } : null;
}
function diagnosticReason(reports: ValidationReport[]): string {
  let best: { report: ValidationReport; strategy: string; passed: number; score: number } | null = null;
  for (const report of reports) for (const strategy of report.strategies) {
    const folds = foldsFor(report, strategy.id); if (folds.length !== 3) continue;
    const passed = folds.filter((f) => passesFold(report, f)).length;
    const score = folds.reduce((sum, f, i) => sum + [0.25,0.30,0.45][i] * (Math.min(f.profitFactor, 3) * 10 + f.returnPct * 2 - f.maxDrawdownPct * 0.35), 0);
    if (!best || passed > best.passed || (passed === best.passed && score > best.score)) best = { report, strategy: strategy.name, passed, score };
  }
  if (!best) return 'No strategy produced complete pre-OOS fold diagnostics.';
  return `No strategy passed all 3 pre-OOS stability folds. Closest candidate: ${best.strategy} (${best.passed}/3 folds passed; minimum ${minFoldTrades(best.report)} trades/fold, PF >= ${MIN_PF}, positive return, DD <= ${MAX_DD}%).`;
}

async function runProfile(symbol:string, interval:string, cfg:Partial<BacktestConfig>, profile:typeof PROFILES[number], candles:Candle[], selectedStrategyId?:string, preOosOnly=false) {
  return runV8(symbol, interval, {...cfg, rewardRisk:profile.rewardRisk, stopAtr:profile.stopAtr, maxBarsInTrade:profile.maxBarsInTrade}, selectedStrategyId, candles, preOosOnly);
}

export async function runValidation(symbol='BTCUSDT', interval='1h', cfg:Partial<BacktestConfig>={}, selectedStrategyId?:string):Promise<ValidationReport>{
  const candles = await fetchHistoricalCandles(symbol, interval, 40000);
  if (selectedStrategyId) return runProfile(symbol, interval, cfg, PROFILES[1], candles, selectedStrategyId, false);

  const reports:ValidationReport[]=[];
  // Pre-OOS screening only. Reusing the same candle array avoids 20 repeated
  // Binance downloads and keeps the browser responsive enough to finish.
  for (const profile of PROFILES) reports.push(await runProfile(symbol, interval, cfg, profile, candles, undefined, true));

  const candidate=chooseCandidate(reports);
  if (!candidate) {
    const diagnostic=[...reports].sort((a,b)=>b.strategies[0]?.score-a.strategies[0]?.score)[0];
    if (!diagnostic) throw new Error('Validation produced no profile reports.');
    return {...diagnostic,walkForward:{...diagnostic.walkForward,selectedStrategy:'',validation:null,test:null},gate:{...diagnostic.gate,status:'REJECTED',reasons:[diagnosticReason(reports)]},research:{...diagnostic.research,selectionMethod:'10 exit profiles; three non-overlapping pre-OOS folds; all 3 folds required; recent-fold weighted robustness; fold-dispersion penalties; untouched 30% OOS; costs included in every trade.',coverage:[...diagnostic.research.coverage,'10-profile multi-horizon exit sweep','recent pre-OOS regime weighting','fold return/drawdown dispersion penalty','three-fold regime consistency gate']}};
  }

  // Only now, after the pre-OOS stability gate, evaluate the untouched final 30% once.
  return runProfile(symbol, interval, cfg, PROFILES[candidate.reportIndex], candles, candidate.strategyId, false);
}

export * from './backtestV8';
