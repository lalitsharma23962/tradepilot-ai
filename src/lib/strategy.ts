import type { Side } from './types';

export interface StrategySignal { action: Side | 'WAIT'; score: number; confidence: number; strategy: string; entry: number; stopLoss: number; takeProfit: number; riskReward: number; reasons: string[]; }
export interface StrategyConfig { minScore: number; minRiskReward: number; maxRiskReward: number; atrStopMultiple: number; lookback: number; riskPerTradePct?: number; strategyLimit?: number; }
const DEFAULT_CONFIG: StrategyConfig = { minScore: 85, minRiskReward: 1.8, maxRiskReward: 3.2, atrStopMultiple: 1.15, lookback: 180, strategyLimit: 10 };
const PROFILES = [
  { name: 'Trend Breakout', trend: 30, momentum: 20, trigger: 32, volatility: 18, extensionPenalty: 16 },
  { name: 'Trend Pullback', trend: 32, momentum: 18, trigger: 30, volatility: 20, extensionPenalty: 15 },
  { name: 'Momentum Continuation', trend: 24, momentum: 30, trigger: 28, volatility: 18, extensionPenalty: 17 },
  { name: 'Volatility Expansion', trend: 20, momentum: 20, trigger: 30, volatility: 30, extensionPenalty: 15 },
  { name: 'EMA Reclaim', trend: 30, momentum: 18, trigger: 32, volatility: 20, extensionPenalty: 16 },
  { name: 'Range Break', trend: 22, momentum: 20, trigger: 34, volatility: 24, extensionPenalty: 18 },
  { name: 'Compression Break', trend: 20, momentum: 22, trigger: 32, volatility: 26, extensionPenalty: 16 },
  { name: 'Structure Continuation', trend: 32, momentum: 22, trigger: 28, volatility: 18, extensionPenalty: 18 },
  { name: 'Adaptive Trend', trend: 26, momentum: 24, trigger: 30, volatility: 20, extensionPenalty: 17 },
  { name: 'Defensive Momentum', trend: 30, momentum: 26, trigger: 26, volatility: 18, extensionPenalty: 20 },
] as const;
function ema(values: number[], period: number): number { if (!values.length) return 0; const k=2/(period+1); let out=values[0]; for(let i=1;i<values.length;i++) out=values[i]*k+out*(1-k); return out; }
function mean(values:number[]):number{return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;}
function std(values:number[]):number{const m=mean(values);return values.length>1?Math.sqrt(mean(values.map(v=>(v-m)**2))):0;}
function atrLike(values:number[],period=20):number{const slice=values.slice(-(period+1));return slice.length>1?mean(slice.slice(1).map((v,i)=>Math.abs(v-slice[i]))):0;}
function slope(values:number[]):number{if(values.length<2)return 0;const n=values.length,xMean=(n-1)/2,yMean=mean(values);let numerator=0,denominator=0;for(let i=0;i<n;i++){numerator+=(i-xMean)*(values[i]-yMean);denominator+=(i-xMean)**2;}return denominator?numerator/denominator:0;}
function rsi(values:number[],period=14):number{if(values.length<=period)return 50;let gain=0,loss=0;const start=values.length-period;for(let i=start;i<values.length;i++){const delta=values[i]-values[i-1];if(delta>=0)gain+=delta;else loss-=delta;}if(loss===0)return 100;const rs=gain/loss;return 100-100/(1+rs);}
function high(values:number[],n:number):number{return Math.max(...values.slice(-n));}
function low(values:number[],n:number):number{return Math.min(...values.slice(-n));}
function clamp(value:number,min:number,max:number):number{return Math.max(min,Math.min(max,value));}
function waitSignal(entry:number,reasons:string[],score=0):StrategySignal{const normalized=Math.round(clamp(score,0,100));return{action:'WAIT',score:normalized,confidence:normalized,strategy:'No Trade',entry,stopLoss:entry,takeProfit:entry,riskReward:0,reasons};}

function scoreProduction(prices:number[],cfg:StrategyConfig):StrategySignal{
 const clean=prices.filter(p=>Number.isFinite(p)&&p>0).slice(-cfg.lookback),entry=clean.length?clean[clean.length-1]:0;
 if(clean.length<120||entry<=0)return waitSignal(entry,['Not enough history']);
 const ema20=ema(clean,20),ema50=ema(clean,50),ema100=ema(clean,100),atr=atrLike(clean,20),volatility=atr/entry,momentum=slope(clean.slice(-12))/entry;
 const momentumThreshold=Math.max(volatility*0.12,0.00025),currentRsi=rsi(clean,14),prior=clean.slice(0,-1),high20=high(prior,20),low20=low(prior,20),medium=clean.slice(-30),mediumStd=std(medium),z=mediumStd>0?(entry-mean(medium))/mediumStd:0;
 const longTrend=ema20>ema50&&ema50>ema100,shortTrend=ema20<ema50&&ema50<ema100,longMomentum=momentum>momentumThreshold,shortMomentum=momentum<-momentumThreshold,longBreak=entry>high20+atr*0.05,shortBreak=entry<low20-atr*0.05,saneVolatility=volatility>=0.001&&volatility<=0.008,longNotExtended=currentRsi>=52&&currentRsi<=70&&z<2,shortNotExtended=currentRsi>=30&&currentRsi<=48&&z>-2;
 const longConfirmed=longTrend&&longMomentum&&longBreak&&saneVolatility&&longNotExtended,shortConfirmed=shortTrend&&shortMomentum&&shortBreak&&saneVolatility&&shortNotExtended;
 if(!longConfirmed&&!shortConfirmed){const partial=Math.round((longTrend||shortTrend?25:0)+(longMomentum||shortMomentum?20:0)+(longBreak||shortBreak?25:0)+(saneVolatility?15:0));return waitSignal(entry,['Production confirmation incomplete'],partial);}
 const side:Side=longConfirmed?'LONG':'SHORT',stopDistance=Math.max(atr*cfg.atrStopMultiple,entry*0.0015),riskReward=clamp(2.2,cfg.minRiskReward,cfg.maxRiskReward),stopLoss=side==='LONG'?entry-stopDistance:entry+stopDistance,takeProfit=side==='LONG'?entry+stopDistance*riskReward:entry-stopDistance*riskReward;
 const reasons=side==='LONG'?['bullish EMA regime','confirmed momentum','fresh 20-bar breakout','sane volatility','not overextended']:['bearish EMA regime','confirmed momentum','fresh 20-bar breakdown','sane volatility','not overextended'];
 return{action:side,score:100,confidence:100,strategy:'Production Breakout v5',entry,stopLoss,takeProfit,riskReward,reasons};
}
export function evaluateProductionStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return scoreProduction(prices,{...DEFAULT_CONFIG,...config});}

function scoreProfile(prices:number[],cfg:StrategyConfig,profile:typeof PROFILES[number]):StrategySignal{
 const clean=prices.filter(p=>Number.isFinite(p)&&p>0).slice(-cfg.lookback),entry=clean.length?clean[clean.length-1]:0;if(clean.length<120||entry<=0)return waitSignal(entry,['Not enough history']);
 const ema20=ema(clean,20),ema50=ema(clean,50),ema100=ema(clean,100),atr=atrLike(clean,20),atrFast=atrLike(clean,8),volatility=atr/entry,momentum=slope(clean.slice(-12))/entry,momentumThreshold=Math.max(volatility*0.06,0.00012),currentRsi=rsi(clean,14),prior=clean.slice(0,-1),high12=high(prior,12),low12=low(prior,12),high20=high(prior,20),low20=low(prior,20),range50=high(prior,50)-low(prior,50),medium=clean.slice(-30),mediumStd=std(medium),z=mediumStd>0?(entry-mean(medium))/mediumStd:0,compressed=atr>0&&atrFast/atr<0.9;
 let longScore=0,shortScore=0;const longReasons:string[]=[],shortReasons:string[]=[],longTrend=ema20>ema50&&ema50>ema100,shortTrend=ema20<ema50&&ema50<ema100;
 if(longTrend){longScore+=profile.trend;longReasons.push('bullish EMA regime');}if(shortTrend){shortScore+=profile.trend;shortReasons.push('bearish EMA regime');}if(momentum>momentumThreshold){longScore+=profile.momentum;longReasons.push('positive momentum');}if(momentum<-momentumThreshold){shortScore+=profile.momentum;shortReasons.push('negative momentum');}
 const longBreak=entry>high20&&entry>high12,shortBreak=entry<low20&&entry<low12,longReclaim=entry>ema20&&clean.slice(-6,-1).some(p=>p<=ema20),shortReclaim=entry<ema20&&clean.slice(-6,-1).some(p=>p>=ema20);
 if(longBreak||(longReclaim&&longTrend)){longScore+=profile.trigger;longReasons.push(longBreak?'20-bar breakout':'EMA20 reclaim');}if(shortBreak||(shortReclaim&&shortTrend)){shortScore+=profile.trigger;shortReasons.push(shortBreak?'20-bar breakdown':'EMA20 reclaim');}
 if(volatility>=0.0007&&volatility<=0.012){if(longScore>0){longScore+=profile.volatility;longReasons.push('tradable volatility');}if(shortScore>0){shortScore+=profile.volatility;shortReasons.push('tradable volatility');}}
 if(compressed&&(longBreak||shortBreak)){if(longBreak){longScore+=8;longReasons.push('compression expansion');}if(shortBreak){shortScore+=8;shortReasons.push('compression expansion');}}
 if(currentRsi>72)longScore-=profile.extensionPenalty;if(currentRsi<28)shortScore-=profile.extensionPenalty;if(z>2)longScore-=profile.extensionPenalty;if(z<-2)shortScore-=profile.extensionPenalty;
 const side:Side=longScore>=shortScore?'LONG':'SHORT',score=Math.max(longScore,shortScore),reasons=side==='LONG'?longReasons:shortReasons,trigger=side==='LONG'?(longBreak||(longReclaim&&longTrend)):(shortBreak||(shortReclaim&&shortTrend));
 if(score<cfg.minScore)return waitSignal(entry,[`Score ${Math.max(0,Math.round(score))}/${cfg.minScore}`,...reasons],score);if(!trigger)return waitSignal(entry,['No structural trigger',...reasons],score);if(!atr||!range50)return waitSignal(entry,['Invalid volatility structure'],score);
 const stopDistance=Math.max(atr*cfg.atrStopMultiple,entry*0.0015),projection=Math.max(atr*3,Math.abs(slope(clean.slice(-12)))*42,range50*0.55),rawR=projection/stopDistance;if(!Number.isFinite(rawR)||rawR<cfg.minRiskReward)return waitSignal(entry,[`Projected R ${Number.isFinite(rawR)?rawR.toFixed(1):'0.0'} below ${cfg.minRiskReward}`,...reasons],score);
 const riskReward=clamp(rawR,cfg.minRiskReward,cfg.maxRiskReward),stopLoss=side==='LONG'?entry-stopDistance:entry+stopDistance,takeProfit=side==='LONG'?entry+stopDistance*riskReward:entry-stopDistance*riskReward;
 return{action:side,score:Math.round(clamp(score,0,100)),confidence:Math.round(clamp(score,0,100)),strategy:profile.name,entry,stopLoss,takeProfit,riskReward,reasons};
}

/** Research-only evaluator. Production execution must use evaluateProductionStrategy. */
export function evaluateResearchStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{
 const cfg={...DEFAULT_CONFIG,...config},limit=Math.min(10,Math.max(1,Math.round(cfg.strategyLimit??10))),signals=PROFILES.slice(0,limit).map(p=>scoreProfile(prices,cfg,p)).filter(s=>s.action!=='WAIT');
 if(!signals.length)return waitSignal(prices.length?prices[prices.length-1]:0,['No research strategy passed the filter set']);return signals.sort((a,b)=>b.score-a.score||b.riskReward-a.riskReward)[0];
}

/** Backward-compatible production entry point. It is intentionally strict. */
export function evaluateStrategy(prices:number[],config:Partial<StrategyConfig>={}):StrategySignal{return evaluateProductionStrategy(prices,config);}
