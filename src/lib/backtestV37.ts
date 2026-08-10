import { runValidation as runV36Validation, type BacktestConfig, type ValidationReport } from './backtestV11';
export type { BacktestConfig, ValidationReport } from './backtestV11';

export async function runValidation(symbol='BTCUSDT',interval='5m',cfg:Partial<BacktestConfig>={},selectedStrategyId?:string):Promise<ValidationReport>{
 const report=await runV36Validation(symbol,interval,cfg,selectedStrategyId);
 for(const s of report.strategies)s.name='Production Regime Breakout v37';
 if(report.walkForward.selectedStrategy==='Production Regime Breakout v36')report.walkForward.selectedStrategy='Production Regime Breakout v37';
 report.research.selectionMethod=report.research.selectionMethod
  .replaceAll('Production Regime Breakout v36','Production Regime Breakout v37')
  .replace('dynamic 2R-4R target selection','fixed 2R final target with 0.5R/1R/1.5R/2R partial exits')
  .replace('Dynamic target 2R-4R','Fixed 2R target ladder');
 report.research.coverage=report.research.coverage.map(x=>x.replace('dynamic 2R-4R target selection','fixed 2R target ladder'));
 report.gate.reasons=report.gate.reasons.map(x=>x.replaceAll('Production Regime Breakout v36','Production Regime Breakout v37'));
 return report;
}
