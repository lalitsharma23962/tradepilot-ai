import type { Side } from './types';
import type { MarketBar } from './marketData';
import type { StrategyConfig, StrategySignal } from './strategyV32';
import { TRADING_CONFIG } from './tradingConfig';
import { runnerProtectedStop } from './runnerProtection';
import { calculateCostInR } from '../engine/units';
export type { StrategyConfig, StrategySignal } from './strategyV32';

// v38: production uses one fixed 2R final target; economic viability is evaluated in R-units.
const TARGET_CANDIDATES=[2] as const;
const DEFAULT_CAPACITY_HORIZON=TRADING_CONFIG.maxBarsInTrade['5m'];
export const MIN_INDEPENDENT_SAMPLES=TRADING_CONFIG.capacitySamples;
const mean=(v:number[])=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const std=(v:number[])=>{const m=mean(v);return v.length>1?Math.sqrt(mean(v.map(x=>(x-m)**2))):0;};
const ema=(v:number[],p:number)=>{if(!v.length)return 0;const k=2/(p+1);let e=v[0];for(let i=1;i<v.length;i++)e=v[i]*k+e*(1-k);return e;};
const atrAt=(bars:MarketBar[],endExclusive:number,period=20)=>{const start=Math.max(1,endExclusive-period),ranges:number[]=[];for(let i=start;i<endExclusive;i++){const b=bars[i],p=bars[i-1];ranges.push(Math.max(b.high-b.low,Math.abs(b.high-p.close),Math.abs(b.low-p.close)));}return mean(ranges);};
const efficiency=(v:number[])=>{if(v.length<3)return 0;const net=Math.abs(v.at(-1)!-v[0]);const path=v.slice(1).reduce((s,x,i)=>s+Math.abs(x-v[i]),0);return path?net/path:0;};
const slope=(v:number[])=>{if(v.length<2)return 0;const n=v.length,xm=(n-1)/2,ym=mean(v);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(v[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const consistency=(v:number[],side:1|-1)=>{if(v.length<2)return 0;const d=v.slice(1).map((x,i)=>x-v[i]);return d.filter(x=>side===1?x>0:x<0).length/d.length;};
const rsi=(v:number[])=>{const s=v.slice(-15),d=s.slice(1).map((x,i)=>x-s[i]),g=mean(d.map(x=>Math.max(x,0))),l=mean(d.map(x=>Math.max(-x,0)));return l?100-100/(1+g/l):50;};
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,family:'none',pathCapacity:0,reasons});
interface CapacityEvidence{capacityPrice:number;targetBeforeStopRate:number;samples:number;}
function independentPathCapacity(input:MarketBar[],side:Side,currentAtr:number,currentRisk:number,targetR:number,horizonBars:number,capacityQuantile:number):CapacityEvidence{
 const unavailable={capacityPrice:0,targetBeforeStopRate:0,samples:0};
 if(!input.length||!(currentAtr>0)||!(currentRisk>0)||horizonBars<1)return unavailable;
 const completed=input.slice(0,-1),requiredLookback=MIN_INDEPENDENT_SAMPLES*horizonBars;
 if(completed.length<requiredLookback+horizonBars+21)return unavailable;
 const lastStart=completed.length-horizonBars,firstStart=Math.max(20,lastStart-requiredLookback);
 if(lastStart<=firstStart)return unavailable;
 const riskAtr=currentRisk/currentAtr;if(!Number.isFinite(riskAtr)||riskAtr<=0)return unavailable;
 const runnerSide=side==='LONG'?1:-1,excursions:number[]=[];let samples=0,targetBeforeStop=0;
 for(let i=lastStart-1;i>=firstStart;i-=horizonBars){
  const sampleAtr=atrAt(completed,i+1);if(!(sampleAtr>0)||!Number.isFinite(sampleAtr))continue;
  const start=completed[i].close,stopDistance=riskAtr*sampleAtr,targetDistance=targetR*stopDistance;if(!(stopDistance>0)||!(targetDistance>0))continue;
  let mfe=0,simulatedStop=runnerSide===1?start-stopDistance:start+stopDistance;const simulatedTarget=runnerSide===1?start+targetDistance:start-targetDistance;let outcome:'TARGET'|'STOP'|'TIMEOUT'='TIMEOUT';
  for(let j=1;j<=horizonBars;j++){const b=completed[i+j],favorable=side==='LONG'?b.high-start:start-b.low;mfe=Math.max(mfe,favorable);const hitStop=side==='LONG'?b.low<=simulatedStop:b.high>=simulatedStop;const hitTarget=side==='LONG'?b.high>=simulatedTarget:b.low<=simulatedTarget;if(hitTarget){outcome='TARGET';break;}if(hitStop){outcome='STOP';break;}}
  excursions.push(mfe/sampleAtr);samples++;if(outcome==='TARGET')targetBeforeStop++;
 }
 if(samples<MIN_INDEPENDENT_SAMPLES)return unavailable;const capacityAtr=percentile(excursions,capacityQuantile);return{capacityPrice:Number.isFinite(capacityAtr)&&capacityAtr>0?currentAtr*capacityAtr:0,targetBeforeStopRate:samples>0?targetBeforeStop/samples:0,samples};
}
const percentile=(v:number[],q:number)=>{if(!v.length)return 0;const s=[...v].sort((a,b)=>a-b),x=(s.length-1)*clamp(q,0,1),lo=Math.floor(x),hi=Math.ceil(x);return lo===hi?s[lo]:s[lo]+(s[hi]-s[lo])*(x-lo);};
const economicHitRate=(targetR:number,costInR:number)=>{const pf=TRADING_CONFIG.minProfitFactor;if(!Number.isFinite(costInR)||targetR<=costInR)return 1;return clamp((pf*(1+costInR))/((targetR-costInR)*pf+costInR),0,1);};
function completedHourly(bars:MarketBar[]):MarketBar[]{if(bars.length<8)return[];const steps=bars.slice(1).map((b,i)=>b.openTime-bars[i].openTime).filter(x=>x>0).sort((a,b)=>a-b),step=steps[Math.floor(steps.length/2)]??0;if(step<=0||step>=3600000||3600000%step!==0)return[];const perHour=3600000/step,groups=new Map<number,MarketBar[]>();for(const b of bars){const key=Math.floor(b.openTime/3600000)*3600000;const g=groups.get(key);if(g)g.push(b);else groups.set(key,[b]);}return Array.from(groups.entries()).sort((a,b)=>a[0]-b[0]).filter(([,g])=>g.length===perHour).map(([openTime,g])=>({openTime,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[g.length-1].close,volume:g.reduce((s,x)=>s+x.volume,0)}));}

export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{
 const cfg=config as Partial<StrategyConfig>&{capacityBars?:MarketBar[]};const raw=Array.isArray(input)&&input.length&&typeof input[0]!=='number'?input as MarketBar[]:(input as number[]).map((close,i)=>({openTime:i,open:close,high:close,low:close,close,volume:0})),bars=raw.filter(b=>Number.isFinite(b.close)&&b.close>0).slice(-(cfg.lookback??TRADING_CONFIG.lookback)),p=bars.map(b=>b.close),entry=p.at(-1)??0;
 if(cfg.funnel)cfg.funnel.barsEvaluated++;if(p.length<160||!entry){if(cfg.funnel)cfg.funnel.insufficientHistory++;return wait(entry,['Not enough history']);}
 const a=atrAt(bars,bars.length,20),aFast=atrAt(bars,bars.length,12),aSlow=atrAt(bars,bars.length,48);if(!(a>0)||!(aSlow>0))return wait(entry,['Invalid ATR state']);
 const e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),s12=slope(p.slice(-12))/entry,s24=slope(p.slice(-24))/entry,s48=slope(p.slice(-48))/entry,eff24=efficiency(p.slice(-24)),eff48=efficiency(p.slice(-48)),longCons=consistency(p.slice(-15),1),shortCons=consistency(p.slice(-15),-1),vol=a/entry,sep=Math.abs(e20-e50)/Math.max(a,entry*1e-6);
 const up=e20>e50&&e50>e100,down=e20<e50&&e50<e100,last=bars.at(-1)!,prev=bars.at(-2)!,range=Math.max(last.high-last.low,entry*1e-8),body=Math.abs(last.close-last.open)/range,closeLoc=(last.close-last.low)/range;
 const priorVol=bars.slice(-21,-1).map(b=>b.volume).filter(v=>Number.isFinite(v)&&v>0),avgVol=mean(priorVol),volumeRatio=avgVol>0?last.volume/avgVol:1,volumeHealthy=avgVol<=0||volumeRatio>=.70,hourly=completedHourly(bars),hp=hourly.map(b=>b.close),h20=ema(hp,20),h40=ema(hp,40),h50=ema(hp,50);
 const hS12=hp.length>=12?slope(hp.slice(-12))/Math.max(entry,1):0,hS24=hp.length>=24?slope(hp.slice(-24))/Math.max(entry,1):0,hEff24=efficiency(hp.slice(-24));
 const hLong=hourly.length>=50?h20>h40&&h40>h50&&hS12>0&&hS24>=0&&hEff24>=.12:true,hShort=hourly.length>=50?h20<h40&&h40<h50&&hS12<0&&hS24<=0&&hEff24>=.12:true;
 const longDirectional=(up?1:0)+(s24>0?1:0)+(s48>0?1:0)+(eff24>=.14?1:0)+(eff48>=.10?1:0)+(longCons>=.47?1:0)+(sep>=.025?1:0),shortDirectional=(down?1:0)+(s24<0?1:0)+(s48<0?1:0)+(eff24>=.14?1:0)+(eff48>=.10?1:0)+(shortCons>=.47?1:0)+(sep>=.025?1:0);
 const cost=2*((cfg.feeBps??TRADING_CONFIG.feeBps)+(cfg.slippageBps??TRADING_CONFIG.slippageBps))/10000,costAware=vol>=Math.max(.00020,cost*.40)&&vol<=.05,rangeHigh=Math.max(...p.slice(-21,-1)),rangeLow=Math.min(...p.slice(-21,-1));
 const prevFast=atrAt(bars.slice(0,-3),Math.max(0,bars.length-3),12),prevSlow=atrAt(bars.slice(0,-3),Math.max(0,bars.length-3),48),prevExpansion=prevSlow>0?prevFast/prevSlow:1,compression=prevExpansion<.85,expanding=a>aSlow*.85;
 const directionalLong=longDirectional>=4,directionalShort=shortDirectional>=4,rangeRegime=entry>rangeLow+a*.15&&entry<rangeHigh-a*.15&&vol<.01;
 if(!directionalLong&&!directionalShort&&!rangeRegime){if(cfg.funnel)cfg.funnel.noLocalPattern++;return wait(entry,['Insufficient directional/range evidence']);}
 const familyScore=(family:string,side:Side)=>{const long=side==='LONG',dir=long?longDirectional:shortDirectional,mom=long?hLong:hShort,cons=long?longCons:shortCons,bar=long?body>.25&&closeLoc>=.40:body>.25&&closeLoc<=.60,vol_=volumeHealthy;let s=dir*8;if(mom)s+=12;if(cons>=.60)s+=8;if(bar)s+=5;if(vol_)s+=3;if(family==='trend'&&(long?up:down))s+=10;if(family==='breakout'&&compression&&expanding)s+=12;if(family==='compression'&&compression)s+=8;return Math.max(0,s);};
 const candidates:{side:Side;family:string;score:number}[]=[];for(const side of ['LONG','SHORT'] as Side[]){const directional=side==='LONG'?directionalLong:directionalShort;if(directional){for(const family of ['trend','breakout','compression'] as const){candidates.push({side,family,score:familyScore(family,side)});}}}
 if(cfg.funnel){for(const c of candidates){if(c.family==='trend')cfg.funnel.familyCandidatesTrend++;if(c.family==='breakout')cfg.funnel.familyCandidatesBreakout++;if(c.family==='compression')cfg.funnel.familyCandidatesCompression++;}}
 const minScore=cfg.minScore??TRADING_CONFIG.minScore;const winner=candidates.find(x=>x.score>=minScore);const score=winner?.score??(candidates[0]?.score??0);
 if(!winner){if(cfg.funnel)cfg.funnel.rejectedScore++;return wait(entry,['No candidate reached the entry-quality conviction score'],score);}
 const side=winner.side,family=winner.family,swingLook=cfg.swingLookback??TRADING_CONFIG.swingLookback,recent=bars.slice(-Math.max(3,swingLook)),swingLow=Math.min(...recent.map(b=>b.low)),swingHigh=Math.max(...recent.map(b=>b.high));
 const atrStopMultiple=cfg.atrStopMultiple??TRADING_CONFIG.atrStopMultiple;
 const rawRisk=side==='LONG'?Math.max(entry-swingLow,a*atrStopMultiple):Math.max(swingHigh-entry,a*atrStopMultiple),minRisk=a*(cfg.minStopAtr??TRADING_CONFIG.minStopAtr),maxRisk=a*(cfg.maxStructuralRiskAtr??TRADING_CONFIG.maxStructuralRiskAtr);
 if(rawRisk<minRisk){if(cfg.funnel)cfg.funnel.rejectedRiskFloor++;return wait(entry,['Structural risk is below the minimum ATR floor'],score);}if(rawRisk>maxRisk){if(cfg.funnel)cfg.funnel.rejectedStructuralStop++;return wait(entry,['Structural risk exceeds the maximum ATR ceiling'],score);}
 const risk=rawRisk,stopPrice=side==='LONG'?entry-risk:entry+risk,costInR=calculateCostInR(entry,stopPrice,cfg.feeBps??TRADING_CONFIG.feeBps,cfg.slippageBps??TRADING_CONFIG.slippageBps);
 if(costInR>0.15){if(cfg.funnel)cfg.funnel.rejectedRiskFloor++;return wait(entry,[`Round-trip friction is ${costInR.toFixed(3)}R, above the 0.15R maximum`],score);}
 const capacityBars=cfg.capacityBars??(raw.length?raw:[]),currentAtr=capacityBars.length>=21?atrAt(capacityBars,capacityBars.length):0,horizonBars=Math.max(1,Math.floor(cfg.capacityHorizonBars??DEFAULT_CAPACITY_HORIZON));
 let chosen=null,chosenR=null,chosenEvidence:CapacityEvidence|null=null;
 for(const targetR of TARGET_CANDIDATES){const required=economicHitRate(targetR,costInR),evidence=independentPathCapacity(capacityBars,side,currentAtr,risk,targetR,horizonBars,1-required);if(evidence.capacityPrice>0&&evidence.targetBeforeStopRate>=required){chosen='feasible';chosenR=targetR;chosenEvidence=evidence;break;}}
 if(!chosen||!chosenR||!chosenEvidence){if(cfg.funnel)cfg.funnel.rejectedPathCapacity++;return wait(entry,['Entry quality passed, but the fixed 2R target is not historically feasible after costs'],score);}
 const targetDistance=risk*chosenR,takeProfit=side==='LONG'?entry+targetDistance:entry-targetDistance;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Regime Breakout v38',entry,stopLoss:stopPrice,takeProfit,riskReward:chosenR,family,pathCapacity:chosenEvidence.capacityPrice,reasons:['Multi-horizon directional evidence','Real OHLC ATR structural stop',`Fixed ${chosenR}R target`,`Path capacity ${chosenEvidence.targetBeforeStopRate.toFixed(2)} target-before-stop rate`]};
}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
