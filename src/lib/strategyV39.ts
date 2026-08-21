import type { MarketBar } from './marketData';

export interface StrategyConfig {
  atrPeriod?: number;
  atrMultStop?: number;
  atrMultTp?: number;
  minRiskReward?: number;
  minScore?: number;
  htf1h?: MarketBar[];
  htf4h?: MarketBar[];
}
export interface TargetLadderStep { r: number; fraction: number; price: number; moveStopToBreakeven: boolean; }
export interface StrategySignalV39 { action: 'LONG' | 'SHORT' | 'WAIT'; family: string; strategy: string; entry: number; stopLoss: number; takeProfit: number; riskReward: number; score: number; targets: TargetLadderStep[]; finalTargetR: number; reasons: string[]; }
export type StrategySignal = StrategySignalV39;

function ema(values:number[],period:number){if(values.length<period)return NaN;const k=2/(period+1);let e=values.slice(0,period).reduce((a,b)=>a+b,0)/period;for(let i=period;i<values.length;i++)e=values[i]*k+e*(1-k);return e;}
function atr(bars:MarketBar[],period:number){if(bars.length<=period)return NaN;const tr:number[]=[];for(let i=1;i<bars.length;i++){const c=bars[i],p=bars[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}return tr.slice(-period).reduce((a,b)=>a+b,0)/period;}
function adx(bars:MarketBar[],period=14){if(bars.length<period*2+1)return NaN;const dx:number[]=[];for(let i=period;i<bars.length;i++){let trSum=0,plus=0,minus=0;for(let j=i-period+1;j<=i;j++){const c=bars[j],p=bars[j-1],tr=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));const up=c.high-p.high,down=p.low-c.low;trSum+=tr;if(up>down&&up>0)plus+=up;else if(down>up&&down>0)minus+=down;}const pdi=trSum?100*plus/trSum:0,mdi=trSum?100*minus/trSum:0;dx.push(pdi+mdi===0?0:100*Math.abs(pdi-mdi)/(pdi+mdi));}return dx.slice(-period).reduce((a,b)=>a+b,0)/Math.min(period,dx.length);}
function rsi(bars:MarketBar[],period=14){if(bars.length<=period)return NaN;let g=0,l=0;for(let i=bars.length-period;i<bars.length;i++){const d=bars[i].close-bars[i-1].close;if(d>0)g+=d;else l-=d;}if(l===0)return 100;const rs=(g/period)/(l/period);return 100-100/(1+rs);}
function aggregate(bars:MarketBar[],size:number){const out:MarketBar[]=[];for(let i=0;i+size<=bars.length;i+=size){const g=bars.slice(i,i+size);out.push({openTime:g[0].openTime,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[g.length-1].close,volume:g.reduce((s,x)=>s+x.volume,0)});}return out;}
function wait(entry:number,reasons:string[]):StrategySignalV39{return{action:'WAIT',family:'TrendPullback',strategy:'Trend Pullback v39',entry,stopLoss:0,takeProfit:0,riskReward:0,score:0,targets:[],finalTargetR:0,reasons};}

export function evaluateV39(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV39{
 const period=config.atrPeriod??14,stopMult=config.atrMultStop??1.5,minScore=config.minScore??82;
 let bars:MarketBar[]=[];if(Array.isArray(input)&&input.length)bars=typeof input[0]==='number'?(input as number[]).map((v,i)=>({openTime:i,open:v,high:v,low:v,close:v,volume:0})):input as MarketBar[];
 if(bars.length<240)return wait(0,['Insufficient 5m history for multi-timeframe regime analysis']);
 const h1=config.htf1h??aggregate(bars,12),h4=config.htf4h??aggregate(bars,48);if(h1.length<210||h4.length<210)return wait(bars.at(-1)?.close??0,['Insufficient completed 1h/4h history for EMA 200 confirmation']);
 const c5=bars.map(b=>b.close),c1=h1.map(b=>b.close),c4=h4.map(b=>b.close),a5=atr(bars,period),e20=ema(c5,20),e50=ema(c5,50),e201=ema(c1,20),e501=ema(c1,50),e2001=ema(c1,200),e204=ema(c4,20),e504=ema(c4,50),e2004=ema(c4,200),aDx=adx(bars),aDx1=adx(h1),r=rsi(bars);
 const last=bars.at(-1)!,prev=bars.at(-2)!,entry=last.close;if(![a5,e20,e50,e201,e501,e2001,e204,e504,e2004,aDx,aDx1,r].every(Number.isFinite))return wait(entry,['Indicator warm-up incomplete']);
 const longTrend=c1.at(-1)!>e201&&e201>e501&&e501>e2001&&c4.at(-1)!>e204&&e204>e504&&e504>e2004;
 const shortTrend=c1.at(-1)!<e201&&e201<e501&&e501<e2001&&c4.at(-1)!<e204&&e204<e504&&e504<e2004;
 if(aDx<25||aDx1<20)return wait(entry,['Sideways/weak regime rejected: ADX below trend-strength threshold']);
 const bull=prev.low<=e50&&last.close>e20&&last.close>last.open&&last.close>prev.high,bear=prev.high>=e50&&last.close<e20&&last.close<last.open&&last.close<prev.low;
 const vAvg=bars.slice(-21,-1).reduce((s,b)=>s+b.volume,0)/20,vOk=vAvg<=0||last.volume>=vAvg*1.15;let action:'LONG'|'SHORT'|'WAIT'='WAIT';const reasons:string[]=[];
 if(longTrend&&bull&&r>=50&&r<=72){action='LONG';reasons.push('1h/4h EMA20>50>200 alignment','5m EMA20/50 pullback reclaim','bullish rejection and breakout candle','RSI and ADX momentum confirmation');}
 else if(shortTrend&&bear&&r<=50&&r>=28){action='SHORT';reasons.push('1h/4h EMA20<50<200 alignment','5m EMA20/50 pullback rejection','bearish rejection and breakdown candle','RSI and ADX momentum confirmation');}
 else return wait(entry,['No qualified multi-timeframe pullback setup']);
 if(!vOk)return wait(entry,['Volume confirmation failed']);
 const swingLow=Math.min(...bars.slice(-6,-1).map(b=>b.low)),swingHigh=Math.max(...bars.slice(-6,-1).map(b=>b.high)),buffer=a5*0.15;let risk=action==='LONG'?Math.max(entry-swingLow+buffer,a5*0.8):Math.max(swingHigh-entry+buffer,a5*0.8);risk=Math.min(risk,a5*2.5);if(!Number.isFinite(risk)||risk<=0)return wait(entry,['Invalid structural stop']);
 const stop=action==='LONG'?entry-risk:entry+risk,tp=action==='LONG'?entry+risk*2:entry-risk*2,score=Math.min(100,80+(aDx>=30?5:0)+(aDx1>=25?5:0)+5);
 if(score<minScore)return wait(entry,['Conviction score below threshold']);
 return{action,family:'TrendPullback',strategy:'Trend Pullback v39',entry,stopLoss:stop,takeProfit:tp,riskReward:2,score,targets:[{r:2,fraction:1,price:tp,moveStopToBreakeven:false}],finalTargetR:2,reasons};
}
export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV39{return evaluateV39(input,{...config,minRiskReward:2,minScore:config.minScore??82});}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV39{return evaluateProductionStrategy(input,config);}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV39{return evaluateProductionStrategy(input,config);}
