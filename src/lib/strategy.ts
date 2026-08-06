import type { Side } from './types';

export interface StrategySignal { action: Side|'WAIT'; score:number; confidence:number; strategy:string; entry:number; stopLoss:number; takeProfit:number; riskReward:number; reasons:string[]; }
export interface StrategyConfig { minScore:number; minRiskReward:number; maxRiskReward:number; atrStopMultiple:number; lookback:number; riskPerTradePct?:number; strategyLimit?:number; feeBps?:number; slippageBps?:number; riskReward?:number; }

const DEFAULT_CONFIG:StrategyConfig={minScore:90,minRiskReward:10,maxRiskReward:15,atrStopMultiple:1.15,lookback:240,strategyLimit:17,feeBps:10,slippageBps:2};
const CLOSE_ATR_TO_TRUE_ATR=1.79;
const MAX_STRUCTURAL_RISK_TRUE_ATR=1.35;
const MAX_STRUCTURAL_RISK_ATR=MAX_STRUCTURAL_RISK_TRUE_ATR*CLOSE_ATR_TO_TRUE_ATR;
const SWING_LOOKBACK=5;
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const trueRange=(x:number[])=>x.slice(1).map((v,i)=>Math.abs(v-x[i]));
const atr=(x:number[],p=20)=>mean(trueRange(x.slice(-(p+1))));
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const efficiency=(x:number[])=>{if(x.length<3)return 0;const net=Math.abs(x.at(-1)!-x[0]);const path=x.slice(1).reduce((s,v,i)=>s+Math.abs(v-x[i]),0);return path?net/path:0;};
const directionalConsistency=(x:number[],side:1|-1)=>{if(x.length<2)return 0;const d=x.slice(1).map((v,i)=>v-x[i]);return d.filter(v=>side===1?v>0:v<0).length/d.length;};
const dispersion=(x:number[])=>{if(x.length<2)return 0;const m=mean(x);return Math.sqrt(mean(x.map(v=>(v-m)**2)));};
const wait=(entry:number,reasons:string[],score=0):StrategySignal=>({action:'WAIT',score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,reasons});

/** v26: multi-family high-confidence regime engine. Four setup families share
 * strict regime, momentum, cost, structural-risk and target-path guards. */
function production(prices:number[],cfg:StrategyConfig):StrategySignal{
 const p=prices.filter(Number.isFinite).filter(v=>v>0).slice(-cfg.lookback),entry=p.at(-1)??0;
 if(p.length<160||!entry)return wait(entry,['Not enough history']);
 const e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100);
 const a=atr(p),a12=atr(p,12),a48=atr(p,48),vol=a/entry,rrsi=rsi(p);
 const s8=slope(p.slice(-8))/entry,s12=slope(p.slice(-12))/entry,s24=slope(p.slice(-24))/entry,s48=slope(p.slice(-48))/entry;
 const eff12=efficiency(p.slice(-12)),eff24=efficiency(p.slice(-24)),eff48=efficiency(p.slice(-48));
 const consistencyLong=directionalConsistency(p.slice(-15),1),consistencyShort=directionalConsistency(p.slice(-15),-1);
 const separation=Math.abs(e20-e50)/Math.max(a,entry*0.000001);
 const expansion=a48>0?a12/a48:1;
 const prior=p.slice(0,-1),hi20=Math.max(...prior.slice(-20)),lo20=Math.min(...prior.slice(-20)),hi8=Math.max(...prior.slice(-8)),lo8=Math.min(...prior.slice(-8));
 const trendUp=e20>e50&&e50>e100,trendDown=e20<e50&&e50<e100;
 const mediumUp=e20>e50&&s24>0,mediumDown=e20<e50&&s24<0;
 const regimeLong=trendUp||mediumUp,regimeShort=trendDown||mediumDown;
 const momentumThreshold=Math.max(.000015,vol*.008);
 const momentumLong=s12>momentumThreshold&&s24>0&&s48>0,momentumShort=s12<-momentumThreshold&&s24<0&&s48<0;
 const trendQualityLong=eff24>=.25&&eff48>=.18&&consistencyLong>=.50&&separation>=.06;
 const trendQualityShort=eff24>=.25&&eff48>=.18&&consistencyShort>=.50&&separation>=.06;
 const costRoundTrip=2*((cfg.feeBps??10)+(cfg.slippageBps??2))/10000;
 const costAware=vol>=Math.max(.00030,costRoundTrip*.50)&&vol<=.03;
 const notExtended=Math.abs(entry-e20)<=a*2.15;
 const expansionQuality=expansion>=.55&&expansion<=2.50;
 const compressed=dispersion(p.slice(-12))/Math.max(dispersion(p.slice(-48)),entry*0.000001)<=.82;
 const expanding=expansion>=.85;
 const impulseLong=(entry-p[Math.max(0,p.length-7)])/Math.max(a,entry*0.000001)>=.08;
 const impulseShort=(p[Math.max(0,p.length-7)]-entry)/Math.max(a,entry*0.000001)>=.08;
 const recentImpulseLong=p.slice(-5).reduce((s,v,i,x)=>i?s+Math.max(0,v-x[i-1]):s,0)/Math.max(a,entry*0.000001)>=.07;
 const recentImpulseShort=p.slice(-5).reduce((s,v,i,x)=>i?s+Math.max(0,x[i-1]-v):s,0)/Math.max(a,entry*0.000001)>=.07;
 const breakoutLong=entry>hi20+a*.03&&entry>hi8+a*.02,breakoutShort=entry<lo20-a*.03&&entry<lo8-a*.02;
 const retestLong=regimeLong&&entry>e20&&p.slice(-14,-2).some(v=>v<=e20*1.002)&&recentImpulseLong;
 const retestShort=regimeShort&&entry<e20&&p.slice(-14,-2).some(v=>v>=e20*.998)&&recentImpulseShort;
 const continuationLong=regimeLong&&momentumLong&&entry>e20&&s8>0&&eff12>=.22&&recentImpulseLong;
 const continuationShort=regimeShort&&momentumShort&&entry<e20&&s8<0&&eff12>=.22&&recentImpulseShort;
 const compressionBreakLong=regimeLong&&compressed&&expanding&&momentumLong&&impulseLong&&entry>e20;
 const compressionBreakShort=regimeShort&&compressed&&expanding&&momentumShort&&impulseShort&&entry<e20;
 const longFamily=Math.max(breakoutLong?21:0,retestLong?19:0,continuationLong?18:0,compressionBreakLong?20:0);
 const shortFamily=Math.max(breakoutShort?21:0,retestShort?19:0,continuationShort?18:0,compressionBreakShort?20:0);
 const longScore=(trendUp?21:mediumUp?17:0)+(e9>e20?7:0)+(momentumLong?16:0)+longFamily+(rrsi>=47&&rrsi<=73?8:0)+(costAware?7:0)+(trendQualityLong?12:0)+(expansionQuality?4:0)+(notExtended?5:0)+(compressed&&expanding?3:0);
 const shortScore=(trendDown?21:mediumDown?17:0)+(e9<e20?7:0)+(momentumShort?16:0)+shortFamily+(rrsi>=27&&rrsi<=53?8:0)+(costAware?7:0)+(trendQualityShort?12:0)+(expansionQuality?4:0)+(notExtended?5:0)+(compressed&&expanding?3:0);
 const effectiveMinScore=Math.max(90,cfg.minScore);
 let side:Side,score:number,reasons:string[];
 if(regimeLong&&momentumLong&&costAware&&notExtended&&trendQualityLong&&longFamily>0&&longScore>=effectiveMinScore){side='LONG';score=longScore;reasons=[breakoutLong?'Fresh breakout setup':compressionBreakLong?'Compression expansion setup':retestLong?'Breakout retest setup':'Trend continuation setup','bullish multi-EMA regime','multi-horizon momentum','trend persistence confirmed','cost-aware volatility','controlled extension',rrsi>=47&&rrsi<=73?'RSI confirmation':'momentum-led confirmation',expansionQuality?'healthy volatility expansion':'stable volatility'];}
 else if(regimeShort&&momentumShort&&costAware&&notExtended&&trendQualityShort&&shortFamily>0&&shortScore>=effectiveMinScore){side='SHORT';score=shortScore;reasons=[breakoutShort?'Fresh breakdown setup':compressionBreakShort?'Compression expansion setup':retestShort?'Breakdown retest setup':'Trend continuation setup','bearish multi-EMA regime','multi-horizon momentum','trend persistence confirmed','cost-aware volatility','controlled extension',rrsi>=27&&rrsi<=53?'RSI confirmation':'momentum-led confirmation',expansionQuality?'healthy volatility expansion':'stable volatility'];}
 else return wait(entry,['No high-confidence setup family passed the multi-factor score gate'],Math.max(longScore,shortScore));
 const recent=p.slice(-SWING_LOOKBACK),swingLow=Math.min(...recent),swingHigh=Math.max(...recent),floor=Math.max(entry*.0008,a*.55);
 const rawRisk=side==='LONG'?Math.max(entry-swingLow,floor):Math.max(swingHigh-entry,floor),structuralCap=a*MAX_STRUCTURAL_RISK_ATR;
 if(rawRisk>structuralCap)return wait(entry,[`Structural stop is too wide: ${rawRisk.toFixed(2)} exceeds the calibrated ${MAX_STRUCTURAL_RISK_TRUE_ATR.toFixed(2)} true-ATR ceiling`],score);
 const dist=Math.max(rawRisk,floor,entry*costRoundTrip*2),ultraQuality=score>=96&&eff24>=.42&&eff48>=.28&&(side==='LONG'?consistencyLong:consistencyShort)>=.60&&separation>=.15&&expansion>=.75&&expansion<=2.0;
 const riskReward=cfg.riskReward!==undefined?clamp(cfg.riskReward,10,15):(ultraQuality?15:10),targetDistance=dist*riskReward;
 const pathCapacity=a*(12+35*eff24+10*separation+8*Math.max(0,expansion-1)+5*eff48);
 if(targetDistance>pathCapacity)return wait(entry,['10R/15R target path is not supported by current trend persistence'],score);
 const stopLoss=side==='LONG'?entry-dist:entry+dist,takeProfit=side==='LONG'?entry+targetDistance:entry-targetDistance;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:'Production Regime Breakout v26',entry,stopLoss,takeProfit,riskReward,reasons:[...reasons,`risk-normalized ${riskReward}R target`,`structural risk ceiling ${MAX_STRUCTURAL_RISK_TRUE_ATR.toFixed(2)} true ATR`,`trend efficiency ${(eff24*100).toFixed(0)}%`,`score ${Math.round(score)}/100`]};
}

export function evaluateProductionStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config});}
export function evaluateResearchStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return production(prices,{...DEFAULT_CONFIG,...config,minScore:config.minScore??90});}
export function evaluateStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(prices,config);}
