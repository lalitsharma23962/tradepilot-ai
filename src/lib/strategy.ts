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
/** v28: cost-aware multi-family strategy with local-quality fallback for HTF regime gaps. */
export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{
 const cfg={...DEFAULT_CONFIG,...config},bars=asBars(input).filter(b=>Number.isFinite(b.close)&&b.close>0).slice(-cfg.lookback),p=bars.map(b=>b.close),entry=p.at(-1)??0;
 if(cfg.funnel)cfg.funnel.barsEvaluated++;
 if(p.length<160||!entry){if(cfg.funnel)cfg.funnel.insufficientHistory++;return wait(entry,['Not enough history']);}
 const a=trueAtr(bars),aFast=trueAtr(bars,12),aSlow=trueAtr(bars,48),e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),rrsi=rsi(p);
 const s12=slope(p.slice(-12))/entry,s24=slope(p.slice(-24))/entry,s48=slope(p.slice(-48))/entry,eff24=efficiency(p.slice(-24)),eff48=efficiency(p.slice(-48));
 const sep=Math.abs(e20-e50)/Math.max(a,entry*1e-6),expansion=aSlow>0?aFast/aSlow:1,vol=a/entry,cost=2*((cfg.feeBps??10)+(cfg.slippageBps??2))/10000;
 const up=e20>e50&&e50>e100,down=e20<e50&&e50<e100,rangeHigh=Math.max(...p.slice(-21,-1)),rangeLow=Math.min(...p.slice(-21,-1));
 const momentumLong=s12>Math.max(.00001,vol*.006)&&s24>0&&s48>0,momentumShort=s12<-Math.max(.00001,vol*.006)&&s24<0&&s48<0;
 const longConsistency=consistency(p.slice(-15),1),shortConsistency=consistency(p.slice(-15),-1),hourly=completedHourly(bars),hp=hourly.map(b=>b.close),h20=ema(hp,20),h40=ema(hp,40),h50=ema(hp,50);
 const hS12=hp.length>=12?slope(hp.slice(-12))/Math.max(entry,1):0,hS24=hp.length>=24?slope(hp.slice(-24))/Math.max(entry,1):0,hEff24=efficiency(hp.slice(-24));
 // HTF is a confirmation, not a universal AND gate. When the hourly history is
 // incomplete or too noisy, a deliberately strong local regime can stand in for
 // it. This avoids turning a 60-hour lookback into a near-zero-trade strategy.
 const hLong=hourly.length>=50?h20>h40&&h40>h50&&hS12>0&&hS24>=0&&hEff24>=.10:false,hShort=hourly.length>=50?h20<h40&&h40<h50&&hS12<0&&hS24<=0&&hEff24>=.10:false;
 const strongLocalLong=up&&s24>0&&s48>0&&eff24>=.24&&eff48>=.16&&longConsistency>=.53&&sep>=.05;
 const strongLocalShort=down&&s24<0&&s48<0&&eff24>=.24&&eff48>=.16&&shortConsistency>=.53&&sep>=.05;
 const regimeLong=hLong||strongLocalLong,regimeShort=hShort||strongLocalShort;
 const momentumLongAligned=momentumLong&&regimeLong,momentumShortAligned=momentumShort&&regimeShort;
 const prevBars=bars.slice(0,-3),prevFast=trueAtr(prevBars,12),prevSlow=trueAtr(prevBars,48),prevExpansion=prevSlow>0?prevFast/prevSlow:1;
 const compression=prevExpansion<.90,expanding=expansion>=1.00&&expansion>prevExpansion+.05;
 const lastBar=bars.at(-1)!,prevBar=bars.at(-2)!;
 const lastRange=Math.max(lastBar.high-lastBar.low,entry*1e-8),bodyRatio=Math.abs(lastBar.close-lastBar.open)/lastRange,closeLocation=(lastBar.close-lastBar.low)/lastRange;
 const barLong=lastBar.close>lastBar.open&&lastBar.close>prevBar.close&&bodyRatio>=.30&&closeLocation>=.58;
 const barShort=lastBar.close<lastBar.open&&lastBar.close<prevBar.close&&bodyRatio>=.30&&closeLocation<=.42;
 const priorVolumes=bars.slice(-21,-1).map(b=>b.volume).filter(v=>Number.isFinite(v)&&v>0),avgVolume=mean(priorVolumes),volumeRatio=avgVolume>0?lastBar.volume/avgVolume:1;
 const breakoutVolumeLong=avgVolume<=0||volumeRatio>=1.05,breakoutVolumeShort=avgVolume<=0||volumeRatio>=1.05;
 const trendLong=up&&regimeLong&&eff24>=.20&&eff48>=.15&&longConsistency>=.50&&sep>=.04&&barLong;
 const trendShort=down&&regimeShort&&eff24>=.20&&eff48>=.15&&shortConsistency>=.50&&sep>=.04&&barShort;
 // Retest now means a recent EMA20 reclaim/rejection on the decision candle,
 // rather than any touch somewhere in the preceding 10 bars. This removes stale
 // "retest" labels that were contributing weak signals to the live set.
 const retestLong=up&&regimeLong&&entry>e20&&prevBar.close<=e20*1.003&&momentumLongAligned&&barLong;
 const retestShort=down&&regimeShort&&entry<e20&&prevBar.close>=e20*.997&&momentumShortAligned&&barShort;
 // Breakouts require the decision candle to close through the prior range with
 // directional body/volume confirmation, reducing one-bar wick breakouts.
 const breakoutLong=entry>rangeHigh+a*.08&&prevBar.close<=rangeHigh&&momentumLongAligned&&barLong&&breakoutVolumeLong;
 const breakoutShort=entry<rangeLow-a*.08&&prevBar.close>=rangeLow&&momentumShortAligned&&barShort&&breakoutVolumeShort;
 const compressionLong=up&&regimeLong&&compression&&expanding&&momentumLongAligned&&entry>e20&&barLong;
 const compressionShort=down&&regimeShort&&compression&&expanding&&momentumShortAligned&&entry<e20&&barShort;
 const costAware=vol>=Math.max(.00025,cost*.45)&&vol<=.05,notExtended=Math.abs(entry-e20)<=a*2.5,longFamily=breakoutLong||retestLong||compressionLong||trendLong,shortFamily=breakoutShort||retestShort||compressionShort||trendShort;
 const longScore=(up?20:0)+(regimeLong?12:0)+(strongLocalLong?10:0)+(e9>e20?7:0)+(momentumLongAligned?18:0)+(trendLong?12:0)+(breakoutLong?15:0)+(retestLong?14:0)+(compressionLong?13:0)+(rrsi>=45&&rrsi<=75?7:0)+(costAware?6:0)+(notExtended?5:0);
 const shortScore=(down?20:0)+(regimeShort?12:0)+(strongLocalShort?10:0)+(e9<e20?7:0)+(momentumShortAligned?18:0)+(trendShort?12:0)+(breakoutShort?15:0)+(retestShort?14:0)+(compressionShort?13:0)+(rrsi>=25&&rrsi<=55?7:0)+(costAware?6:0)+(notExtended?5:0);
 const minScore=Math.max(80,cfg.minScore),side:Side|null=longFamily&&longScore>=minScore&&longScore>=shortScore?'LONG':shortFamily&&shortScore>=minScore?'SHORT':null,score=side==='LONG'?longScore:side==='SHORT'?shortScore:Math.max(longScore,shortScore);
 if(cfg.funnel){
  const patTrendLong=up&&eff24>=.20&&eff48>=.15&&longConsistency>=.50&&sep>=.04,patTrendShort=down&&eff24>=.20&&eff48>=.15&&shortConsistency>=.50&&sep>=.04;
  const patBreakoutLong=entry>rangeHigh+a*.08&&prevBar.close<=rangeHigh&&barLong&&breakoutVolumeLong,patBreakoutShort=entry<rangeLow-a*.08&&prevBar.close>=rangeLow&&barShort&&breakoutVolumeShort;
  const patRetestLong=up&&entry>e20&&prevBar.close<=e20*1.003&&barLong,patRetestShort=down&&entry<e20&&prevBar.close>=e20*.997&&barShort;
  const patCompressionLong=up&&compression&&expanding&&entry>e20&&barLong,patCompressionShort=down&&compression&&expanding&&entry<e20&&barShort;
  if(patTrendLong||patTrendShort)cfg.funnel.familyCandidatesTrend++;
  if(patBreakoutLong||patBreakoutShort)cfg.funnel.familyCandidatesBreakout++;
  if(patRetestLong||patRetestShort)cfg.funnel.familyCandidatesRetest++;
  if(patCompressionLong||patCompressionShort)cfg.funnel.familyCandidatesCompression++;
  const anyPattern=patTrendLong||patTrendShort||patBreakoutLong||patBreakoutShort||patRetestLong||patRetestShort||patCompressionLong||patCompressionShort;
  if(!side){
   if(!anyPattern)cfg.funnel.noLocalPattern++;
   else if(!(momentumLong||momentumShort))cfg.funnel.rejectedMomentum++;
   else if(!(regimeLong||regimeShort))cfg.funnel.rejectedHtf++;
   else cfg.funnel.rejectedScore++;
  }
 }
 if(!side)return wait(entry,['No setup family passed the local-quality, regime, momentum and cost gate'],score);
 const look=cfg.swingLookback??5,recent=bars.slice(-look),swingLow=Math.min(...recent.map(b=>b.low)),swingHigh=Math.max(...recent.map(b=>b.high)),floor=Math.max(entry*.0008,a*.55),rawRisk=side==='LONG'?Math.max(entry-swingLow,floor):Math.max(swingHigh-entry,floor),cap=a*(cfg.maxStructuralRiskAtr??1.35);
 const riskFloor=Math.max(a*(cfg.atrStopMultiple??1.5)*.65,entry*cost*1.75,entry*.0008,a*.55);
 if(rawRisk>cap){if(cfg.funnel)cfg.funnel.rejectedStructuralStop++;return wait(entry,[`Structural stop ${(rawRisk/a).toFixed(2)} ATR exceeds ${(cfg.maxStructuralRiskAtr??1.35).toFixed(2)} ATR ceiling`],score);}
 if(riskFloor>cap){if(cfg.funnel)cfg.funnel.rejectedRiskFloor++;return wait(entry,[`Minimum cost/ATR risk ${(riskFloor/a).toFixed(2)} ATR exceeds ${(cfg.maxStructuralRiskAtr??1.35).toFixed(2)} ATR ceiling`],score);}
 const risk=Math.max(rawRisk,riskFloor),minRR=cfg.minRiskReward??1.5,maxRR=cfg.maxRiskReward??3,ultra=TRADING_CONFIG.ultraScore,rrOverride=cfg.riskReward;
 const rr=rrOverride??clamp(minRR+(maxRR-minRR)*clamp((score-(cfg.minScore??TRADING_CONFIG.minScore))/Math.max(1,ultra-(cfg.minScore??TRADING_CONFIG.minScore)),0,1),minRR,maxRR);
 const targetDistance=risk*rr,pathCapacity=a*(8+28*eff24+8*sep+8*Math.max(0,expansion-1)+5*eff48);
 if(targetDistance>pathCapacity){if(cfg.funnel)cfg.funnel.rejectedPathCapacity++;return wait(entry,[`${rr.toFixed(1)}R target exceeds measured path capacity`],score);}
 const stopLoss=side==='LONG'?entry-risk:entry+risk,takeProfit=side==='LONG'?entry+targetDistance:entry-targetDistance,family=breakoutLong||breakoutShort?'breakout':retestLong||retestShort?'retest':compressionLong||compressionShort?'compression':'trend',familyLabel=family==='breakout'?'Fresh breakout':family==='retest'?'EMA20 reclaim retest':family==='compression'?'Compression expansion':'Trend continuation';
 if(cfg.funnel)cfg.funnel.tradesOpened++;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Regime Breakout v28',entry,stopLoss,takeProfit,riskReward:rr,family,reasons:[familyLabel,side==='LONG'?'Bullish local + regime':'Bearish local + regime','Multi-horizon momentum','HTF confirmation or strong local regime','Directional decision-candle confirmation','OHLC true-ATR structural stop','Cost-aware risk distance',`Target ${rr.toFixed(1)}R`,`Score ${Math.round(score)}/100`]};
}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,{...config,minRiskReward:config.minRiskReward??1.5,maxRiskReward:config.maxRiskReward??3});}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
