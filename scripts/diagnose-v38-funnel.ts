import { fetchHistoricalCandles,newFunnelCounters,type FunnelCounters } from '../src/lib/backtestV6';
import { evaluateProductionStrategy,MIN_INDEPENDENT_SAMPLES } from '../src/lib/strategyV35';
import { TRADING_CONFIG } from '../src/lib/tradingConfig';

const YEAR_BARS:Record<'1h'|'4h',number>={
 '1h':365*24,
 '4h':Math.floor(365*24/4),
};

function printFunnel(interval:'1h'|'4h',f:FunnelCounters,evaluated:number){
 console.log(`\n=== BTCUSDT ${interval} — exact trailing 1-year v38 funnel ===`);
 console.log('Gate'.padEnd(42)+'Count');
 console.log('-'.repeat(52));
 const rows:[string,number][]=[
  ['Bars evaluated',evaluated],
  ['No pattern',f.noLocalPattern],
  ['Score rejected',f.rejectedScore],
  ['Stop envelope rejected',f.rejectedStructuralStop],
  ['Cost rejected (>0.15R)',f.rejectedCost],
  ['Capacity rejected (evidence unavailable)',f.rejectedPathCapacity],
  ['Target unreachable (2R infeasible)',f.targetUnreachable],
  ['Signal accepted',f.signalAccepted],
 ];
 for(const [name,count] of rows)console.log(name.padEnd(42)+String(count));
 console.log('-'.repeat(52));
 console.log(`Family candidates: trend=${f.familyCandidatesTrend}, breakout=${f.familyCandidatesBreakout}, compression=${f.familyCandidatesCompression}, reversion=${f.familyCandidatesReversion}`);
 console.log(`Orders attempted: ${f.ordersAttempted}`);
 console.log(`Trades opened / filled: ${f.tradesOpened}`);
 console.log(`Trades closed: ${f.tradesClosed}`);
}

for(const interval of ['1h','4h'] as const){
 const yearBars=YEAR_BARS[interval];
 const horizon=TRADING_CONFIG.maxBarsInTrade[interval]??TRADING_CONFIG.maxBarsInTrade['5m'];
 const capacityWarmup=Math.max(TRADING_CONFIG.lookback,160,MIN_INDEPENDENT_SAMPLES*horizon+horizon+21);
 const candles=await fetchHistoricalCandles('BTCUSDT',interval,yearBars+capacityWarmup);
 const start=candles.length-yearBars;
 const funnel=newFunnelCounters();
 for(let i=start;i<candles.length;i++){
  evaluateProductionStrategy(candles.slice(0,i+1),{
   lookback:TRADING_CONFIG.lookback,
   feeBps:TRADING_CONFIG.feeBps,
   slippageBps:TRADING_CONFIG.slippageBps,
   minScore:TRADING_CONFIG.minScore,
   minStopAtr:TRADING_CONFIG.minStopAtr,
   maxStructuralRiskAtr:TRADING_CONFIG.maxStructuralRiskAtr,
   maxCostFractionOfRisk:.15,
   swingLookback:TRADING_CONFIG.swingLookback,
   capacityHorizonBars:horizon,
   capacityBars:candles.slice(0,i+1),
   funnel,
  } as any);
 }
 printFunnel(interval,funnel,yearBars);
}
