import { runValidation as runV38Validation, type BacktestConfig, type ValidationReport } from './backtestV11';
export type { BacktestConfig, ValidationReport } from './backtestV11';

export async function runValidation(symbol='BTCUSDT',interval='5m',cfg:Partial<BacktestConfig>={},selectedStrategyId?:string):Promise<ValidationReport>{
 const report=await runV38Validation(symbol,interval,cfg,selectedStrategyId);
 for(const s of report.strategies)s.name='Production Regime Breakout v38';
 if(report.walkForward.selectedStrategy.includes('Production Regime Breakout'))report.walkForward.selectedStrategy=report.walkForward.selectedStrategy==='No eligible strategy'?'No eligible strategy':'Production Regime Breakout v38';
 report.research.selectionMethod=report.research.selectionMethod
  .replaceAll('Production Regime Breakout v28','Production Regime Breakout v38')
  .replaceAll('Production Regime Breakout v36','Production Regime Breakout v38')
  .replace('dynamic 2R-4R target selection','fixed 2R final target with 0.5R/1R/1.5R/2R partial exits')
  .replace('Dynamic target 2R-4R','Fixed 2R target ladder');
 report.research.coverage=report.research.coverage.map(x=>x.replaceAll('Production Regime Breakout v28','Production Regime Breakout v38').replace('dynamic 2R-4R target selection','fixed 2R target ladder'));
 report.gate.reasons=report.gate.reasons.map(x=>x.replaceAll('Production Regime Breakout v28','Production Regime Breakout v38').replaceAll('Production Regime Breakout v36','Production Regime Breakout v38'));
 return report;
}
