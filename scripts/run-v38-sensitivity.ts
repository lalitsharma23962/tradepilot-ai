import { fetchHistoricalCandles } from '../src/lib/backtestV6';
import { runValidation } from '../src/lib/backtestV11';
import { TRADING_CONFIG } from '../src/lib/tradingConfig';

const YEAR_BARS: Record<'1h'|'4h', number> = { '1h': 365 * 24, '4h': Math.floor(365 * 24 / 4) };
const SCORE_MULTIPLIERS = [1, .85, .70] as const;
const STOP_FLOORS: Array<{label:string;value?:number}> = [
  { label: 'baseline', value: undefined },
  { label: '1.2xATR', value: 1.2 },
];
const TARGETS: Array<{label:string;value:readonly number[]}> = [
  { label: 'A:1.0/1.5/2.0R', value: [1, 1.5, 2] },
  { label: 'B:0.8/1.2/1.6R', value: [.8, 1.2, 1.6] },
];
function fmt(v:number){return Number.isFinite(v)?v.toFixed(3):'—';}
function scoreLabel(mult:number){return mult===1?'baseline':`-${Math.round((1-mult)*100)}%`;}
function normalizeExpectancy(avgTradePct:number){return TRADING_CONFIG.riskPerTradePct>0?avgTradePct/TRADING_CONFIG.riskPerTradePct:0;}
async function main(){
 console.log('v38 CONTROLLED SENSITIVITY AUDIT');
 console.log('Economic gate: costInR <= 0.15R (UNCHANGED)');
 console.log('Data: exact trailing 1 year BTCUSDT 1h + 4h, with causal warm-up context');
 console.log('Target Set B uses the same 25/25/50 allocation as baseline so only target multiples vary.');
 for(const interval of ['1h','4h'] as const){
  const yearBars=YEAR_BARS[interval],horizon=TRADING_CONFIG.maxBarsInTrade[interval]??120,warmup=Math.max(220,TRADING_CONFIG.capacitySamples*horizon+horizon+32);
  const candles=await fetchHistoricalCandles('BTCUSDT',interval,yearBars+warmup);
  if(candles.length<yearBars)throw new Error(`${interval}: received ${candles.length}, need ${yearBars}`);
  console.log(`\n=== BTCUSDT ${interval} — ${yearBars} trailing-year candles ===`);
  console.log('Score | Stop | Targets | F1 trades/PF/ExpR | F2 trades/PF/ExpR | F3 trades/PF/ExpR | OOS trades/PF/ExpR | Gate');
  console.log('-'.repeat(170));
  for(const scoreMult of SCORE_MULTIPLIERS)for(const stop of STOP_FLOORS)for(const target of TARGETS){
   const report=await runValidation('BTCUSDT',interval,{historyTargetOverride:yearBars,candlesOverride:candles,minScoreOverride:TRADING_CONFIG.minScore*scoreMult,minStopAtrOverride:stop.value,targetMultiplesR:target.value} as any);
   const folds:any[]=report.foldDiagnostics.production as any[];
   const foldText=folds.slice(0,3).map(f=>`${f.trades}/${fmt(f.profitFactor)}/${fmt(f.expectancyR)}`);
   const oos:any=report.walkForward.test;
   const oosText=oos?`${oos.trades}/${fmt(oos.profitFactor)}/${fmt(normalizeExpectancy(oos.avgTrade))}`:'—';
   console.log(`${scoreLabel(scoreMult).padEnd(6)}| ${stop.label.padEnd(8)}| ${target.label.padEnd(16)}| ${foldText[0].padEnd(21)}| ${foldText[1].padEnd(21)}| ${foldText[2].padEnd(21)}| ${oosText.padEnd(20)}| ${report.gate.status}`);
  }
 }
}
main().catch(err=>{console.error(err);process.exit(1);});
