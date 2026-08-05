import type { Side } from './types';

export interface StrategySignal {
 action: Side | 'WAIT'; score: number; confidence: number; strategy: string;
 entry: number; stopLoss: number; takeProfit: number; riskReward: number; reasons: string[];
}
export interface StrategyConfig {
 minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number;
 lookback:number; riskPerTradePct?:number; strategyLimit?:number;
 feeBps?:number; slippageBps?:number;
}

const DEFAULT_CONFIG:StrategyConfig={
 minScore:68,minRiskReward:1.5,maxRiskReward:2.2,atrStopMultiple:1.25,
 lookback:180,strategyLimit:10,feeBps:10,slippageBps:2
};
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const atr=(x:number[],p=20)=>{const s=x.slice(-(p+1));return mean(s.slice(1).map((v,i)=>Math.abs(v-s[i])));};
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,reasons});

function production(prices:number[],cfg:StrategyConfig):StrategySignal{
 const p=prices.filter(Number.isFinite).filter(v=>v>0).slice(-cfg.lookback),entry=p[p.length-1]??0;
 if(p.length<120||!entry)return wait(entry,['Not enough history']);
 const e9=ema(p,9),e21=ema(p,21),e55=ema(p,55),e100=ema(p,100),a=atr(p),vol=a/entry,rrsi=rsi(p),m12=slope(p.slice(-12))/entry,m6=slope(p.slice(-6))/entry;
 const prior=p.slice(0,-1),h12=Math.max(...prior.slice(-12)),l12=Math.min(...prior.slice(-12));
 const trendUp=e21>e55&&e55>e100,trendDown=e21<e55&&e55<e100;
 const fastUp=e9>e21,fastDown=e9<e21;
 const breakoutLong=entry>h12*(1+0.0001),breakoutShort=entry<l12*(1-0.0001);
 const pullLong=trendUp&&entry>e21&&m6>0&&p.slice(-5,-1).some(v=>v<=e21);
 const pullShort=trendDown&&entry<e21&&m6<0&&p.slice(-5,-1).some(v=>v>=e21);
 const momentumThreshold=Math.max(0.00005,vol*0.025),momentumLong=m12>momentumThreshold,momentumShort=m12<-momentumThreshold;
 const roundTripCost=(2*(cfg.feeBps??10)+(2*(cfg.slippageBps??2)))/10000;
 const costAwareVol=vol>=Math.max(0.0007,roundTripCost*0.75)&&vol<=0.02;
 const notExtended=Math.abs(entry-e21)<=a*2.2;
 const longScore=(trendUp?30:0)+(fastUp?12:0)+(momentumLong?20:0)+(breakoutLong?18:0)+(pullLong?18:0)+(rrsi>=48&&rrsi<=70?10:0)+(costAwareVol?10:0);
 const shortScore=(trendDown?30:0)+(fastDown?12:0)+(momentumShort?20:0)+(breakoutShort?18:0)+(pullShort?18:0)+(rrsi>=30&&rrsi<=52?10:0)+(costAwareVol?10:0);
 let side:Side,score:number,reasons:string[];
 if(trendUp&&momentumLong&&(breakoutLong||pullLong||fastUp)&&longScore>=cfg.minScore&&rrsi>=48&&rrsi<=70&&costAwareVol&&notExtended){
  side='LONG';score=longScore;reasons=[trendUp?'bullish EMA regime':'',momentumLong?'positive short-term momentum':'',breakoutLong?'12-bar breakout':pullLong?'EMA21 pullback/reclaim':'EMA9/21 momentum','RSI confirmation','price not extended from EMA21','cost-aware volatility'].filter(Boolean);
 } else if(trendDown&&momentumShort&&(breakoutShort||pullShort||fastDown)&&shortScore>=cfg.minScore&&rrsi>=30&&rrsi<=52&&costAwareVol&&notExtended){
  side='SHORT';score=shortScore;reasons=[trendDown?'bearish EMA regime':'',momentumShort?'negative short-term momentum':'',breakoutShort?'12-bar breakdown':pullShort?'EMA21 pullback/reclaim':'EMA9/21 momentum','RSI confirmation','price not extended from EMA21','cost-aware volatility'].filter(Boolean);
 } else return wait(entry,['Production setup below quality threshold'],Math.max(longScore,shortScore));
 const dist=Math.max(a*cfg.atrStopMultiple,entry*.0012),riskReward=clamp(1.8,cfg.minRiskReward,cfg.maxRiskReward),stopLoss=side==='LONG'?entry-dist:entry+dist,takeProfit=side==='LONG'?entry+dist*riskReward:entry-dist*riskReward;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Breakout v10',entry,stopLoss,takeProfit,riskReward,reasons};
}

export function evaluateProductionStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config});}
export function evaluateResearchStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config,minScore:Math.max(62,config.minScore??68)});}
export function evaluateStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(prices,config);}
