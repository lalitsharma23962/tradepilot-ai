import type { Side } from './types';
import { TRADING_CONFIG } from './tradingConfig';
import type { MarketBar } from './marketData';
import type { FunnelCounters } from './backtestV6';

export interface StrategySignal { action: Side|'WAIT'; score:number; confidence:number; strategy:string; entry:number; stopLoss:number; takeProfit:number; riskReward:number; family:string; reasons:string[]; }
export interface StrategyConfig { minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number; lookback:number; riskPerTradePct?:number; strategyLimit?:number; feeBps?:number; slippageBps?:number; riskReward?:number; maxStructuralRiskAtr?:number; swingLookback?:number; funnel?:FunnelCounters; }
const DEFAULT_CONFIG:StrategyConfig={minScore:TRADING_CONFIG.minScore,minRiskReward:TRADING_CONFIG.productionMinRiskReward,maxRiskReward:TRADING_CONFIG.productionMaxRiskReward,atrStopMultiple:TRADING_CONFIG.atrStopMultiple,lookback:TRADING_CONFIG.lookback,feeBps:TRADING_CONFIG.feeBps,slippageBps:TRADING_CONFIG.slippageBps,maxStructuralRiskAtr:TRADING_CONFIG.maxStructuralRiskAtr,swingLookback:TRADING_CONFIG.swingLookback};
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const trueAtr=(bars:MarketBar[],p=20)=>{const s=bars.slice(-(p+1));return mean(s.slice(1).map((b,i)=>Math.max(b.high-b.low,Math.abs(b.high-s[i].close),Math.abs(b.low-s[i].close))));};
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const efficiency=(x:number[])=>{if(x.length<3)return 0;const net=Math.abs(x.at(-1)!-x[0]);const path=x.slice(1).reduce((s,v,i)=>s+Math.abs(v-x[i]),0);return path?net/path:0;};
const consistency=(x:number[],side:1|-1)=>{if(x.length<2)return 0;const d=x.slice(1).map((v,i)=>v-x[i]);return d.filter(v=>side===1?v>0:v<0).length/d.length;};
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,family:'none',reasons});
function asBars(input:number[]|MarketBar[]):MarketBar[]{if(!input.length)return[];if(typeof input[0]==='number'){const p=input as number[];return p.map((close,i)=>({openTime:i,open:close,high:close,low:close,close,volume:0}));}return input as MarketBar[];}
function completedHourly(bars:MarketBar[]):MarketBar[]{if(bars.length<8)return[];const steps=bars.slice(1).map((b,i)=>b.openTime-bars[i].openTime).filter(x=>x>0).sort((a,b)=>a-b),step=steps[Math.floor(steps.length/2)]??0;if(step<=0||step>=3600000||3600000%step!==0)return[];const perHour=3600000/step,groups=new Map<number,MarketBar[]>();for(const b of bars){const key=Math.floor(b.openTime/3600000)*3600000;const g=groups.get(key);if(g)g.push(b);else groups.set(key,[b]);}return Array.from(groups.entries()).sort((a,b)=>a[0]-b[0]).filter(([,g])=>g.length===perHour).map(([openTime,g])=>({openTime,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[g.length-1].close,volume:g.reduce((s,x)=>s+x.volume,0)}));}

/** v28: cost-aware multi-family strategy with reachable pullback/continuation triggers. */
export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{
 const cfg={...DEFAULT_CONFIG,...config},bars=asBars(input).filter(b=>Number.isFinite(b.close)&&b.close>0).slice(-cfg.lookback),p=bars.map(b=>b.close),entry=p.at(-1)??0;
 if(cfg.funnel)cfg.funnel.barsEvaluated++;
 if(p.length<160||!entry){if(cfg.funnel)cfg.funnel.insufficientHistory++;return wait(entry,['Not enough history']);}
 const a=trueAtr(bars),aFast=trueAtr(bars,12),aSlow=trueAtr(bars,48),e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),rrsi=rsi(p);
 const s12=slope(p.slice(-12))/entry,s24=slope(p.slice(-24))/entry,s48=slope(p.slice(-48))/entry,eff24=efficiency(p.slice(-24)),eff48=efficiency(p.slice(-48));
 const sep=Math.abs(e20-e50)/Math.max(a,entry*1e-6),expansion=aSlow>0?aFast/aSlow:1,vol=a/entry,cost=2*((cfg.feeBps??10)+(cfg.slippageBps??2))/10000;
 const up=e20>e50&&e50>e100,down=e20<e50&&e50<e100,rangeHigh=Math.max(...p.slice(-21,-1)),rangeLow=Math.min(...p.slice(-21,-1));
 const momentumLong=s12>Math.max(.00001,vol*.0035)&&s24>0&&s48>0,momentumShort=s12<-Math.max(.00001,vol*.0035)&&s24<0&&s48<0;
 const longConsistency=consistency(p.slice(-15),1),shortConsistency=consistency(p.slice(-15),-1),hourly=completedHourly(bars),hp=hourly.map(b=>b.close),h20=ema(hp,20),h40=ema(hp,40),h50=ema(hp,50);
 const hS12=hp.length>=12?slope(hp.slice(-12))/Math.max(entry,1):0,hS24=hp.length>=24?slope(hp.slice(-24))/Math.max(entry,1):0,hEff24=efficiency(hp.slice(-24));
 const hLong=hourly.length>=50?h20>h40&&h40>h50&&hS12>0&&hS24>=-0.000001&&hEff24>=.08:false,hShort=hourly.length>=50?h20<h40&&h40<h50&&hS12<0&&hS24<=0.000001&&hEff24>=.08:false;
 const lastBar=bars.at(-1)!,prevBar=bars.at(-2)!,lastRange=Math.max(lastBar.high-lastBar.low,entry*1e-8),bodyRatio=Math.abs(lastBar.close-lastBar.open)/lastRange,closeLocation=(lastBar.close-lastBar.low)/lastRange;
 const barLong=lastBar.close>lastBar.open&&lastBar.close>=prevBar.close&&bodyRatio>=.22&&closeLocation>=.55,barShort=lastBar.close<lastBar.open&&lastBar.close<=prevBar.close&&bodyRatio>=.22&&closeLocation<=.45;
 const priorVolumes=bars.slice(-21,-1).map(b=>b.volume).filter(v=>Number.isFinite(v)&&v>0),avgVolume=mean(priorVolumes),volumeRatio=avgVolume>0?lastBar.volume/avgVolume:1;
 const breakoutVolumeLong=avgVolume<=0||volumeRatio>=.95,breakoutVolumeShort=avgVolume<=0||volumeRatio>=.95;
 const recentPullbackLong=bars.slice(-8,-1).some(b=>b.close<=e20*1.0015&&b.low<=e20+a*.20),recentPullbackShort=bars.slice(-8,-1).some(b=>b.close>=e20*.9985&&b.high>=e20-a*.20);
 const reclaimLong=entry>e20&&entry>=prevBar.close&&barLong&&bodyRatio>=.25&&closeLocation>=.60,reclaimShort=entry<e20&&entry<=prevBar.close&&barShort&&bodyRatio>=.25&&closeLocation<=.40;
 const pullbackLongLocal=up&&recentPullbackLong&&reclaimLong&&s12>0&&volumeRatio>=.85,pullbackShortLocal=down&&recentPullbackShort&&reclaimShort&&s12<0&&volumeRatio>=.85;
 const breakoutLongLocal=up&&entry>rangeHigh+a*.015&&prevBar.close<=rangeHigh+a*.005&&s12>0&&barLong,breakoutShortLocal=down&&entry<rangeLow-a*.015&&prevBar.close>=rangeLow-a*.005&&s12<0&&barShort;
 const continuationLongLocal=up&&e9>e20&&s24>0&&eff24>=.14&&eff48>=.08&&longConsistency>=.44&&entry>=e20&&Math.abs(entry-e20)<=a*1.75&&entry>=prevBar.close,continuationShortLocal=down&&e9<e20&&s24<0&&eff24>=.14&&eff48>=.08&&shortConsistency>=.44&&entry<=e20&&Math.abs(entry-e20)<=a*1.75&&entry<=prevBar.close;
 const prevBars=bars.slice(0,-3),prevFast=trueAtr(prevBars,12),prevSlow=trueAtr(prevBars,48),prevExpansion=prevSlow>0?prevFast/prevSlow:1,compression=prevExpansion<.95,expanding=expansion>Math.max(.95,prevExpansion*1.03)&&expansion>prevExpansion+.02;
 const compressionLongLocal=up&&compression&&expanding&&s12>0&&entry>e20&&barLong,compressionShortLocal=down&&compression&&expanding&&s12<0&&entry<e20&&barShort;
 const localLong=breakoutLongLocal||pullbackLongLocal||continuationLongLocal||compressionLongLocal,localShort=breakoutShortLocal||pullbackShortLocal||continuationShortLocal||compressionShortLocal;
 const breakoutLong=breakoutLongLocal&&breakoutVolumeLong,breakoutShort=breakoutShortLocal&&breakoutVolumeShort;
 const pullbackLong=pullbackLongLocal&&hLong,pullbackShort=pullbackShortLocal&&hShort;
 const continuationLong=continuationLongLocal&&hLong,continuationShort=continuationShortLocal&&hShort;
 const compressionLong=compressionLongLocal&&hLong,compressionShort=compressionShortLocal&&hShort;
 const familyLong=breakoutLong||pullbackLong||continuationLong||compressionLong,familyShort=breakoutShort||pullbackShort||continuationShort||compressionShort,triggerLong=breakoutLong||pullbackLong||continuationLong||compressionLong,triggerShort=breakoutShort||pullbackShort||continuationShort||compressionShort;
 const longScore=(up?20:0)+(hLong?15:0)+(e9>e20?7:0)+(momentumLong?20:0)+(triggerLong?15:0)+(pullbackLong?4:0)+(breakoutLong?4:0)+(continuationLong?4:0)+(compressionLong?4:0)+(rrsi>=45&&rrsi<=75?7:0)+(costAware?4:0)+(notExtended?3:0),shortScore=(down?20:0)+(hShort?15:0)+(e9<e20?7:0)+(momentumShort?20:0)+(triggerShort?15:0)+(pullbackShort?4:0)+(breakoutShort?4:0)+(continuationShort?4:0)+(compressionShort?4:0)+(rrsi>=25&&rrsi<=55?7:0)+(costAware?4:0)+(notExtended?3:0);
 if(cfg.funnel){
  if(continuationLongLocal||continuationShortLocal)cfg.funnel.familyCandidatesTrend++;
  if((breakoutLongLocal&&breakoutVolumeLong)||(breakoutShortLocal&&breakoutVolumeShort))cfg.funnel.familyCandidatesBreakout++;
  if(pullbackLongLocal||pullbackShortLocal)cfg.funnel.familyCandidatesRetest++;
  if(compressionLongLocal||compressionShortLocal)cfg.funnel.familyCandidatesCompression++;
  const anyLocalPattern=localLong||localShort,anyHtf=hLong||hShort;
  if(!familyLong&&!familyShort){
   if(!anyLocalPattern)cfg.funnel.noLocalPattern++;
   else if(!(momentumLong||momentumShort))cfg.funnel.rejectedMomentum++;
   else if(!anyHtf)cfg.funnel.rejectedHtf++;
   else cfg.funnel.rejectedScore++;
  }
 }
 const minScore=Math.max(80,cfg.minScore),side:Side|null=familyLong&&longScore>=minScore&&longScore>=shortScore?'LONG':familyShort&&shortScore>=minScore?'SHORT':null,score=side==='LONG'?longScore:side==='SHORT'?shortScore:Math.max(longScore,shortScore);
 if(!side)return wait(entry,['No setup family passed the local trigger, completed-hour regime, momentum and cost gate'],score);
 const look=cfg.swingLookback??5,recent=bars.slice(-look),swingLow=Math.min(...recent.map(b=>b.low)),swingHigh=Math.max(...recent.map(b=>b.high)),floor=Math.max(entry*.0008,a*.55),rawRisk=side==='LONG'?Math.max(entry-swingLow,floor):Math.max(swingHigh-entry,floor),cap=a*(cfg.maxStructuralRiskAtr??1.35),riskFloor=Math.max(a*(cfg.atrStopMultiple??1.5)*.65,entry*cost*1.75,entry*.0008,a*.55);
 if(rawRisk>cap){if(cfg.funnel)cfg.funnel.rejectedStructuralStop++;return wait(entry,[`Structural stop ${(rawRisk/a).toFixed(2)} ATR exceeds ${(cfg.maxStructuralRiskAtr??1.35).toFixed(2)} ATR ceiling`],score);}
 if(riskFloor>cap){if(cfg.funnel)cfg.funnel.rejectedRiskFloor++;return wait(entry,[`Minimum cost/ATR risk ${(riskFloor/a).toFixed(2)} ATR exceeds ${(cfg.maxStructuralRiskAtr??1.35).toFixed(2)} ATR ceiling`],score);}
 const risk=Math.max(rawRisk,riskFloor),minRR=cfg.minRiskReward??1.5,maxRR=cfg.maxRiskReward??3,ultra=TRADING_CONFIG.ultraScore,rrOverride=cfg.riskReward,rr=rrOverride??clamp(minRR+(maxRR-minRR)*clamp((score-(cfg.minScore??TRADING_CONFIG.minScore))/Math.max(1,ultra-(cfg.minScore??TRADING_CONFIG.minScore)),0,1),minRR,maxRR),targetDistance=risk*rr,pathCapacity=a*(8+28*eff24+8*sep+8*Math.max(0,expansion-1)+5*eff48);
 if(targetDistance>pathCapacity){if(cfg.funnel)cfg.funnel.rejectedPathCapacity++;return wait(entry,[`${rr.toFixed(1)}R target exceeds measured path capacity`],score);}
 const stopLoss=side==='LONG'?entry-risk:entry+risk,takeProfit=side==='LONG'?entry+targetDistance:entry-targetDistance,family=breakoutLong||breakoutShort?'breakout':continuationLong||continuationShort?'trend':pullbackLong||pullbackShort?'retest':'compression',familyLabel=family==='breakout'?'Fresh breakout':family==='retest'?'EMA20 pullback/reclaim':family==='compression'?'Compression expansion':'Trend continuation';
 if(cfg.funnel)cfg.funnel.tradesOpened++;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Regime Breakout v28',entry,stopLoss,takeProfit,riskReward:rr,family,reasons:[familyLabel,side==='LONG'?'Bullish local + completed-hour regime':'Bearish local + completed-hour regime','Multi-horizon momentum','Real OHLC ATR structural stop','Cost-aware risk distance',`Target ${rr.toFixed(1)}R`,`Score ${Math.round(score)}/100`]};
}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,{...config,minRiskReward:config.minRiskReward??1.5,maxRiskReward:config.maxRiskReward??3});}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
