import type { Side } from './types';

export interface StrategySignal { action: Side|'WAIT'; score:number; confidence:number; strategy:string; entry:number; stopLoss:number; takeProfit:number; riskReward:number; reasons:string[]; }
export interface StrategyConfig { minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number; lookback:number; riskPerTradePct?:number; strategyLimit?:number; feeBps?:number; slippageBps?:number; riskReward?:number; }

const DEFAULT_CONFIG:StrategyConfig={minScore:85,minRiskReward:1.8,maxRiskReward:3.2,atrStopMultiple:1.15,lookback:240,strategyLimit:17,feeBps:10,slippageBps:2};
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const trueRange=(x:number[])=>x.slice(1).map((v,i)=>Math.abs(v-x[i]));
const atr=(x:number[],p=20)=>{const s=x.slice(-(p+1));return mean(trueRange(s));};
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const efficiency=(x:number[])=>{if(x.length<3)return 0;const net=Math.abs(x[x.length-1]-x[0]);const path=x.slice(1).reduce((s,v,i)=>s+Math.abs(v-x[i]),0);return path?net/path:0;};
const directionalConsistency=(x:number[],side:1|-1)=>{if(x.length<2)return 0;const d=x.slice(1).map((v,i)=>v-x[i]);return d.length?d.filter(v=>side===1?v>0:v<0).length/d.length:0;};
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,reasons});

function production(prices:number[],cfg:StrategyConfig):StrategySignal{
 const p=prices.filter(Number.isFinite).filter(v=>v>0).slice(-cfg.lookback),entry=p[p.length-1]??0;
 if(p.length<150||!entry)return wait(entry,['Not enough history']);

 const e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100);
 const a=atr(p),a12=atr(p,12),a48=atr(p,48),vol=a/entry,rrsi=rsi(p);
 const s12=slope(p.slice(-12))/entry,s36=slope(p.slice(-36))/entry;
 const eff24=efficiency(p.slice(-24)),eff48=efficiency(p.slice(-48));
 const consistencyLong=directionalConsistency(p.slice(-13),1),consistencyShort=directionalConsistency(p.slice(-13),-1);
 const separation=Math.abs(e20-e50)/Math.max(a,entry*0.000001);
 const volatilityExpansion=a48>0?a12/a48:1;
 const prior=p.slice(0,-1),hi20=Math.max(...prior.slice(-20)),lo20=Math.min(...prior.slice(-20));
 const trendUp=e20>e50&&e50>e100,trendDown=e20<e50&&e50<e100;
 const mediumUp=e20>e50&&s36>0,mediumDown=e20<e50&&s36<0;
 const momentumLong=s12>Math.max(.00002,vol*.0125)&&s36>0,momentumShort=s12<-Math.max(.00002,vol*.0125)&&s36<0;

 const breakoutLong=entry>hi20+a*0.10,breakoutShort=entry<lo20-a*0.10;
 const pullLong=(trendUp||mediumUp)&&entry>e20&&p.slice(-6,-1).some(v=>v<=e20*1.001)&&s12>0;
 const pullShort=(trendDown||mediumDown)&&entry<e20&&p.slice(-6,-1).some(v=>v>=e20*.999)&&s12<0;

 const roundTripCost=(2*(cfg.feeBps??10)+2*(cfg.slippageBps??2))/10000;
 const costAware=vol>=Math.max(.00045,roundTripCost*.55)&&vol<=.025;
 const notExtended=Math.abs(entry-e20)<=a*2.0;
 const trendQualityLong=eff24>=.35&&eff48>=.25&&consistencyLong>=.58&&separation>=.12;
 const trendQualityShort=eff24>=.35&&eff48>=.25&&consistencyShort>=.58&&separation>=.12;
 const expansionQuality=volatilityExpansion>=.80&&volatilityExpansion<=2.20;
 const impulseLong=(entry-p[Math.max(0,p.length-6)])/Math.max(a,entry*0.000001)>=.15;
 const impulseShort=(p[Math.max(0,p.length-6)]-entry)/Math.max(a,entry*0.000001)>=.15;

 const longScore=(trendUp?20:mediumUp?14:0)+(e9>e20?8:0)+(momentumLong?20:0)+(breakoutLong?18:0)+(pullLong?15:0)+(rrsi>=48&&rrsi<=72?7:0)+(costAware?4:0)+(trendQualityLong?8:0);
 const shortScore=(trendDown?20:mediumDown?14:0)+(e9<e20?8:0)+(momentumShort?20:0)+(breakoutShort?18:0)+(pullShort?15:0)+(rrsi>=28&&rrsi<=52?7:0)+(costAware?4:0)+(trendQualityShort?8:0);

 const effectiveMinScore=Math.max(85,cfg.minScore);
 // V15 separates continuation and breakout setups. The old implementation required
 // impulse confirmation for every setup, which made otherwise valid EMA pullbacks
 // disappear. A setup still needs trend quality, cost-aware volatility, controlled
 // extension and a concrete continuation/breakout trigger.
 const continuationLong=(trendUp||mediumUp)&&trendQualityLong&&costAware&&notExtended&&momentumLong&&rrsi>=48&&rrsi<=72;
 const continuationShort=(trendDown||mediumDown)&&trendQualityShort&&costAware&&notExtended&&momentumShort&&rrsi>=28&&rrsi<=52;
 const breakoutSetupLong=(trendUp||mediumUp)&&trendQualityLong&&costAware&&expansionQuality&&notExtended&&breakoutLong&&impulseLong&&rrsi>=48&&rrsi<=72;
 const breakoutSetupShort=(trendDown||mediumDown)&&trendQualityShort&&costAware&&expansionQuality&&notExtended&&breakoutShort&&impulseShort&&rrsi>=28&&rrsi<=52;
 const pullbackLong=(trendUp||mediumUp)&&trendQualityLong&&costAware&&notExtended&&pullLong&&rrsi>=46&&rrsi<=70;
 const pullbackShort=(trendDown||mediumDown)&&trendQualityShort&&costAware&&notExtended&&pullShort&&rrsi>=30&&rrsi<=54;
 const longOk=continuationLong||breakoutSetupLong||pullbackLong;
 const shortOk=continuationShort||breakoutSetupShort||pullbackShort;

 let side:Side,score:number,reasons:string[];
 if(longOk&&longScore>=effectiveMinScore){
   side='LONG';score=longScore;
   reasons=[trendUp?'bullish EMA regime':'positive EMA/momentum regime',momentumLong?'multi-horizon momentum':'',breakoutSetupLong?'volatility-cleared 20-bar breakout':pullbackLong?'EMA20 pullback/reclaim':'EMA continuation','trend persistence confirmed','RSI confirmation','cost-aware volatility','controlled extension',impulseLong?'impulse confirmation':''].filter(Boolean);
 }else if(shortOk&&shortScore>=effectiveMinScore){
   side='SHORT';score=shortScore;
   reasons=[trendDown?'bearish EMA regime':'negative EMA/momentum regime',momentumShort?'multi-horizon momentum':'',breakoutSetupShort?'volatility-cleared 20-bar breakdown':pullbackShort?'EMA20 pullback/reclaim':'EMA continuation','trend persistence confirmed','RSI confirmation','cost-aware volatility','controlled extension',impulseShort?'impulse confirmation':''].filter(Boolean);
 }else return wait(entry,['Production setup below quality threshold'],Math.max(longScore,shortScore));

 // Keep the structural stop intact. The prior version compressed a large structural
 // stop down to 0.85 ATR, which could place the stop inside the recent swing and
 // artificially inflate the advertised R multiple.
 const recent=p.slice(-8),swingLow=Math.min(...recent),swingHigh=Math.max(...recent);
 const floor=Math.max(entry*0.0008,a*0.35);
 const rawRisk=side==='LONG'?Math.max(entry-swingLow,floor):Math.max(swingHigh-entry,floor);
 const dist=Math.max(rawRisk,floor);

 const ultraQuality=score>=94&&eff24>=.50&&eff48>=.38&&separation>=.25&&volatilityExpansion>=.90&&volatilityExpansion<=1.80;
 const riskReward=cfg.riskReward!==undefined?clamp(cfg.riskReward,10,15):(ultraQuality?15:10);
 const targetDistance=dist*riskReward;
 const pathCapacity=a*(8+14*eff24+5*Math.max(0,separation));
 const targetPathOk=targetDistance<=pathCapacity;
 if(!targetPathOk)return wait(entry,['Target path is not supported by current trend persistence'],score);

 const stopLoss=side==='LONG'?entry-dist:entry+dist,takeProfit=side==='LONG'?entry+targetDistance:entry-targetDistance;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Regime Breakout v15',entry,stopLoss,takeProfit,riskReward,reasons:[...reasons,`risk-normalized ${riskReward}R target`,`trend efficiency ${(eff24*100).toFixed(0)}%`,`score ${Math.round(score)}/100`]};
}

export function evaluateProductionStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config});}
export function evaluateResearchStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config,minScore:config.minScore??85});}
export function evaluateStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(prices,config);}
