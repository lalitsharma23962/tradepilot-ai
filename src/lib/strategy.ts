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
 minScore:85,minRiskReward:1.8,maxRiskReward:2.2,atrStopMultiple:1.5,
 lookback:180,strategyLimit:10,feeBps:10,slippageBps:2
};
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
// The live strategy receives closes only, so volatility is deliberately defined
// from close-to-close movement. The historical validator must use the signal's
// stop/target rather than a separate OHLC ATR for Production Breakout.
const atr=(x:number[],p=20)=>{const s=x.slice(-(p+1));return mean(s.slice(1).map((v,i)=>Math.abs(v-s[i])));};
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,reasons});

function production(prices:number[],cfg:StrategyConfig):StrategySignal{
 const p=prices.filter(Number.isFinite).filter(v=>v>0).slice(-cfg.lookback),entry=p[p.length-1]??0;
 if(p.length<120||!entry)return wait(entry,['Not enough history']);
 const e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),a=atr(p),vol=a/entry,rrsi=rsi(p);
 const m12=slope(p.slice(-12))/entry,m36=slope(p.slice(-36))/entry;
 const prior=p.slice(0,-1),h24=Math.max(...prior.slice(-24)),l24=Math.min(...prior.slice(-24));
 const trendUp=e20>e50&&e50>e100,trendDown=e20<e50&&e50<e100;
 const mediumUp=e20>e50&&m36>0,mediumDown=e20<e50&&m36<0;
 const fastUp=e9>e20,fastDown=e9<e20;
 const breakoutLong=entry>h24+a*0.10,breakoutShort=entry<l24-a*0.10;
 const pullLong=(trendUp||mediumUp)&&entry>e20&&m12>0&&p.slice(-8,-1).some(v=>v<=e20*1.001);
 const pullShort=(trendDown||mediumDown)&&entry<e20&&m12<0&&p.slice(-8,-1).some(v=>v>=e20*0.999);
 // The previous threshold was effectively near zero on 5m data, so weak drift
 // was scored as momentum. Require movement that is meaningful relative to noise.
 const momentumThreshold=Math.max(0.0005,vol*0.20);
 const momentumLong=m12>momentumThreshold&&m36>0,momentumShort=m12<-momentumThreshold&&m36<0;
 const trendStrength=Math.abs(e20-e50)/Math.max(a,entry*1e-8);
 const strongTrend=trendStrength>=0.35;
 const roundTripCost=(2*(cfg.feeBps??10)+(2*(cfg.slippageBps??2)))/10000;
 const costAwareVol=vol>=Math.max(0.00045,roundTripCost*0.55)&&vol<=0.025;
 const notExtended=Math.abs(entry-e20)<=a*2.0;
 const longScore=(trendUp?30:mediumUp?18:0)+(strongTrend?10:0)+(momentumLong?22:0)+(pullLong?18:0)+(breakoutLong?12:0)+(fastUp?5:0)+(rrsi>=48&&rrsi<=68?8:0)+(costAwareVol?5:0);
 const shortScore=(trendDown?30:mediumDown?18:0)+(strongTrend?10:0)+(momentumShort?22:0)+(pullShort?18:0)+(breakoutShort?12:0)+(fastDown?5:0)+(rrsi>=32&&rrsi<=52?8:0)+(costAwareVol?5:0);
 let side:Side,score:number,reasons:string[];
 const longSetup=trendUp&&strongTrend&&(momentumLong||pullLong||breakoutLong)&&rrsi>=48&&rrsi<=68&&costAwareVol&&notExtended;
 const shortSetup=trendDown&&strongTrend&&(momentumShort||pullShort||breakoutShort)&&rrsi>=32&&rrsi<=52&&costAwareVol&&notExtended;
 if(longSetup&&longScore>=cfg.minScore){
  side='LONG';score=longScore;reasons=['bullish EMA regime','trend-strength filter',momentumLong?'meaningful multi-horizon momentum':pullLong?'EMA20 pullback/reclaim':'confirmed range breakout','RSI confirmation','cost-aware volatility','price not excessively extended'];
 } else if(shortSetup&&shortScore>=cfg.minScore){
  side='SHORT';score=shortScore;reasons=['bearish EMA regime','trend-strength filter',momentumShort?'meaningful multi-horizon momentum':pullShort?'EMA20 pullback/reclaim':'confirmed range breakdown','RSI confirmation','cost-aware volatility','price not excessively extended'];
 } else return wait(entry,['Production setup below quality threshold'],Math.max(longScore,shortScore));
 const dist=Math.max(a*Math.max(1.5,cfg.atrStopMultiple),entry*.0015),riskReward=clamp(2.0,Math.max(1.8,cfg.minRiskReward),Math.min(2.2,Math.max(2.0,cfg.maxRiskReward))),stopLoss=side==='LONG'?entry-dist:entry+dist,takeProfit=side==='LONG'?entry+dist*riskReward:entry-dist*riskReward;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Breakout v11',entry,stopLoss,takeProfit,riskReward,reasons};
}

export function evaluateProductionStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{
 const merged={...DEFAULT_CONFIG,...config};
 // Do not silently clamp a caller's threshold. Validation and paper execution
 // must evaluate the same configured quality floor.
 return production(prices,merged);
}
export function evaluateResearchStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config,minScore:config.minScore??70});}
export function evaluateStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(prices,config);}
