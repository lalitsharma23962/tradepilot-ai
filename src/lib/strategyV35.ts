import { evaluateProductionStrategy as evaluateEntryStrategy, type StrategyConfig, type StrategySignal } from './strategyV32';
export type { StrategyConfig, StrategySignal } from './strategyV32';
import type { MarketBar } from './marketData';
import { TRADING_CONFIG } from './tradingConfig';
import { runnerProtectedStop } from './runnerProtection';

const ENTRY_MIN_R=TRADING_CONFIG.productionMinRiskReward;
const ENTRY_MAX_R=TRADING_CONFIG.productionMaxRiskReward;
const TARGET_CANDIDATES=[2,2.5,3,3.5,4] as const;
const DEFAULT_CAPACITY_HORIZON=TRADING_CONFIG.maxBarsInTrade['5m'];
export const MIN_INDEPENDENT_SAMPLES=TRADING_CONFIG.capacitySamples;

const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const percentile=(v:number[],q:number)=>{if(!v.length)return 0;const s=[...v].sort((a,b)=>a-b),x=(s.length-1)*Math.max(0,Math.min(1,q)),lo=Math.floor(x),hi=Math.ceil(x);return lo===hi?s[lo]:s[lo]+(s[hi]-s[lo])*(x-lo);};
const atrAt=(bars:MarketBar[],endExclusive:number,period=20)=>{const start=Math.max(1,endExclusive-period),ranges:number[]=[];for(let i=start;i<endExclusive;i++){const b=bars[i],p=bars[i-1];ranges.push(Math.max(b.high-b.low,Math.abs(b.high-p.close),Math.abs(b.low-p.close)));}return mean(ranges);};
interface CapacityEvidence{capacityPrice:number;targetBeforeStopRate:number;samples:number;}

/**
 * Causal historical feasibility test.
 *
 * Samples are deliberately non-overlapping: every episode is exactly
 * horizonBars long and the next sample starts horizonBars earlier. The
 * decision bar itself is excluded from `completed`, so the test cannot see
 * the future bar used to make the current decision.
 */
function independentPathCapacity(input:MarketBar[],side:'LONG'|'SHORT',currentAtr:number,currentRisk:number,targetR:number,horizonBars:number,capacityQuantile:number):CapacityEvidence{
 const unavailable={capacityPrice:0,targetBeforeStopRate:0,samples:0};
 if(!input.length||!(currentAtr>0)||!(currentRisk>0)||horizonBars<1)return unavailable;
 const completed=input.slice(0,-1);
 const requiredLookback=MIN_INDEPENDENT_SAMPLES*horizonBars;
 if(completed.length<requiredLookback+horizonBars+21)return unavailable;
 const lastStart=completed.length-horizonBars;
 const firstStart=Math.max(20,lastStart-requiredLookback);
 if(lastStart<=firstStart)return unavailable;
 const riskAtr=currentRisk/currentAtr;
 if(!Number.isFinite(riskAtr)||riskAtr<=0)return unavailable;
 const runnerSide=side==='LONG'?1:-1,excursions:number[]=[],targetHits:number[]=[];
 let samples=0,targetBeforeStop=0;
 for(let i=lastStart-1;i>=firstStart;i-=horizonBars){
  const sampleAtr=atrAt(completed,i+1);if(!(sampleAtr>0)||!Number.isFinite(sampleAtr))continue;
  const start=completed[i].close,stopDistance=riskAtr*sampleAtr,targetDistance=targetR*stopDistance;
  if(!(stopDistance>0)||!(targetDistance>0))continue;
  let mfe=0,simulatedStop=runnerSide===1?start-stopDistance:start+stopDistance;
  const simulatedTarget=runnerSide===1?start+targetDistance:start-targetDistance;
  let outcome:'TARGET'|'STOP'|'TIMEOUT'='TIMEOUT';
  for(let j=1;j<=horizonBars;j++){
   const b=completed[i+j],favorable=side==='LONG'?b.high-start:start-b.low;mfe=Math.max(mfe,favorable);
   const hitStop=side==='LONG'?b.low<=simulatedStop:b.high>=simulatedStop;
   const hitTarget=side==='LONG'?b.high>=simulatedTarget:b.low<=simulatedTarget;
   if(hitStop){outcome='STOP';break;}
   if(hitTarget){outcome='TARGET';break;}
   simulatedStop=runnerProtectedStop(runnerSide,start,simulatedTarget,simulatedStop,b.high,b.low);
  }
  excursions.push(mfe/sampleAtr);targetHits.push(outcome==='TARGET'?1:0);samples++;if(outcome==='TARGET')targetBeforeStop++;
 }
 if(samples<MIN_INDEPENDENT_SAMPLES)return unavailable;
 const capacityAtr=percentile(excursions,capacityQuantile);
 return{capacityPrice:Number.isFinite(capacityAtr)&&capacityAtr>0?currentAtr*capacityAtr:0,targetBeforeStopRate:targetBeforeStop/samples,samples};
}

function economicHitRate(targetR:number,costInR:number):number{
 const pf=TRADING_CONFIG.minProfitFactor;
 if(!Number.isFinite(costInR)||targetR<=costInR)return 1;
 return Math.max(0,Math.min(1,(pf*(1+costInR))/((targetR-costInR)+pf*(1+costInR))));
}

export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{
 const extended=config as Partial<StrategyConfig>&{capacityBars?:MarketBar[]};
 const minEntryScore=TRADING_CONFIG.minScore,ultraScore=TRADING_CONFIG.ultraScore;
 const entrySignal=evaluateEntryStrategy(input,{...config,minScore:Math.max(minEntryScore,config.minScore??minEntryScore),minRiskReward:ENTRY_MIN_R,maxRiskReward:ENTRY_MAX_R,riskReward:undefined,skipLegacyPathCapacity:true});
 if(entrySignal.action==='WAIT')return entrySignal;
 const risk=Math.abs(entrySignal.entry-entrySignal.stopLoss);
 if(!Number.isFinite(risk)||risk<=0)return{...entrySignal,action:'WAIT',strategy:'No Trade',reasons:[...entrySignal.reasons,'Invalid structural risk distance']};
 const capacityBars=extended.capacityBars??(Array.isArray(input)&&input.length&&typeof input[0]!=='number'?input as MarketBar[]:[]);
 const currentAtr=capacityBars.length>=21?atrAt(capacityBars,capacityBars.length):0;
 const horizonBars=Math.max(1,Math.floor(config.capacityHorizonBars??DEFAULT_CAPACITY_HORIZON));
 const roundTripCost=2*((config.feeBps??TRADING_CONFIG.feeBps)+(config.slippageBps??TRADING_CONFIG.slippageBps))/10000;
 const costInR=risk>0?roundTripCost*entrySignal.entry/risk:Infinity;
 let chosenR=0,chosen:CapacityEvidence|null=null,chosenRequired=1;
 for(const targetR of TARGET_CANDIDATES){
  const required=economicHitRate(targetR,costInR);
  const capacityQuantile=1-required;
  const evidence=independentPathCapacity(capacityBars,entrySignal.action,currentAtr,risk,targetR,horizonBars,capacityQuantile);
  const targetDistance=risk*targetR;
  const pass=evidence.samples>=MIN_INDEPENDENT_SAMPLES&&evidence.targetBeforeStopRate>=required&&evidence.capacityPrice>=targetDistance;
  if(pass){chosenR=targetR;chosen=evidence;chosenRequired=required;}
 }
 if(!chosen||!chosenR){if(config.funnel)config.funnel.rejectedPathCapacity++;return{...entrySignal,action:'WAIT',strategy:'No Trade',takeProfit:entrySignal.entry,riskReward:0,pathCapacity:chosen?.capacityPrice??0,reasons:[...entrySignal.reasons,'No target in the statistically feasible 2R-4R band clears its economic hurdle']};}
 const targetDistance=risk*chosenR,takeProfit=entrySignal.action==='LONG'?entrySignal.entry+targetDistance:entrySignal.entry-targetDistance;
 if(config.funnel)config.funnel.tradesOpened++;
 const quality=entrySignal.score>=ultraScore?'ultra-conviction':'qualified';
 return{...entrySignal,strategy:'Production Regime Breakout v36',takeProfit,riskReward:chosenR,pathCapacity:chosen.capacityPrice,reasons:[...entrySignal.reasons.filter(r=>!r.startsWith('Target ')),`v36 ${quality} entry qualified independently of target size`,`Dynamic target ${chosenR.toFixed(1)}R selected from 2R-4R`,`Independent capacity ${chosen.capacityPrice.toFixed(2)} supports ${targetDistance.toFixed(2)} target distance`,`Historical target-before-stop rate ${(chosen.targetBeforeStopRate*100).toFixed(1)}% clears ${(chosenRequired*100).toFixed(1)}% economic hurdle`,`${chosen.samples} non-overlapping historical capacity episodes`]};
}

function independentCurrentAtr(input:number[]|MarketBar[]):number{if(!input.length||typeof input[0]==='number')return 0;const bars=input as MarketBar[];return bars.length>=21?atrAt(bars,bars.length):0;}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
