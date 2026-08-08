import type { Side } from './types';
import { TRADING_CONFIG } from './tradingConfig';
import type { MarketBar } from './marketData';
import type { FunnelCounters } from './backtestV6';

export interface StrategySignal { action: Side|'WAIT'; score:number; confidence:number; strategy:string; entry:number; stopLoss:number; takeProfit:number; riskReward:number; family:string; reasons:string[]; }
export interface StrategyConfig { minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number; lookback:number; riskPerTradePct?:number; strategyLimit?:number; feeBps?:number; slippageBps?:number; riskReward?:number; maxStructuralRiskAtr?:number; swingLookback?:number; funnel?:FunnelCounters; }
const D:StrategyConfig={minScore:96,minRiskReward:10,maxRiskReward:15,atrStopMultiple:1.5,lookback:TRADING_CONFIG.lookback,feeBps:TRADING_CONFIG.feeBps,slippageBps:TRADING_CONFIG.slippageBps,maxStructuralRiskAtr:1.35,swingLookback:5};
const mean=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const ema=(a:number[],p:number)=>{let e=a[0]??0,k=2/(p+1);for(let i=1;i<a.length;i++)e=a[i]*k+e*(1-k);return e};
const atr=(b:MarketBar[],p=20)=>{const s=b.slice(-(p+1));const v=s.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-s[i].close),Math.abs(x.low-s[i].close)));return mean(v)};
const eff=(a:number[])=>{if(a.length<3)return 0;const path=a.slice(1).reduce((s,v,i)=>s+Math.abs(v-a[i]),0);return path?Math.abs(a.at(-1)!-a[0])/path:0};
const clamp=(x:number,a:number,b:number)=>Math.max(a,Math.min(b,x));
const wait=(e:number,r:string[],s=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(s,0,100)),confidence:Math.round(clamp(s,0,100)),strategy:'No Trade',entry:e,stopLoss:e,takeProfit:e,riskReward:0,family:'none',reasons:r});
function barsOf(x:number[]|MarketBar[]):MarketBar[]{if(!x.length)return[];if(typeof x[0]==='number')return (x as number[]).map((c,i)=>({openTime:i,open:c,high:c,low:c,close:c,volume:0}));return x as MarketBar[]}
function rsi(a:number[]){const s=a.slice(-15),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(x=>Math.max(x,0))),l=mean(d.map(x=>Math.max(-x,0)));return l?100-100/(1+g/l):100}
function scoreTrend(p:number[],e20:number,e50:number,e100:number,a:number,side:1|-1){const up=side===1?e20>e50&&e50>e100:e20<e50&&e50<e100;const sl=a?(p.at(-1)!-p.at(-12)!)/(11*p.at(-1)!):0,sl24=a?(p.at(-1)!-p.at(-24)!)/(23*p.at(-1)!):0,ef=eff(p.slice(-48));const m=side===1?sl>0&&sl24>0:sl<0&&sl24<0;return (up?25:0)+(m?20:0)+(ef>=.20?15:0)+(ef>=.30?10:0)+(Math.abs(e20-e50)>=a*.05?10:0)+(Math.abs(e20-e50)>=a*.10?5:0)+((side===1?(rsi(p)>=45&&rsi(p)<=72):(rsi(p)>=28&&rsi(p)<=55))?5:0)}
export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{
 const c={...D,...config},b=barsOf(input).filter(x=>Number.isFinite(x.close)&&x.close>0).slice(-c.lookback),p=b.map(x=>x.close),e=p.at(-1)??0;if(c.funnel)c.funnel.barsEvaluated++;if(b.length<160){if(c.funnel)c.funnel.insufficientHistory++;return wait(e,['Not enough history'])}
 const a=atr(b),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),sideLong=e20>e50&&e50>e100,sideShort=e20<e50&&e50<e100;
 const last=b.at(-1)!,prev=b.at(-2)!,range=Math.max(last.high-last.low,e*1e-8),body=Math.abs(last.close-last.open)/range,loc=(last.close-last.low)/range;
 const barL=last.close>last.open&&last.close>=prev.close&&body>=.45&&loc>=.70,barS=last.close<last.open&&last.close<=prev.close&&body>=.45&&loc<=.30;
 const ef24=eff(p.slice(-24)),pullL=b.slice(-12,-1).some(x=>x.low<=e20+a*.15&&x.close<=e20*1.002),pullS=b.slice(-12,-1).some(x=>x.high>=e20-a*.15&&x.close>=e20*.998);
 const reclaimL=sideLong&&pullL&&e>e20&&Math.abs(e-e20)<=a*.75&&barL,reclaimS=sideShort&&pullS&&e<e20&&Math.abs(e-e20)<=a*.75&&barS;
 const rh=Math.max(...p.slice(-31,-1)),rl=Math.min(...p.slice(-31,-1));
 const breakL=sideLong&&e>rh+a*.02&&prev.close<=rh&&barL,breakS=sideShort&&e<rl-a*.02&&prev.close>=rl&&barS;
 const scores=[
  {side:'LONG' as Side,family:'trend',setup:reclaimL,score:scoreTrend(p,e20,e50,e100,a,1)+(reclaimL?20:0)+(barL?5:0)+(ef24>=.18?5:0)},
  {side:'SHORT' as Side,family:'trend',setup:reclaimS,score:scoreTrend(p,e20,e50,e100,a,-1)+(reclaimS?20:0)+(barS?5:0)+(ef24>=.18?5:0)},
  {side:'LONG' as Side,family:'breakout',setup:breakL,score:scoreTrend(p,e20,e50,e100,a,1)+(breakL?35:0)+(barL?5:0)},
  {side:'SHORT' as Side,family:'breakout',setup:breakS,score:scoreTrend(p,e20,e50,e100,a,-1)+(breakS?35:0)+(barS?5:0)}
 ].filter(x=>x.setup&&x.score>=c.minScore).sort((x,y)=>y.score-x.score);
 const w=scores[0];if(!w){if(c.funnel)c.funnel.rejectedScore++;return wait(e,['No A+ setup reached strict conviction threshold'])}
 const recent=b.slice(-(c.swingLookback??5)),low=Math.min(...recent.map(x=>x.low)),high=Math.max(...recent.map(x=>x.high));const risk=w.side==='LONG'?Math.max(e-low,a*.55):Math.max(high-e,a*.55),cap=a*(c.maxStructuralRiskAtr??1.35);if(risk>cap){if(c.funnel)c.funnel.rejectedStructuralStop++;return wait(e,['Structural stop exceeds ATR ceiling'],w.score)}
 const targetR=clamp(c.riskReward??(w.score>=99?15:10),c.minRiskReward,c.maxRiskReward),target=w.side==='LONG'?e+risk*targetR:e-risk*targetR;
 const pathBars=b.slice(-240,-5),barrier=w.side==='LONG'?Math.max(...pathBars.map(x=>x.high)):Math.min(...pathBars.map(x=>x.low)),room=w.side==='LONG'?(barrier<=e?Infinity:barrier-e):(e<=barrier?Infinity:e-barrier);
 if(room<risk*targetR && !(w.family==='breakout'&&((w.side==='LONG'&&e>rh)||(w.side==='SHORT'&&e<rl)))){if(c.funnel)c.funnel.rejectedPathCapacity++;return wait(e,[`${targetR}R path is blocked by historical structure`],w.score)}
 if(c.funnel)c.funnel.tradesOpened++;
 return {action:w.side,score:w.score,confidence:w.score,strategy:'Production Regime Breakout v33',entry:e,stopLoss:w.side==='LONG'?e-risk:e+risk,takeProfit:target,riskReward:targetR,family:w.family,reasons:[w.family==='breakout'?'A+ structural breakout':'A+ pullback/reclaim','Multi-horizon trend alignment','Strong decision candle','Structural stop','Historical path-capacity filter',`Target ${targetR}R`,`Score ${w.score}/100`]};
}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,{...config,minRiskReward:config.minRiskReward??10,maxRiskReward:config.maxRiskReward??15})}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(input,config)}
