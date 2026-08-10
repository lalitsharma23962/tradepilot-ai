import { runValidation } from '../src/lib/backtestV11';
import { TRADING_CONFIG } from '../src/lib/tradingConfig';
import type { Candle } from '../src/lib/backtestV6';

// Diagnostic-only matrix. Economic friction gate remains <= 0.15R and allocations remain 25/25/50.
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
const DATA_API='https://data-api.binance.vision/api/v3/klines';
function intervalMs(x:string){const m=x.match(/^(\d+)([mhd])$/i);if(!m)throw new Error(`Unsupported interval: ${x}`);const n=+m[1],u=m[2].toLowerCase();return n*(u==='m'?60000:u==='h'?3600000:86400000);}
async function fetchAbsolute(symbol:string,interval:string,total:number):Promise<Candle[]>{
  const ms=intervalMs(interval),rows:unknown[][]=[]; let cursor=Math.max(0,Date.now()-(total+20)*ms);
  while(rows.length<total+20){
    const limit=Math.min(1000,total+20-rows.length); const q=new URLSearchParams({symbol,interval,startTime:String(cursor),limit:String(limit)});
    const res=await fetch(`${DATA_API}?${q}`); if(!res.ok)throw new Error(`Binance historical request failed ${res.status}`);
    const batch=await res.json() as unknown[][]; if(!batch.length)break; rows.push(...batch);
    const last=Number(batch.at(-1)?.[0]); if(!Number.isFinite(last))break; cursor=last+ms;
    if(batch.length<limit)break; await new Promise(r=>setTimeout(r,80));
  }
  const seen=new Set<number>();
  return rows.map(r=>({openTime:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])}))
    .filter(c=>[c.openTime,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.openTime+ms<=Date.now()&&!seen.has(c.openTime)&&seen.add(c.openTime))
    .sort((a,b)=>a.openTime-b.openTime).slice(-total);
}
function fmt(v:number){return Number.isFinite(v)?v.toFixed(3):'—';}
function scoreLabel(mult:number){return mult===1?'baseline':`-${Math.round((1-mult)*100)}%`;}
function expR(avgTradePct:number){return TRADING_CONFIG.riskPerTradePct>0?avgTradePct/TRADING_CONFIG.riskPerTradePct:0;}
function funnelRow(f:any){return `${f.barsEvaluated}/${f.noLocalPattern}/${f.scoreRejected}/${f.structuralStopRejected}/${f.costRejected}/${f.rejectedPathCapacity}/${f.targetUnreachable??0}/${f.tradesOpened}`;}
async function main(){
 console.log('v38 CONTROLLED SENSITIVITY AUDIT — HARNESS REPAIRED');
 console.log('Data source: absolute Binance data-api.binance.vision; no relative /api endpoint.');
 console.log('Economic gate: costInR <= 0.15R (UNCHANGED); allocation: 25/25/50 (UNCHANGED).');
 for(const interval of ['1h','4h'] as const){
  const yearBars=YEAR_BARS[interval],horizon=TRADING_CONFIG.maxBarsInTrade[interval]??120,warmup=Math.max(220,TRADING_CONFIG.capacitySamples*horizon+horizon+32);
  const candles=await fetchAbsolute('BTCUSDT',interval,yearBars+warmup);
  if(candles.length<yearBars)throw new Error(`${interval}: received ${candles.length}, need ${yearBars}`);
  console.log(`\n=== BTCUSDT ${interval} — ${yearBars} trailing-year candles + ${warmup} causal warm-up ===`);
  console.log('Score | Stop | Targets | bars/pattern/score/stopEnv/costR/capacity/target/fills | F1 t/PF/ExpR | F2 t/PF/ExpR | F3 t/PF/ExpR | OOS t/PF/ExpR | Gate');
  console.log('-'.repeat(230));
  for(const scoreMult of SCORE_MULTIPLIERS)for(const stop of STOP_FLOORS)for(const target of TARGETS){
    const report=await runValidation('BTCUSDT',interval,{historyTargetOverride:yearBars,candlesOverride:candles,minScoreOverride:TRADING_CONFIG.minScore*scoreMult,minStopAtrOverride:stop.value,targetMultiples:target.value} as any);
    const f:any=report.signalFunnel; const folds:any[]=report.foldDiagnostics.production as any[]; const ft=folds.slice(0,3).map(x=>`${x.trades}/${fmt(x.profitFactor)}/${fmt(x.expectancyR)}`); const o:any=report.walkForward.test;
    console.log(`${scoreLabel(scoreMult).padEnd(6)}| ${stop.label.padEnd(8)}| ${target.label.padEnd(16)}| ${funnelRow(f).padEnd(72)}| ${ft[0].padEnd(14)}| ${ft[1].padEnd(14)}| ${ft[2].padEnd(14)}| ${(o?`${o.trades}/${fmt(o.profitFactor)}/${fmt(expR(o.avgTrade))}`:'—').padEnd(16)}| ${report.gate.status}`);
  }
 }
}
main().catch(err=>{console.error(err);process.exit(1);});
