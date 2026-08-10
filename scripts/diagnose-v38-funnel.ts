import { runValidation } from '../src/lib/backtestV11.ts';

function printFunnel(interval:string,report:Awaited<ReturnType<typeof runValidation>>){
 const f=report.signalFunnel;
 const rows=[
  ['Bars evaluated',f?.barsEvaluated??0],
  ['No pattern',f?.noLocalPattern??0],
  ['Score rejected',f?.rejectedScore??0],
  ['Stop envelope rejected',f?.rejectedStructuralStop??0],
  ['Cost rejected (>0.15R)',f?.rejectedCost??0],
  ['Capacity rejected (evidence unavailable)',f?.rejectedPathCapacity??0],
  ['Target unreachable (2R infeasible)',f?.targetUnreachable??0],
  ['Signal accepted',f?.signalAccepted??0],
  ['Orders attempted',f?.ordersAttempted??0],
  ['Trades opened / filled',f?.tradesOpened??0],
  ['Trades closed',f?.tradesClosed??0],
 ] as const;
 console.log(`\n=== BTCUSDT ${interval} v38 funnel ===`);
 console.log('Gate'.padEnd(42)+'Count');
 console.log('-'.repeat(52));
 for(const [name,count] of rows)console.log(name.padEnd(42)+String(count));
 console.log('-'.repeat(52));
 console.log(`Family candidates: trend=${f?.familyCandidatesTrend??0}, breakout=${f?.familyCandidatesBreakout??0}, compression=${f?.familyCandidatesCompression??0}, reversion=${f?.familyCandidatesReversion??0}`);
 console.log(`Validation gate: ${report.gate.status}`);
 console.log(`OOS trades: ${report.walkForward.test?.trades??0}`);
}

for (const interval of ['1h','4h'] as const) {
 const report=await runValidation('BTCUSDT',interval);
 printFunnel(interval,report);
}
