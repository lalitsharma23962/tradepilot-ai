import type { Side } from './types';

export interface StrategySignal { action: Side|'WAIT'; score:number; confidence:number; strategy:string; entry:number; stopLoss:number; takeProfit:number; riskReward:number; reasons:string[]; }
export interface StrategyConfig { minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number; lookback:number; riskPerTradePct?:number; strategyLimit?:number; feeBps?:number; slippageBps?:number; riskReward?:number; }

const DEFAULT_CONFIG:StrategyConfig={minScore:90,minRiskReward:10,maxRiskReward:15,atrStopMultiple:1.15,lookback:240,strategyLimit:17,feeBps:10,slippageBps:2};
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const trueRange=(x:number[])=>x.slice(1).map((v,i)=>Math.abs(v-x[i]));
const atr=(x:number[],p=20)=>{const s=x.slice(-(p+1));return mean(trueRange(s));};
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const efficiency=(x:number[])=>{if(x.length<3)return 0;const net=Math.abs(x[x.length-1]-x[0]);const path=x.slice(1).reduce((s,v,i)=>s+Math.abs(v-x[i]),0);return path?net/path:0;};
const directionalConsistency=(x:number[],side:1|-1)=>{if(x.length<2)return 0;const d=x.slice(1).map((v,i)=>v-x[i]);return d.length?d.filter(v=>side===1?v>0:v<0).length/d.length:0;};
const dispersion=(x:number[])=>{if(x.length<2)return 0;const m=mean(x);return Math.sqrt(mean(x.map(v=>(v-m)**2)));};
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,reasons});

/**
 * High-RR production model.
 * The important change is quality over frequency: a 10R/15R target is only
 * attempted when trend structure, persistence, breakout/pullback confirmation,
 * volatility regime and target runway agree. Generic momentum-only entries are
 * intentionally rejected because they produced too many low-quality trades.
 */
function production(prices:number[],cfg:StrategyConfig):StrategySignal{
 const p=prices.filter(Number.isFinite).filter(v=>v>0).slice(-cfg.lookback),entry=p[p.length-1]??0;
 if(p.length<160||!entry)return wait(entry,['Not enough history']);

 const e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100);
 const a=atr(p),a12=atr(p,12),a48=atr(p,48),vol=a/entry,rrsi=rsi(p);
 const s8=slope(p.slice(-8))/entry,s12=slope(p.slice(-12))/entry,s24=slope(p.slice(-24))/entry,s48=slope(p.slice(-48))/entry;
 const eff24=efficiency(p.slice(-24)),eff48=efficiency(p.slice(-48));
 const consistencyLong=directionalConsistency(p.slice(-17),1),consistencyShort=directionalConsistency(p.slice(-17),-1);
 const separation=Math.abs(e20-e50)/Math.max(a,entry*0.000001);
 const volatilityExpansion=a48>0?a12/a48:1;
 const prior=p.slice(0,-1),hi20=Math.max(...prior.slice(-20)),lo20=Math.min(...prior.slice(-20));
 const hi8=Math.max(...prior.slice(-8)),lo8=Math.min(...prior.slice(-8));
 const trendUp=e9>e20&&e20>e50&&e50>e100,trendDown=e9<e20&&e20<e50&&e50<e100;
 const mediumUp=e20>e50&&e50>=e100&&s24>0,mediumDown=e20<e50&&e50<=e100&&s24<0;
 const momentumThreshold=Math.max(.000025,vol*.015);
 const momentumLong=s12>momentumThreshold&&s24>0&&s48>0,momentumShort=s12<-momentumThreshold&&s24<0&&s48<0;
 const breakoutLong=entry>hi20+a*0.12,breakoutShort=entry<lo20-a*0.12;
 const freshBreakoutLong=entry>hi8+a*0.08, freshBreakoutShort=entry<lo8-a*0.08;
 const pullLong=(trendUp||mediumUp)&&entry>e20&&p.slice(-12,-2).some(v=>v<=e20*1.0015)&&s8>0;
 const pullShort=(trendDown||mediumDown)&&entry<e20&&p.slice(-12,-2).some(v=>v>=e20*.9985)&&s8<0;
 const roundTripCost=(2*(cfg.feeBps??10)+2*(cfg.slippageBps??2))/10000;
 const costAware=vol>=Math.max(.00035,roundTripCost*.65)&&vol<=.025;
 const notExtended=Math.abs(entry-e20)<=a*1.65;
 const trendQualityLong=eff24>=.38&&eff48>=.26&&consistencyLong>=.59&&separation>=.14;
 const trendQualityShort=eff24>=.38&&eff48>=.26&&consistencyShort>=.59&&separation>=.14;
 const expansionQuality=volatilityExpansion>=.72&&volatilityExpansion<=2.0;
 const compression=dispersion(p.slice(-12))/Math.max(dispersion(p.slice(-48)),entry*0.000001)<=.72;
 const impulseLong=(entry-p[Math.max(0,p.length-7)])/Math.max(a,entry*0.000001)>=.18;
 const impulseShort=(p[Math.max(0,p.length-7)]-entry)/Math.max(a,entry*0.000001)>=.18;
 const pullImpulseLong=p.slice(-5).reduce((s,v,i,a)=>i?s+Math.max(0,v-a[i-1]):s,0)/Math.max(a,entry*0.000001)>=.16;
 const pullImpulseShort=p.slice(-5).reduce((s,v,i,a)=>i?s+Math.max(0,a[i-1]-v):s,0)/Math.max(a,entry*0.000001)>=.16;

 const breakoutSetupLong=(trendUp||mediumUp)&&trendQualityLong&&costAware&&expansionQuality&&breakoutLong&&freshBreakoutLong&&momentumLong&&impulseLong;
 const breakoutSetupShort=(trendDown||mediumDown)&&trendQualityShort&&costAware&&expansionQuality&&breakoutShort&&freshBreakoutShort&&momentumShort&&impulseShort;
 const pullbackSetupLong=(trendUp||mediumUp)&&trendQualityLong&&costAware&&notExtended&&pullLong&&momentumLong&&pullImpulseLong;
 const pullbackSetupShort=(trendDown||mediumDown)&&trendQualityShort&&costAware&&notExtended&&pullShort&&momentumShort&&pullImpulseShort;

 const longScore=(trendUp?24:mediumUp?18:0)+(e9>e20?8:0)+(momentumLong?16:0)+(breakoutSetupLong?22:pullbackSetupLong?18:0)+(rrsi>=50&&rrsi<=70?8:0)+(costAware?6:0)+(trendQualityLong?13:0)+(expansionQuality?4:0)+(notExtended?4:0)+(compression?2:0);
 const shortScore=(trendDown?24:mediumDown?18:0)+(e9<e20?8:0)+(momentumShort?16:0)+(breakoutSetupShort?22:pullbackSetupShort?18:0)+(rrsi>=30&&rrsi<=50?8:0)+(costAware?6:0)+(trendQualityShort?13:0)+(expansionQuality?4:0)+(notExtended?4:0)+(compression?2:0);
 const effectiveMinScore=Math.max(92,cfg.minScore);

 let side:Side,score:number,reasons:string[];
 if(breakoutSetupLong&&longScore>=effectiveMinScore){side='LONG';score=longScore;reasons=['bullish EMA regime','multi-horizon momentum','fresh volatility-cleared breakout','trend persistence confirmed','RSI confirmation','cost-aware volatility','controlled extension',compression?'recent compression released':'clean expansion','impulse confirmation'];}
 else if(pullbackSetupLong&&longScore>=effectiveMinScore){side='LONG';score=longScore;reasons=['bullish EMA regime','multi-horizon momentum','EMA20 pullback/reclaim','trend persistence confirmed','RSI confirmation','cost-aware volatility','controlled extension','pullback impulse confirmation'];}
 else if(breakoutSetupShort&&shortScore>=effectiveMinScore){side='SHORT';score=shortScore;reasons=['bearish EMA regime','multi-horizon momentum','fresh volatility-cleared breakdown','trend persistence confirmed','RSI confirmation','cost-aware volatility','controlled extension',compression?'recent compression released':'clean expansion','impulse confirmation'];}
 else if(pullbackSetupShort&&shortScore>=effectiveMinScore){side='SHORT';score=shortScore;reasons=['bearish EMA regime','multi-horizon momentum','EMA20 pullback/reclaim','trend persistence confirmed','RSI confirmation','cost-aware volatility','controlled extension','pullback impulse confirmation'];}
 else return wait(entry,['Production setup below high-RR quality threshold'],Math.max(longScore,shortScore));

 const recent=p.slice(-12),swingLow=Math.min(...recent),swingHigh=Math.max(...recent);
 const floor=Math.max(entry*0.0008,a*0.45);
 const rawRisk=side==='LONG'?Math.max(entry-swingLow,floor):Math.max(swingHigh-entry,floor);
 const dist=Math.max(rawRisk,a*0.55,entry*roundTripCost*2.0);
 const ultraQuality=score>=97&&eff24>=.52&&eff48>=.38&&(side==='LONG'?consistencyLong:consistencyShort)>=.67&&separation>=.24&&volatilityExpansion>=.85&&volatilityExpansion<=1.75;
 const riskReward=cfg.riskReward!==undefined?clamp(cfg.riskReward,10,15):(ultraQuality?15:10);
 const targetDistance=dist*riskReward;
 const pathCapacity=a*(12+30*eff24+12*Math.max(0,separation)+8*Math.max(0,volatilityExpansion-1));
 if(targetDistance>pathCapacity)return wait(entry,['Target path is not supported by current trend persistence'],score);
 const stopLoss=side==='LONG'?entry-dist:entry+dist,takeProfit=side==='LONG'?entry+targetDistance:entry-targetDistance;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Regime Breakout v21',entry,stopLoss,takeProfit,riskReward,reasons:[...reasons,`risk-normalized ${riskReward}R target`,`trend efficiency ${(eff24*100).toFixed(0)}%`,`score ${Math.round(score)}/100`]};
}

export function evaluateProductionStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config});}
export function evaluateResearchStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config,minScore:config.minScore??90});}
export function evaluateStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(prices,config);}
