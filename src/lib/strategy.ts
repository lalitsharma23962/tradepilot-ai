import type { Side } from './types';

export interface StrategySignal { action: Side|'WAIT'; score:number; confidence:number; strategy:string; entry:number; stopLoss:number; takeProfit:number; riskReward:number; reasons:string[]; }
export interface StrategyConfig { minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number; lookback:number; riskPerTradePct?:number; strategyLimit?:number; feeBps?:number; slippageBps?:number; riskReward?:number; }
const DEFAULT_CONFIG:StrategyConfig={minScore:85,minRiskReward:1.8,maxRiskReward:3.2,atrStopMultiple:1.15,lookback:240,strategyLimit:17,feeBps:10,slippageBps:2};
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const trueRange=(x:number[])=>x.slice(1).map((v,i)=>Math.max(v-x[i],Math.abs(v-x[i]),Math.abs(x[i]-v)));
const atr=(x:number[],p=20)=>{const s=x.slice(-(p+1));return mean(trueRange(s));};
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,reasons});

function production(prices:number[],cfg:StrategyConfig):StrategySignal{
 const p=prices.filter(Number.isFinite).filter(v=>v>0).slice(-cfg.lookback),entry=p[p.length-1]??0;
 if(p.length<150||!entry)return wait(entry,['Not enough history']);
 const e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),a=atr(p),vol=a/entry,rrsi=rsi(p),s12=slope(p.slice(-12))/entry,s36=slope(p.slice(-36))/entry;
 const prior=p.slice(0,-1),hi20=Math.max(...prior.slice(-20)),lo20=Math.min(...prior.slice(-20));
 const trendUp=e20>e50&&e50>e100,trendDown=e20<e50&&e50<e100,mediumUp=e20>e50&&s36>0,mediumDown=e20<e50&&s36<0;
 const momentumLong=s12>Math.max(.00002,vol*.0125)&&s36>0,momentumShort=s12<-Math.max(.00002,vol*.0125)&&s36<0;
 const breakoutLong=entry>hi20*1.00005,breakoutShort=entry<lo20*.99995;
 const pullLong=(trendUp||mediumUp)&&entry>e20&&p.slice(-6,-1).some(v=>v<=e20*1.001)&&s12>0,pullShort=(trendDown||mediumDown)&&entry<e20&&p.slice(-6,-1).some(v=>v>=e20*.999)&&s12<0;
 const roundTripCost=(2*(cfg.feeBps??10)+2*(cfg.slippageBps??2))/10000,costAware=vol>=Math.max(.00045,roundTripCost*.55)&&vol<=.025,notExtended=Math.abs(entry-e20)<=a*2.4;
 const longScore=(trendUp?25:mediumUp?18:0)+(e9>e20?10:0)+(momentumLong?22:0)+(breakoutLong?15:0)+(pullLong?15:0)+(rrsi>=48&&rrsi<=72?10:0)+(costAware?8:0);
 const shortScore=(trendDown?25:mediumDown?18:0)+(e9<e20?10:0)+(momentumShort?22:0)+(breakoutShort?15:0)+(pullShort?15:0)+(rrsi>=28&&rrsi<=52?10:0)+(costAware?8:0);
 const effectiveMinScore=Math.max(85,cfg.minScore);
 const longOk=(trendUp||mediumUp)&&(momentumLong||breakoutLong||pullLong||e9>e20)&&rrsi>=48&&rrsi<=72&&costAware&&notExtended;
 const shortOk=(trendDown||mediumDown)&&(momentumShort||breakoutShort||pullShort||e9<e20)&&rrsi>=28&&rrsi<=52&&costAware&&notExtended;
 let side:Side,score:number,reasons:string[];
 if(longOk&&longScore>=effectiveMinScore){side='LONG';score=longScore;reasons=[trendUp?'bullish EMA regime':'positive EMA/momentum regime',momentumLong?'multi-horizon momentum':'',breakoutLong?'20-bar breakout':pullLong?'EMA20 pullback/reclaim':'EMA9/20 confirmation','RSI confirmation','cost-aware volatility','not excessively extended'].filter(Boolean);}else if(shortOk&&shortScore>=effectiveMinScore){side='SHORT';score=shortScore;reasons=[trendDown?'bearish EMA regime':'negative EMA/momentum regime',momentumShort?'multi-horizon momentum':'',breakoutShort?'20-bar breakdown':pullShort?'EMA20 pullback/reclaim':'EMA9/20 confirmation','RSI confirmation','cost-aware volatility','not excessively extended'].filter(Boolean);}else return wait(entry,['Production setup below quality threshold'],Math.max(longScore,shortScore));

 // Compress risk around the local swing instead of blindly using a wide ATR stop.
 // This makes a 10R/15R objective structurally attainable without increasing account risk.
 const recent=p.slice(-8),swingLow=Math.min(...recent),swingHigh=Math.max(...recent);
 const floor=entry*0.0008, atrCap=a*0.85;
 const rawRisk=side==='LONG'?Math.max(entry-swingLow,floor):Math.max(swingHigh-entry,floor);
 const dist=clamp(rawRisk,floor,atrCap);
 const riskReward=cfg.riskReward!==undefined?clamp(cfg.riskReward,10,15):(score>=94?15:10);
 const stopLoss=side==='LONG'?entry-dist:entry+dist,takeProfit=side==='LONG'?entry+dist*riskReward:entry-dist*riskReward;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Regime Breakout v13',entry,stopLoss,takeProfit,riskReward,reasons:[...reasons,`risk-compressed ${riskReward}R target`,`score ${Math.round(score)}/100`]};
}
export function evaluateProductionStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config});}
export function evaluateResearchStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config,minScore:config.minScore??85});}
export function evaluateStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(prices,config);}
