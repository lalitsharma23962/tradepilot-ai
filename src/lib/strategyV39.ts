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

function ema(values: number[], period: number): number {
  if (values.length < period) return Number.NaN;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function atr(bars: MarketBar[], period: number): number {
  if (bars.length <= period) return Number.NaN;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) { const c = bars[i], p = bars[i - 1]; tr.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close))); }
  return tr.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function adx(bars: MarketBar[], period = 14): number {
  if (bars.length < period * 2 + 1) return Number.NaN;
  const dx: number[] = [];
  for (let i = period; i < bars.length; i++) {
    let trSum=0, plus=0, minus=0;
    for (let j=i-period+1;j<=i;j++) {
      const c=bars[j],p=bars[j-1]; const tr=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));
      const up=c.high-p.high, down=p.low-c.low;
      trSum+=tr; if(up>down&&up>0) plus+=up; else if(down>up&&down>0) minus+=down;
    }
    const pdi=trSum?100*plus/trSum:0, mdi=trSum?100*minus/trSum:0;
    dx.push(pdi+mdi===0?0:100*Math.abs(pdi-mdi)/(pdi+mdi));
  }
  return dx.slice(-period).reduce((a,b)=>a+b,0)/Math.min(period,dx.length);
}
function rsi(bars: MarketBar[], period=14): number {
  if (bars.length <= period) return Number.NaN;
  let gains=0, losses=0;
  for(let i=bars.length-period;i<bars.length;i++){const d=bars[i].close-bars[i-1].close;if(d>0)gains+=d;else losses-=d;}
  if(losses===0)return 100; const rs=(gains/period)/(losses/period); return 100-100/(1+rs);
}
function aggregate(bars: MarketBar[], size: number): MarketBar[] {
  const out: MarketBar[]=[];
  for(let i=0;i+size<=bars.length;i+=size){const g=bars.slice(i,i+size);out.push({openTime:g[0].openTime,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[g.length-1].close,volume:g.reduce((s,x)=>s+x.volume,0)});}
  return out;
}
function wait(entry=0,reasons:string[]): StrategySignalV39 { return {action:'WAIT',family:'TrendPullback',strategy:'Trend Pullback v39',entry,stopLoss:0,takeProfit:0,riskReward:0,score:0,targets:[],finalTargetR:0,reasons}; }

export function evaluateV39(input: number[] | MarketBar[], config: Partial<StrategyConfig> = {}): StrategySignalV39 {
  const atrPeriod=config.atrPeriod??14, stopMult=config.atrMultStop??1.5, minRR=config.minRiskReward??2, minScore=config.minScore??80;
  let bars: MarketBar[]=[];
  if(Array.isArray(input)&&input.length){bars=typeof input[0]==='number'?(input as number[]).map((v,i)=>({openTime:i,open:v,high:v,low:v,close:v,volume:0})):input as MarketBar[];}
  if(bars.length<240)return wait(0,['Insufficient 5m history for multi-timeframe regime analysis']);
  const h1=config.htf1h??aggregate(bars,12), h4=config.htf4h??aggregate(bars,48);
  if(h1.length<210||h4.length<210)return wait(bars[bars.length-1].close,['Insufficient completed 1h/4h history for EMA 200 confirmation']);
  const closes5=bars.map(b=>b.close), closes1=h1.map(b=>b.close), closes4=h4.map(b=>b.close);
  const e20_1=ema(closes1,20),e50_1=ema(closes1,50),e200_1=ema(closes1,200),e20_4=ema(closes4,20),e50_4=ema(closes4,50),e200_4=ema(closes4,200);
  const a5=atr(bars,atrPeriod), adx5=adx(bars,14), adx1=adx(h1,14), rsi5=rsi(bars,14);
  const e20=ema(closes5,20),e50=ema(closes5,50),entry=bars[bars.length-1].close,last=bars[bars.length-1],prev=bars[bars.length-2];
  if(![a5,e20,e50,e20_1,e50_1,e200_1,e20_4,e50_4,e200_4,adx5,adx1,rsi5].every(Number.isFinite))return wait(entry,['Indicator warm-up incomplete']);
  const longTrend=closes1.at(-1)!>e20_1&&e20_1>e50_1&&e50_1>e200_1&&closes4.at(-1)!>e20_4&&e20_4>e50_4&&e50_4>e200_4;
  const shortTrend=closes1.at(-1)!<e20_1&&e20_1<e50_1&&e50_1<e200_1&&closes4.at(-1)!<e20_4&&e20_4<e50_4&&e50_4<e200_4;
  if(adx5<25||adx1<20)return wait(entry,['Sideways/weak regime rejected: ADX below trend-strength threshold']);
  const bullReject=prev.low<=e50&&last.close>e20&&last.close>last.open&&last.close>prev.high;
  const bearReject=prev.high>=e50&&last.close<e20&&last.close<last.open&&last.close<prev.low;
  const volumeAvg=bars.slice(-21,-1).reduce((s,b)=>s+b.volume,0)/20;
  const volumeOk=volumeAvg<=0||last.volume>=volumeAvg*1.15;
  let action:'LONG'|'SHORT'|'WAIT'='WAIT'; const reasons:string[]=[];
  if(longTrend&&bullReject&&rsi5>=50&&rsi5<=72){action='LONG';reasons.push('1h/4h EMA trend aligned','5m EMA20/50 pullback reclaimed','bullish rejection/expansion candle','RSI and ADX confirm momentum');}
  else if(shortTrend&&bearReject&&rsi5<=50&&rsi5>=28){action='SHORT';reasons.push('1h/4h EMA trend aligned','5m EMA20/50 pullback rejected','bearish rejection/expansion candle','RSI and ADX confirm momentum');}
  else return wait(entry,['No qualified multi-timeframe pullback setup']);
  const stopBuffer=a5*0.15;
  const swingLow=Math.min(...bars.slice(-6,-1).map(b=>b.low)),swingHigh=Math.max(...bars.slice(-6,-1).map(b=>b.high));
  let stopDistance=action==='LONG'?Math.max(entry-swingLow+stopBuffer,a5*0.8):Math.max(swingHigh-entry+stopBuffer,a5*0.8);
  stopDistance=Math.min(stopDistance,a5*2.5);
  if(stopDistance<=0||!Number.isFinite(stopDistance))return wait(entry,['Invalid structural stop']);
  const takeDistance=stopDistance*2;
  const stopLoss=action==='LONG'?entry-stopDistance:entry+stopDistance,takeProfit=action==='LONG'?entry+takeDistance:entry-takeDistance;
  const score=Math.min(100,80+(volumeOk?5:0)+(adx5>=30?5:0)+(adx1>=25?5:0)+(longTrend||shortTrend?5:0));
  if(!volumeOk||score<minScore)return wait(entry,['Setup failed conviction/volume threshold']);
  return {action,family:'TrendPullback',strategy:'Trend Pullback v39',entry,stopLoss,takeProfit,riskReward:2,score,targets:[{r:2,fraction:1,price:takeProfit,moveStopToBreakeven:false}],finalTargetR:2,reasons};
}
export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}){return evaluateV39(input,{...config,minRiskReward:2,minScore:config.minScore??80});}
export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}){return evaluateProductionStrategy(input,config);}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}){return evaluateProductionStrategy(input,config);}
