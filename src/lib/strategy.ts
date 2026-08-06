import type { Side } from './types';
import { TRADING_CONFIG } from './tradingConfig';
import type { MarketBar } from './marketData';

export interface StrategySignal { action: Side|'WAIT'; score:number; confidence:number; strategy:string; entry:number; stopLoss:number; takeProfit:number; riskReward:number; reasons:string[]; }
export interface StrategyConfig { minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number; lookback:number; riskPerTradePct?:number; strategyLimit?:number; feeBps?:number; slippageBps?:number; riskReward?:number; maxStructuralRiskAtr?:number; swingLookback?:number; }
const DEFAULT_CONFIG:StrategyConfig={minScore:TRADING_CONFIG.minScore,minRiskReward:TRADING_CONFIG.productionMinRiskReward,maxRiskReward:TRADING_CONFIG.productionMaxRiskReward,atrStopMultiple:TRADING_CONFIG.atrStopMultiple,lookback:TRADING_CONFIG.lookback,feeBps:TRADING_CONFIG.feeBps,slippageBps:TRADING_CONFIG.slippageBps,maxStructuralRiskAtr:TRADING_CONFIG.maxStructuralRiskAtr,swingLookback:TRADING_CONFIG.swingLookback};
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const closeAtr=(x:number[],p=20)=>mean(x.slice(-(p+1)).slice(1).map((v,i)=>Math.abs(v-x.slice(-(p+1))[i])));
const trueAtr=(bars:MarketBar[],p=20)=>{const s=bars.slice(-(p+1));return mean(s.slice(1).map((b,i)=>Math.max(b.high-b.low,Math.abs(b.high-s[i].close),Math.abs(b.low-s[i].close))));};
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const efficiency=(x:number[])=>{if(x.length<3)return 0;const net=Math.abs(x.at(-1)!-x[0]);const path=x.slice(1).reduce((s,v,i)=>s+Math.abs(v-x[i]),0);return path?net/path:0;};
const consistency=(x:number[],side:1|-1)=>{if(x.length<2)return 0;const d=x.slice(1).map((v,i)=>v-x[i]);return d.filter(v=>side===1?v>0:v<0).length/d.length;};
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,reasons});
function asBars(input:number[]|MarketBar[]):MarketBar[]{if(!input.length)return[];if(typeof input[0]==='number'){const p=input as number[];return p.map((close,i)=>({openTime:i,open:close,high:close,low:close,close,volume:0}));}return input as MarketBar[];}
/** v27: one signal model for both validation and paper execution. It uses real OHLC
 * when available, one cost model, one structural-stop ceiling, and configurable
 * 2R-3R research targets. 10R/15R is intentionally not forced: the supplied audit
 * measured only a thin gross edge and negative OOS performance at high-RR targets. */
export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{
 const cfg={...DEFAULT_CONFIG,...config},bars=asBars(input).filter(b=>Number.isFinite(b.close)&&b.close>0).slice(-cfg.lookback),p=bars.map(b=>b.close),entry=p.at(-1)??0;
 if(p.length<160||!entry)return wait(entry,['Not enough history']);
 const a=trueAtr(bars),aFast=trueAtr(bars,12),aSlow=trueAtr(bars,48),e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),rrsi=rsi(p);
 const s12=slope(p.slice(-12))/entry,s24=slope(p.slice(-24))/entry,s48=slope(p.slice(-48))/entry,eff12=efficiency(p.slice(-12)),eff24=efficiency(p.slice(-24)),eff48=efficiency(p.slice(-48));
 const sep=Math.abs(e20-e50)/Math.max(a,entry*1e-6),expansion=aSlow>0?aFast/aSlow:1,vol=a/entry,cost=2*((cfg.feeBps??10)+(cfg.slippageBps??2))/10000;
 const up=e20>e50&&e50>e100,down=e20<e50&&e50<e100,rangeHigh=Math.max(...p.slice(-21,-1)),rangeLow=Math.min(...p.slice(-21,-1));
 const momentumLong=s12>Math.max(.00001,vol*.006)&&s24>0&&s48>0,momentumShort=s12<-Math.max(.00001,vol*.006)&&s24<0&&s48<0;
 const longConsistency=consistency(p.slice(-15),1),shortConsistency=consistency(p.slice(-15),-1);
 const trendLong=up&&eff24>=.20&&eff48>=.15&&longConsistency>=.50&&sep>=.04;
 const trendShort=down&&eff24>=.20&&eff48>=.15&&shortConsistency>=.50&&sep>=.04;
 const breakoutLong=entry>rangeHigh+a*.02&&momentumLong,breakoutShort=entry<rangeLow-a*.02&&momentumShort;
 const retestLong=up&&entry>e20&&momentumLong&&p.slice(-12,-2).some(v=>v<=e20*1.003),retestShort=down&&entry<e20&&momentumShort&&p.slice(-12,-2).some(v=>v>=e20*.997);
 const compression=(aFast/Math.max(aSlow,entry*1e-6))<.9,expanding=expansion>=.9;
 const compressionLong=up&&compression&&expanding&&momentumLong&&entry>e20,compressionShort=down&&compression&&expanding&&momentumShort&&entry<e20;
 const costAware=vol>=Math.max(.00025,cost*.45)&&vol<=.05,notExtended=Math.abs(entry-e20)<=a*2.5;
 const longFamily=breakoutLong||retestLong||compressionLong||trendLong,shortFamily=breakoutShort||retestShort||compressionShort||trendShort;
 const longScore=(up?22:0)+(e9>e20?8:0)+(momentumLong?18:0)+(trendLong?12:0)+(breakoutLong?15:0)+(retestLong?14:0)+(compressionLong?13:0)+(rrsi>=45&&rrsi<=75?7:0)+(costAware?6:0)+(notExtended?5:0);
 const shortScore=(down?22:0)+(e9<e20?8:0)+(momentumShort?18:0)+(trendShort?12:0)+(breakoutShort?15:0)+(retestShort?14:0)+(compressionShort?13:0)+(rrsi>=25&&rrsi<=55?7:0)+(costAware?6:0)+(notExtended?5:0);
 const minScore=Math.max(80,cfg.minScore),side:Side|null=longFamily&&longScore>=minScore&&longScore>=shortScore?'LONG':shortFamily&&shortScore>=minScore?'SHORT':null,score=side==='LONG'?longScore:side==='SHORT'?shortScore:Math.max(longScore,shortScore);
 if(!side)return wait(entry,['No setup family passed the common regime/momentum/cost score gate'],score);
 const look=cfg.swingLookback??5,recent=bars.slice(-look),swingLow=Math.min(...recent.map(b=>b.low)),swingHigh=Math.max(...recent.map(b=>b.high)),floor=Math.max(entry*.0008,a*.55),rawRisk=side==='LONG'?Math.max(entry-swingLow,floor):Math.max(swingHigh-entry,floor),cap=a*(cfg.maxStructuralRiskAtr??1.35);
 if(rawRisk>cap)return wait(entry,[`Structural stop ${ (rawRisk/a).toFixed(2)} ATR exceeds ${(cfg.maxStructuralRiskAtr??1.35).toFixed(2)} ATR ceiling`],score);
 const risk=Math.max(rawRisk,a*(cfg.atrStopMultiple??1.5)*.65,entry*cost*1.75),rr=clamp(cfg.riskReward??(score>=TRADING_CONFIG.ultraScore?cfg.maxRiskReward??3:cfg.minRiskReward??2),cfg.minRiskReward??2,cfg.maxRiskReward??3),targetDistance=risk*rr;
 const pathCapacity=a*(8+28*eff24+8*sep+8*Math.max(0,expansion-1)+5*eff48);
 if(targetDistance>pathCapacity)return wait(entry,[`${rr.toFixed(1)}R target exceeds measured path capacity`],score);
 const stopLoss=side==='LONG'?entry-risk:entry+risk,takeProfit=side==='LONG'?entry+targetDistance:entry-targetDistance;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Regime Breakout v27',entry,stopLoss,takeProfit,riskReward:rr,reasons:[breakoutLong||breakoutShort?'Breakout':retestLong||retestShort?'Breakout retest':'Trend/compression continuation',side==='LONG'?'Bullish regime':'Bearish regime','Multi-horizon momentum','OHLC true-ATR structural stop','Cost-aware risk distance',`Target ${rr.toFixed(1)}R`,`Score ${Math.round(score)}/100`]};
}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,{...config,minRiskReward:config.minRiskReward??2,maxRiskReward:config.maxRiskReward??3});}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config);}
