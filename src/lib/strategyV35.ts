import { evaluateProductionStrategy as evaluateEntryStrategy, type StrategyConfig, type StrategySignal } from './strategyV32';
export type { StrategyConfig, StrategySignal } from './strategyV32';
import type { MarketBar } from './marketData';
import { TRADING_CONFIG } from './tradingConfig';

/** v35 keeps v32 entry qualification unchanged, then independently tests whether the research target has historically been reachable over the same maximum holding horizon used by the backtest/paper engine. */
const ENTRY_MIN_R=1.5;
const ENTRY_MAX_R=3;
const RESEARCH_MIN_R=TRADING_CONFIG.researchMinRiskReward;
const RESEARCH_MAX_R=TRADING_CONFIG.researchMaxRiskReward;
const CAPACITY_LOOKBACK=240;
const DEFAULT_CAPACITY_HORIZON=48;
const CAPACITY_QUANTILE=.80;
const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const percentile=(v:number[],q:number)=>{if(!v.length)return 0;const s=[...v].sort((a,b)=>a-b),x=(s.length-1)*Math.max(0,Math.min(1,q)),lo=Math.floor(x),hi=Math.ceil(x);return lo===hi?s[lo]:s[lo]+(s[hi]-s[lo])*(x-lo);};
const atrAt=(bars:MarketBar[],endExclusive:number,period=20)=>{const start=Math.max(1,endExclusive-period),r:number[]=[];for(let i=start;i<endExclusive;i++){const b=bars[i],p=bars[i-1];r.push(Math.max(b.high-b.low,Math.abs(b.high-p.close),Math.abs(b.low-p.close)));}return mean(r);};

/**
 * Historical directional excursion. Every sample's future bars are strictly
 * after that historical decision point; the current signal's score features
 * are never used. The horizon is supplied by the execution layer so a 10R/15R
 * target is not rejected merely because the research gate looked only four
 * hours ahead while the actual trade may remain open for days.
 */
function independentPathCapacity(input:number[]|MarketBar[],side:'LONG'|'SHORT',currentAtr:number,horizonBars:number):number{
 if(!input.length||typeof input[0]==='number'||!(currentAtr>0)||horizonBars<1)return 0;
 const bars=input as MarketBar[],completed=bars.slice(0,-1);
 if(completed.length<horizonBars+40)return 0;
 const first=Math.max(20,completed.length-CAPACITY_LOOKBACK-horizonBars),last=completed.length-horizonBars,samples:number[]=[];
 for(let i=first;i<last;i++){
  const atr=atrAt(completed,i+1);if(!(atr>0)||!Number.isFinite(atr))continue;
  const start=completed[i].close;let mfe=0;
  for(let j=1;j<=horizonBars;j++){const b=completed[i+j],f=side==='LONG'?b.high-start:start-b.low;mfe=Math.max(mfe,f);}
  if(Number.isFinite(mfe)&&mfe>0)samples.push(mfe/atr);
 }
 if(samples.length<20)return 0;
 const capacityAtr=percentile(samples,CAPACITY_QUANTILE);
 return Number.isFinite(capacityAtr)&&capacityAtr>0?currentAtr*capacityAtr:0;
}

export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{
 const minEntryScore=TRADING_CONFIG.minScore,ultraScore=TRADING_CONFIG.ultraScore;
 const entrySignal=evaluateEntryStrategy(input,{...config,minScore:Math.max(minEntryScore,config.minScore??minEntryScore),minRiskReward:ENTRY_MIN_R,maxRiskReward:ENTRY_MAX_R,riskReward:undefined});
 if(entrySignal.action==='WAIT')return entrySignal;
 const risk=Math.abs(entrySignal.entry-entrySignal.stopLoss);
 if(!Number.isFinite(risk)||risk<=0)return{...entrySignal,action:'WAIT',strategy:'No Trade',reasons:[...entrySignal.reasons,'Invalid structural risk distance']};
 const targetR=entrySignal.score>=ultraScore?RESEARCH_MAX_R:RESEARCH_MIN_R,targetDistance=risk*targetR,currentAtr=independentCurrentAtr(input),horizonBars=Math.max(1,Math.floor(config.capacityHorizonBars??DEFAULT_CAPACITY_HORIZON)),independentCapacity=independentPathCapacity(input,entrySignal.action,currentAtr,horizonBars);
 if(!Number.isFinite(independentCapacity)||independentCapacity<=0||targetDistance>independentCapacity){
  if(config.funnel){config.funnel.rejectedPathCapacity++;config.funnel.tradesOpened=Math.max(0,config.funnel.tradesOpened-1);}
  return{...entrySignal,action:'WAIT',strategy:'No Trade',takeProfit:entrySignal.entry,riskReward:0,pathCapacity:independentCapacity,reasons:[...entrySignal.reasons,`${targetR}R target (${targetDistance.toFixed(2)}) exceeds independent historical capacity (${independentCapacity>0?independentCapacity.toFixed(2):'unavailable'}) over ${horizonBars} bars`]};
 }
 const takeProfit=entrySignal.action==='LONG'?entrySignal.entry+targetDistance:entrySignal.entry-targetDistance;
 return{...entrySignal,strategy:'Production Regime Breakout v35',takeProfit,riskReward:targetR,pathCapacity:independentCapacity,reasons:[...entrySignal.reasons.filter(reason=>!reason.startsWith('Target ')),'A+ entry qualified independently from extreme-R research target',`Research target ${targetR}R assigned after entry qualification`,`Independent historical capacity ${independentCapacity.toFixed(2)} supports target distance ${targetDistance.toFixed(2)} over ${horizonBars} bars`]};
}
function independentCurrentAtr(input:number[]|MarketBar[]):number{if(!input.length||typeof input[0]==='number')return 0;const bars=input as MarketBar[];return bars.length>=21?atrAt(bars,bars.length):0;}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
