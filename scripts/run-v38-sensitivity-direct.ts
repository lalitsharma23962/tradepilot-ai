import { fetchHistoricalCandles, type Candle } from '../src/lib/backtestV6';
import { evaluateProductionStrategy } from '../src/lib/strategy';
import { calculatePositionSize } from '../src/engine/risk';
import { TRADING_CONFIG } from '../src/lib/tradingConfig';

// Standalone diagnostic runner. It deliberately does NOT import backtestV11.ts,
// so a broken legacy validation harness cannot prevent the sensitivity audit.
// Economic friction gate remains <= 0.15R and is never relaxed here.
const YEAR: Record<'1h'|'4h', number> = { '1h': 8760, '4h': 2190 };
const SCORES = [1, .85, .70] as const;
const STOPS: Array<{label:string; atr?:number}> = [
  {label:'baseline'},
  {label:'1.2xATR', atr:1.2},
];
const TARGETS: Array<{label:string; r:readonly number[]}> = [
  {label:'A:1.0/1.5/2.0R', r:[1,1.5,2]},
  {label:'B:0.8/1.2/1.6R', r:[.8,1.2,1.6]},
];
const FEE = TRADING_CONFIG.feeBps / 10000;
const SLIP = TRADING_CONFIG.slippageBps / 10000;
const RISK_PCT = TRADING_CONFIG.riskPerTradePct / 100;
const MIN_COST_R = .15;
const WARMUP = 260;

type Trade = { r:number; fold:number };
function n(v:number){ return Number.isFinite(v) ? v.toFixed(3) : '—'; }
function scoreName(x:number){ return x===1?'baseline':`-${Math.round((1-x)*100)}%`; }
function costInR(entry:number, stop:number){
  const risk=Math.abs(entry-stop);
  if(!(risk>0)) return Infinity;
  return (entry * (2*(TRADING_CONFIG.feeBps+TRADING_CONFIG.slippageBps)/10000)) / risk;
}
function netR(pnl:number,equity:number){
  const riskBudget=Math.max(equity,0)*RISK_PCT;
  return riskBudget>0 ? pnl/riskBudget : 0;
}
function pf(rs:number[]){
  const g=rs.filter(x=>x>0).reduce((a,b)=>a+b,0);
  const l=Math.abs(rs.filter(x=>x<0).reduce((a,b)=>a+b,0));
  return l>0?g/l:(g>0?Infinity:0);
}
function simulate(c:Candle[], start:number, end:number, scoreMult:number, stopAtr:number|undefined, targetR:readonly number[], fold:number):Trade[]{
  const trades:Trade[]=[];
  let equity=TRADING_CONFIG.paperStartingCapital;
  let i=Math.max(start,WARMUP);
  const maxBars=TRADING_CONFIG.maxBarsInTrade['1h'] ?? 120;
  while(i<end-1){
    const hist=c.slice(Math.max(0,i-WARMUP),i+1);
    const signal=evaluateProductionStrategy(hist,{minScore:TRADING_CONFIG.minScore*scoreMult,minRiskReward:Math.min(...targetR),maxRiskReward:Math.max(...targetR),minStopAtr:stopAtr??TRADING_CONFIG.minStopAtr,feeBps:TRADING_CONFIG.feeBps,slippageBps:TRADING_CONFIG.slippageBps,maxCostFractionOfRisk:MIN_COST_R} as any);
    if(signal.action==='WAIT'){i++;continue;}
    const side=signal.action==='LONG'?1:-1;
    const next=c[i+1];
    const entry=next.open*(1+side*SLIP);
    const risk=Math.abs(signal.entry-signal.stopLoss);
    const stop=entry-side*risk;
    if(!(risk>0) || costInR(entry,stop)>MIN_COST_R){i++;continue;}
    const sizing=calculatePositionSize({accountEquity:equity,riskPct:RISK_PCT,entryPrice:entry,stopLossPrice:stop,maxPositionPct:TRADING_CONFIG.maxAllocationPct,maxLeverage:TRADING_CONFIG.maxLeverage});
    if(!(sizing.finalQuantity>0)){i++;continue;}
    const qty=sizing.finalQuantity;
    const allocations=targetR.length===3?[.25,.25,.50]:targetR.map(()=>1/targetR.length);
    let remaining=qty, realized=0, fees=0, stopPx=stop, targetIdx=0, closed=false;
    for(let j=i+1;j<Math.min(end,i+1+maxBars);j++){
      const b=c[j];
      if(side===1 ? b.low<=stopPx : b.high>=stopPx){
        const exit=stopPx*(1-side*SLIP);
        realized += side*(exit-entry)*remaining;
        fees += (Math.abs(entry*remaining)+Math.abs(exit*remaining))*FEE;
        closed=true; i=j; break;
      }
      while(targetIdx<targetR.length){
        const target=entry+side*risk*targetR[targetIdx];
        const hit=side===1 ? b.high>=target : b.low<=target;
        if(!hit) break;
        const q=targetIdx===targetR.length-1?remaining:Math.min(remaining,qty*allocations[targetIdx]);
        const exit=target*(1-side*SLIP);
        realized += side*(exit-entry)*q;
        fees += (Math.abs(entry*q)+Math.abs(exit*q))*FEE;
        remaining-=q;
        targetIdx++;
        if(targetIdx===1) stopPx=entry;
        else if(targetIdx===2) stopPx=entry+side*risk*.5;
        if(remaining<=qty*1e-9){closed=true;i=j;break;}
      }
      if(closed) break;
      if(j===Math.min(end,i+1+maxBars)-1){
        const exit=b.close*(1-side*SLIP);
        realized += side*(exit-entry)*remaining;
        fees += (Math.abs(entry*remaining)+Math.abs(exit*remaining))*FEE;
        closed=true;i=j;
      }
    }
    if(closed){
      const pnl=realized-fees;
      const r=netR(pnl,equity);
      trades.push({r,fold});
      equity+=pnl;
    } else break;
  }
  return trades;
}
function row(label:string,rs:Trade[]){
  const r=rs.map(x=>x.r), expectancy=r.length?r.reduce((a,b)=>a+b,0)/r.length:0;
  return `${rs.length}/${n(pf(r))}/${n(expectancy)}`;
}
async function main(){
  console.log('v38 CONTROLLED SENSITIVITY AUDIT — DIRECT ENGINE');
  console.log('Friction gate: costInR <= 0.15R — UNCHANGED');
  console.log('Target allocations: 25% / 25% / 50%');
  console.log('OOS: final 30% of trailing-year data, split into 3 equal chronological folds.');
  for(const interval of ['1h','4h'] as const){
    const year=YEAR[interval], horizon=TRADING_CONFIG.maxBarsInTrade[interval]??120;
    const candles=await fetchHistoricalCandles('BTCUSDT',interval,year+WARMUP+horizon);
    const data=candles.slice(-year-WARMUP);
    const oosStart=WARMUP+Math.floor((year-WARMUP)*.70);
    const oosLen=data.length-oosStart, foldLen=Math.floor(oosLen/3);
    console.log(`\n=== BTCUSDT ${interval} — ${year} trailing-year candles ===`);
    console.log('Score | Stop | Targets | F1 trades/PF/ExpR | F2 trades/PF/ExpR | F3 trades/PF/ExpR | OOS total/PF/ExpR | Selection');
    console.log('-'.repeat(175));
    for(const sm of SCORES) for(const st of STOPS) for(const tg of TARGETS){
      const all:Trade[]=[];
      const folds:Trade[][]=[];
      for(let f=0;f<3;f++){
        const a=oosStart+f*foldLen,b=f===2?data.length:oosStart+(f+1)*foldLen;
        const rs=simulate(data,a,b,sm,st.atr,tg.r,f+1); folds.push(rs); all.push(...rs);
      }
      const vals=all.map(x=>x.r), e=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0, p=pf(vals);
      const pass=all.length>=30&&folds.every(x=>x.length>=10)&&e>0.15&&folds.every(x=>pf(x.map(t=>t.r))>1.10);
      console.log(`${scoreName(sm).padEnd(8)}| ${st.label.padEnd(8)}| ${tg.label.padEnd(16)}| ${row('f1',folds[0]).padEnd(21)}| ${row('f2',folds[1]).padEnd(21)}| ${row('f3',folds[2]).padEnd(21)}| ${all.length}/${n(p)}/${n(e)}${' '.repeat(Math.max(1,18-(String(all.length).length+String(n(p)).length+String(n(e)).length)))}| ${pass?'PASS':'FAIL'}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
