import { runValidation } from '../src/lib/backtestV11.ts';

for (const interval of ['1h', '4h'] as const) {
  const report = await runValidation('BTCUSDT', interval);
  console.log(`\n=== BTCUSDT ${interval} v38 funnel ===`);
  console.log(JSON.stringify({
    barsEvaluated: report.signalFunnel?.barsEvaluated ?? 0,
    noPattern: report.signalFunnel?.noLocalPattern ?? 0,
    scoreRejected: report.signalFunnel?.rejectedScore ?? 0,
    stopEnvelopeRejected: report.signalFunnel?.rejectedStructuralStop ?? 0,
    costRejected: report.signalFunnel?.rejectedRiskFloor ?? 0,
    capacityRejected: report.signalFunnel?.rejectedPathCapacity ?? 0,
    ordersAttempted: report.signalFunnel?.ordersAttempted ?? 0,
    tradesOpened: report.signalFunnel?.tradesOpened ?? 0,
    tradesClosed: report.signalFunnel?.tradesClosed ?? 0,
    targetUnreachable: 'not separately instrumented in current funnel',
    familyCandidates: {
      trend: report.signalFunnel?.familyCandidatesTrend ?? 0,
      breakout: report.signalFunnel?.familyCandidatesBreakout ?? 0,
      retest: report.signalFunnel?.familyCandidatesRetest ?? 0,
      compression: report.signalFunnel?.familyCandidatesCompression ?? 0,
      reversion: report.signalFunnel?.familyCandidatesReversion ?? 0,
    },
    folds: report.foldDiagnostics.production,
    gate: report.gate,
  }, null, 2));
}
