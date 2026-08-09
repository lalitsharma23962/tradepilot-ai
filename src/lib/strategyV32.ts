import type { Side } from './types';
import { TRADING_CONFIG } from './tradingConfig';
import type { MarketBar } from './marketData';
import type { FunnelCounters } from './backtestV6';

export interface StrategySignal { action: Side|'WAIT'; score:number; confidence:number; strategy:string; entry:number; stopLoss:number; takeProfit:number; riskReward:number; family:string; reasons:string[]; pathCapacity:number; }
export interface StrategyConfig { minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number; lookback:number; riskPerTradePct?:number; strategyLimit?:number; feeBps?:number; slippageBps?:number; riskReward?:number; maxStructuralRiskAtr?:number; swingLookback?:number; capacityHorizonBars?:number; funnel?:FunnelCounters; }
const DEFAULT_CONFIG:StrategyConfig={minScore:TRADING_CONFIG.minScore,minRiskReward:TRADING_CONFIG.productionMinRiskReward,maxRiskReward:TRADING_CONFIG.productionMaxRiskReward,atrStopMultiple:TRADING_CONFIG.atrStopMultiple,lookback:TRADING_CONFIG.lookback,feeBps:TRADING_CONFIG.feeBps,slippageBps:TRADING_CONFIG.slippageBps,maxStructuralRiskAtr:TRADING_CONFIG.maxStructuralRiskAtr,swingLookback:TRADING_CONFIG.swingLookback};
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const std=(x:number[])=>{const m=mean(x);return x.length>1?Math.sqrt(mean(x.map(v=>(v-m)**2))):0;};
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const trueAtr=(bars:MarketBar[],p=20)=>{const s=bars.slice(-(p+1));return mean(s.slice(1).map((b,i)=>Math.max(b.high-b.low,Math.abs(b.high-s[i].close),Math.abs(b.low-s[i].close))));};
const rsi=(x:number[])=>{const s=x.slice(-15),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const efficiency=(x:number[])=>{if(x.length<3)return 0;const net=Math.abs(x.at(-1)!-x[0]);const path=x.slice(1).reduce((s,v,i)=>s+Math.abs(v-x[i]),0);return path?net/path:0;};
const consistency=(x:number[],side:1|-1)=>{if(x.length<2)return 0;const d=x.slice(1).map((v,i)=>v-x[i]);return d.filter(v=>side===1?v>0:v<0).length/d.length;};
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,family:'none',reasons,pathCapacity:0});
function asBars(input:number[]|MarketBar[]):MarketBar[]{if(!input.length)return[];if(typeof input[0]==='number'){const p=input as number[];return p.map((close,i)=>({openTime:i,open:close,high:close,low:close,close,volume:0}));}return input as MarketBar[];}
function completedHourly(bars:MarketBar[]):MarketBar[]{if(bars.length<8)return[];const steps=bars.slice(1).map((b,i)=>b.openTime-bars[i].openTime).filter(x=>x>0).sort((a,b)=>a-b),step=steps[Math.floor(steps.length/2)]??0;if(step<=0||step>=3600000||3600000%step!==0)return[];const perHour=3600000/step,groups=new Map<number,MarketBar[]>();for(const b of bars){const key=Math.floor(b.openTime/3600000)*3600000;const g=groups.get(key);if(g)g.push(b);else groups.set(key,[b]);}return Array.from(groups.entries()).sort((a,b)=>a[0]-b[0]).filter(([,g])=>g.length===perHour).map(([openTime,g])=>({openTime,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[g.length-1].close,volume:g.reduce((s,x)=>s+x.volume,0)}));}

/** v32: entry-quality-first adaptive regime strategy. The hard validation gate is unchanged. */
export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{
 const cfg={...DEFAULT_CONFIG,...config},bars=asBars(input).filter(b=>Number.isFinite(b.close)&&b.close>0).slice(-cfg.lookback),p=bars.map(b=>b.close),entry=p.at(-1)??0;
 if(cfg.funnel)cfg.funnel.barsEvaluated++;
 if(p.length<160||!entry){if(cfg.funnel)cfg.funnel.insufficientHistory++;return wait(entry,['Not enough history']);}
 const a=trueAtr(bars),aFast=trueAtr(bars,12),aSlow=trueAtr(bars,48),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),rrsi=rsi(p),prevRsi=rsi(p.slice(0,-1));
 const s12=slope(p.slice(-12))/entry,s24=slope(p.slice(-24))/entry,s48=slope(p.slice(-48))/entry,eff24=efficiency(p.slice(-24)),eff48=efficiency(p.slice(-48));
 const sep=Math.abs(e20-e50)/Math.max(a,entry*1e-6),expansion=aSlow>0?aFast/aSlow:1,vol=a/entry,cost=2*((cfg.feeBps??10)+(cfg.slippageBps??2))/10000;
 const up=e20>e50&&e50>e100,down=e20<e50&&e50<e100,rangeHigh=Math.max(...p.slice(-21,-1)),rangeLow=Math.min(...p.slice(-21,-1));
 const momentumLong=s12>Math.max(.00001,vol*.0035)&&s24>0&&s48>0,momentumShort=s12<-Math.max(.00001,vol*.0035)&&s24<0&&s48<0;
 const longConsistency=consistency(p.slice(-15),1),shortConsistency=consistency(p.slice(-15),-1),hourly=completedHourly(bars),hp=hourly.map(b=>b.close),h20=ema(hp,20),h40=ema(hp,40),h50=ema(hp,50);
 const hS12=hp.length>=12?slope(hp.slice(-12))/Math.max(entry,1):0,hS24=hp.length>=24?slope(hp.slice(-24))/Math.max(entry,1):0,hEff24=efficiency(hp.slice(-24));
 const hLong=hourly.length>=50?h20>h40&&h40>h50&&hS12>0&&hS24>=-0.000001&&hEff24>=.08:false,hShort=hourly.length>=50?h20<h40&&h40<h50&&hS12<0&&hS24<=0.000001&&hEff24>=.08:false;
 // Aggregate local regime evidence instead of requiring every secondary feature.
 // The directional core remains mandatory; one secondary feature may be imperfect.
 // Downstream family rules and the 94+ conviction gate remain unchanged.
 const localLongEvidence=(up?1:0)+(s24>0?1:0)+(s48>0?1:0)+(eff24>=.18?1:0)+(eff48>=.12?1:0)+(longConsistency>=.48?1:0)+(sep>=.03?1:0);
 const localShortEvidence=(down?1:0)+(s24<0?1:0)+(s48<0?1:0)+(eff24>=.18?1:0)+(eff48>=.12?1:0)+(shortConsistency>=.48?1:0)+(sep>=.03?1:0);
 const strongLocalLong=up&&s24>0&&s48>0&&localLongEvidence>=5;
 const strongLocalShort=down&&s24<0&&s48<0&&localShortEvidence>=5;
 const regimeLong=hLong||strongLocalLong,regimeShort=hShort||strongLocalShort;
 const lastBar=bars.at(-1)!,prevBar=bars.at(-2)!,lastRange=Math.max(lastBar.high-lastBar.low,entry*1e-8),bodyRatio=Math.abs(lastBar.close-lastBar.open)/lastRange,closeLocation=(lastBar.close-lastBar.low)/lastRange;
 const barLong=lastBar.close>lastBar.open&&lastBar.close>=prevBar.close&&bodyRatio>=.25&&closeLocation>=.60,barShort=lastBar.close<lastBar.open&&lastBar.close<=prevBar.close&&bodyRatio>=.25&&closeLocation<=.40;
 const priorVolumes=bars.slice(-21,-1).map(b=>b.volume).filter(v=>Number.isFinite(v)&&v>0),avgVolume=mean(priorVolumes),volumeRatio=avgVolume>0?lastBar.volume/avgVolume:1,volumeHealthy=avgVolume<=0||volumeRatio>=.85;
 const recentPullbackLong=bars.slice(-10,-1).some(b=>b.close<=e20*1.0015&&b.low<=e20+a*.20),recentPullbackShort=bars.slice(-10,-1).some(b=>b.close>=e20*.9985&&b.high>=e20-a*.20);
 const nearEmaLong=Math.abs(entry-e20)<=a*1.25,nearEmaShort=nearEmaLong;
 const reclaimLong=entry>e20&&entry>=prevBar.close&&nearEmaLong&&barLong,reclaimShort=entry<e20&&entry<=prevBar.close&&nearEmaShort&&barShort;
 const trendLong=regimeLong&&momentumLong&&recentPullbackLong&&reclaimLong,trendShort=regimeShort&&momentumShort&&recentPullbackShort&&reclaimShort;
 const breakoutLong=regimeLong&&momentumLong&&entry>rangeHigh+a*.015&&prevBar.close<=rangeHigh+a*.006&&barLong&&volumeHealthy,breakoutShort=regimeShort&&momentumShort&&entry<rangeLow-a*.015&&prevBar.close>=rangeLow-a*.006&&barShort&&volumeHealthy;
 const prevBars=bars.slice(0,-3),prevFast=trueAtr(prevBars,12),prevSlow=trueAtr(prevBars,48),prevExpansion=prevSlow>0?prevFast/prevSlow:1,compression=prevExpansion<.95,expanding=expansion>Math.max(.95,prevExpansion*1.03)&&expansion>prevExpansion+.02;
 const compressionLong=regimeLong&&momentumLong&&compression&&expanding&&entry>e20&&nearEmaLong&&barLong,compressionShort=regimeShort&&momentumShort&&compression&&expanding&&entry<e20&&nearEmaShort&&barShort;
 const mid20=mean(p.slice(-20)),sd20=std(p.slice(-20)),upper20=mid20+2*sd20,lower20=mid20-2*sd20;
 const rangeEvidence=(sep<=.035?1:0)+(eff24<=.30?1:0)+(eff48<=.24?1:0)+(expansion<=1.10?1:0);
 const rangeRegime=rangeEvidence>=3;
 const reversionLong=rangeRegime&&prevRsi<=32&&rrsi>prevRsi&&rrsi>=30&&entry>prevBar.close&&barLong&&entry>=lower20-a*.15&&entry<=lower20+a*.35;
 const reversionShort=rangeRegime&&prevRsi>=68&&rrsi<prevRsi&&rrsi<=70&&entry<prevBar.close&&barShort&&entry<=upper20+a*.15&&entry>=upper20-a*.35;
 const costAware=vol>=Math.max(.00025,cost*.45)&&vol<=.05;
 const trendLongScore=(up?20:0)+(regimeLong?18:0)+(hLong?7:0)+(momentumLong?15:0)+(trendLong?18:0)+(eff24>=.16?7:0)+(longConsistency>=.50?5:0)+(rrsi>=45&&rrsi<=75?4:0)+(costAware?3:0)+(nearEmaLong?3:0);
 const trendShortScore=(down?20:0)+(regimeShort?18:0)+(hShort?7:0)+(momentumShort?15:0)+(trendShort?18:0)+(eff24>=.16?7:0)+(shortConsistency>=.50?5:0)+(rrsi>=25&&rrsi<=55?4:0)+(costAware?3:0)+(nearEmaShort?3:0);
 const breakoutLongScore=(up?20:0)+(regimeLong?15:0)+(hLong?7:0)+(breakoutLong?22:0)+(momentumLong?15:0)+(barLong?8:0)+(volumeHealthy?8:0)+(eff24>=.12?5:0)+(costAware?5:0)+(nearEmaLong?3:0);
 const breakoutShortScore=(down?20:0)+(regimeShort?15:0)+(hShort?7:0)+(breakoutShort?22:0)+(momentumShort?15:0)+(barShort?8:0)+(volumeHealthy?8:0)+(eff24>=.12?5:0)+(costAware?5:0)+(nearEmaShort?3:0);
 const compressionLongScore=(up?20:0)+(regimeLong?15:0)+(hLong?7:0)+(compression?15:0)+(expanding?15:0)+(barLong?10:0)+(momentumLong?10:0)+(nearEmaLong?5:0)+(costAware?3:0);
 const compressionShortScore=(down?20:0)+(regimeShort?15:0)+(hShort?7:0)+(compression?15:0)+(expanding?15:0)+(barShort?10:0)+(momentumShort?10:0)+(nearEmaShort?5:0)+(costAware?3:0);
 const reversionLongScore=(rangeRegime?20:0)+(reversionLong?25:0)+(prevRsi<=25?15:0)+(rrsi>=30&&rrsi<=42?10:0)+(entry>=lower20?10:0)+(barLong?10:0)+(costAware?5:0)+(Math.abs(entry-mid20)<=a*1.5?5:0);
 const reversionShortScore=(rangeRegime?20:0)+(reversionShort?25:0)+(prevRsi>=75?15:0)+(rrsi<=70&&rrsi>=58?10:0)+(entry<=upper20?10:0)+(barShort?10:0)+(costAware?5:0)+(Math.abs(entry-mid20)<=a*1.5?5:0);
 const candidates:{side:Side;family:string;score:number}[]=[];
 if(trendLong)candidates.push({side:'LONG',family:'trend',score:trendLongScore});if(trendShort)candidates.push({side:'SHORT',family:'trend',score:trendShortScore});if(breakoutLong)candidates.push({side:'LONG',family:'breakout',score:breakoutLongScore});if(breakoutShort)candidates.push({side:'SHORT',family:'breakout',score:breakoutShortScore});if(compressionLong)candidates.push({side:'LONG',family:'compression',score:compressionLongScore});if(compressionShort)candidates.push({side:'SHORT',family:'compression',score:compressionShortScore});if(reversionLong)candidates.push({side:'LONG',family:'reversion',score:reversionLongScore});if(reversionShort)candidates.push({side:'SHORT',family:'reversion',score:reversionShortScore});
 candidates.sort((a,b)=>b.score-a.score);const minScore=Math.max(80,cfg.minScore),winner=candidates.find(x=>x.score>=minScore),score=winner?.score??(candidates[0]?.score??0),side:Side|'WAIT'=winner?.side??'WAIT',family=winner?.family??'none';
 if(cfg.funnel){if(trendLong||trendShort)cfg.funnel.familyCandidatesTrend++;if(breakoutLong||breakoutShort)cfg.funnel.familyCandidatesBreakout++;if(trendLong||trendShort)cfg.funnel.familyCandidatesRetest++;if(compressionLong||compressionShort)cfg.funnel.familyCandidatesCompression++;if(reversionLong||reversionShort)cfg.funnel.familyCandidatesReversion++;if(!winner){if(!candidates.length)cfg.funnel.noLocalPattern++;else if(!(momentumLong||momentumShort))cfg.funnel.rejectedMomentum++;else if(!hLong&&!hShort&&!strongLocalLong&&!strongLocalShort)cfg.funnel.rejectedHtf++;else cfg.funnel.rejectedScore++;}}
 if(!winner)return wait(entry,['No candidate reached the strict entry-quality conviction score'],score);
 const look=cfg.swingLookback??5,recent=bars.slice(-look),swingLow=Math.min(...recent.map(b=>b.low)),swingHigh=Math.max(...recent.map(b=>b.high)),rawRisk=side==='LONG'?Math.max(entry-swingLow,a*.55):Math.max(swingHigh-entry,a*.55),cap=a*(cfg.maxStructuralRiskAtr??1.35),riskFloor=Math.max(a*(cfg.atrStopMultiple??1.5)*.65,entry*cost*1.75,entry*.0008,a*.55);
 if(rawRisk>cap){if(cfg.funnel)cfg.funnel.rejectedStructuralStop++;return wait(entry,[`Structural stop ${(rawRisk/a).toFixed(2)} ATR exceeds ${(cfg.maxStructuralRiskAtr??1.35).toFixed(2)} ATR ceiling`],score);}
 if(riskFloor>cap){if(cfg.funnel)cfg.funnel.rejectedRiskFloor++;return wait(entry,[`Minimum cost/ATR risk ${(riskFloor/a).toFixed(2)} ATR exceeds ${(cfg.maxStructuralRiskAtr??1.35).toFixed(2)} ATR ceiling`],score);}
 const risk=Math.max(rawRisk,riskFloor),minRR=cfg.minRiskReward??1.5,maxRR=cfg.maxRiskReward??3,ultra=TRADING_CONFIG.ultraScore,rr=cfg.riskReward??clamp(minRR+(maxRR-minRR)*clamp((score-(cfg.minScore??TRADING_CONFIG.minScore))/Math.max(1,ultra-(cfg.minScore??TRADING_CONFIG.minScore)),0,1),minRR,maxRR),targetDistance=risk*rr,pathCapacity=a*(8+28*eff24+8*sep+8*Math.max(0,expansion-1)+5*eff48);
 if(targetDistance>pathCapacity){if(cfg.funnel)cfg.funnel.rejectedPathCapacity++;return wait(entry,[`${rr.toFixed(1)}R target exceeds measured path capacity`],score);}
 const stopLoss=side==='LONG'?entry-risk:entry+risk,takeProfit=side==='LONG'?entry+targetDistance:entry-targetDistance;
 if(cfg.funnel)cfg.funnel.tradesOpened++;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Regime Breakout v32',entry,stopLoss,takeProfit,riskReward:rr,family,reasons:[family==='trend'?'EMA20 pullback/reclaim':family==='breakout'?'Fresh breakout':family==='compression'?'Compression expansion':'Range RSI/Bollinger reversal',side==='LONG'?'Bullish local regime':'Bearish local regime',hLong||hShort?'Completed-hour confirmation':'Strong local-regime confirmation','Multi-horizon momentum','Real OHLC ATR structural stop','Cost-aware risk distance',`Target ${rr.toFixed(1)}R`,`Score ${Math.round(score)}/100`],pathCapacity};
}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,{...config,minRiskReward:config.minRiskReward??1.5,maxRiskReward:config.maxRiskReward??3});}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
