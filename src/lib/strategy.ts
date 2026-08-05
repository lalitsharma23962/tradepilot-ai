import type { Side } from './types';
export interface StrategySignal { action: Side | 'WAIT'; score: number; confidence: number; strategy: string; entry: number; stopLoss: number; takeProfit: number; riskReward: number; reasons: string[]; }
export interface StrategyConfig { minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number; lookback:number; riskPerTradePct?:number; strategyLimit?:number; }
const DEFAULT_CONFIG:StrategyConfig={minScore:85,minRiskReward:1.5,maxRiskReward:2.2,atrStopMultiple:1.1,lookback:180,strategyLimit:10};
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const atr=(x:number[],p=20)=>{const s=x.slice(-(p+1));return mean(s.slice(1).map((v,i)=>Math.abs(v-s[i])));};
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,reasons});
function production(prices:number[],cfg:StrategyConfig):StrategySignal{
 const p=prices.filter(Number.isFinite).filter(v=>v>0).slice(-cfg.lookback),entry=p.at(-1)??0;
 if(p.length<120||!entry)return wait(entry,['Not enough history']);
 const e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),a=atr(p),vol=a/entry,rrsi=rsi(p),m12=slope(p.slice(-12))/entry,m6=slope(p.slice(-6))/entry;
 const prior=p.slice(0,-1),h20=Math.max(...prior.slice(-20)),l20=Math.min(...prior.slice(-20));
 const longTrend=e20>e50&&e50>e100,shortTrend=e20<e50&&e50<e100;
 const longBreak=entry>h20,shortBreak=entry<l20;
 const longPull=e20>e50&&p.slice(-5,-1).some(v=>v<=e20)&&entry>e20&&m6>0;
 const shortPull=e20<e50&&p.slice(-5,-1).some(v=>v>=e20)&&entry<e20&&m6<0;
 const threshold=Math.max(.0001,vol*.08),longMomentum=m12>threshold,shortMomentum=m12<-threshold,sane=vol>=.0005&&vol<=.012;
 const longStructure=longBreak||longPull,shortStructure=shortBreak||shortPull;
 const longScore=(longTrend?30:0)+(longMomentum?25:0)+(longBreak?25:0)+(longPull?22:0)+(rrsi>=48&&rrsi<=70?10:0)+(sane?10:0);
 const shortScore=(shortTrend?30:0)+(shortMomentum?25:0)+(shortBreak?25:0)+(shortPull?22:0)+(rrsi>=30&&rrsi<=52?10:0)+(sane?10:0);
 let side:Side,score:number,reasons:string[];
 if(longTrend&&longMomentum&&longStructure&&longScore>=cfg.minScore&&rrsi>=48&&rrsi<=70&&sane){side='LONG';score=longScore;reasons=[longTrend?'bullish EMA regime':'',longMomentum?'strong positive momentum':'',longBreak?'20-bar breakout':'EMA20 pullback/reclaim','RSI confirmation','tradable volatility'].filter(Boolean);}
 else if(shortTrend&&shortMomentum&&shortStructure&&shortScore>=cfg.minScore&&rrsi>=30&&rrsi<=52&&sane){side='SHORT';score=shortScore;reasons=[shortTrend?'bearish EMA regime':'',shortMomentum?'strong negative momentum':'',shortBreak?'20-bar breakdown':'EMA20 pullback/reclaim','RSI confirmation','tradable volatility'].filter(Boolean);}
 else return wait(entry,['Production setup below quality threshold'],Math.max(longScore,shortScore));
 const dist=Math.max(a*cfg.atrStopMultiple,entry*.0012),riskReward=clamp(1.8,cfg.minRiskReward,cfg.maxRiskReward),stopLoss=side==='LONG'?entry-dist:entry+dist,takeProfit=side==='LONG'?entry+dist*riskReward:entry-dist*riskReward;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Breakout v7',entry,stopLoss,takeProfit,riskReward,reasons};
}
export function evaluateProductionStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config});}
export function evaluateResearchStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config,minScore:Math.max(75,config.minScore??85)});}
export function evaluateStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(prices,config);}
