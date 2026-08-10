import { runValidation } from '../src/lib/backtestV11.ts';

for (const interval of ['1h','4h'] as const) {
  const report = await runValidation('BTCUSDT', interval);
  console.log(JSON.stringify({
    interval,
    gate: report.gate,
    testTrades: report.walkForward.test?.trades ?? 0,
    testProfitFactor: report.walkForward.test?.profitFactor ?? null,
    testReturnPct: report.walkForward.test?.returnPct ?? null,
    testMaxDrawdownPct: report.walkForward.test?.maxDrawdownPct ?? null,
    folds: report.foldDiagnostics.production,
    selectedStrategy: report.walkForward.selectedStrategy,
  }, null, 2));
}
