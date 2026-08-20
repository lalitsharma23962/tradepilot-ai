import type { MarketBar } from './marketData';
import type { StrategyConfig, StrategySignal } from './strategyV32';
import { evaluateProductionStrategy as evaluateV32 } from './strategyV32';
import { FINAL_TARGET_R, TARGET_LADDER } from './targetLadder';
import { TRADING_CONFIG } from './tradingConfig';

export type { StrategyConfig, StrategySignal } from './strategyV32';

/**
 * v39: selective BTCUSDT 5m trend-pullback selector.
 *
 * The base v32 engine supplies chronological-safe structural stops, hourly
 * regime context and multi-horizon momentum. v39 adds a second, independent
 * entry-quality gate: hourly confirmation, ADX trend strength, a genuine
 * pullback to EMA50/VWAP, rejection-candle confirmation, volume confirmation,
 * acceptable cost/risk economics and measured path capacity for a 10R runner.
 * No filter is relaxed to manufacture trades.
 */
export type StrategySignalV39 = StrategySignal & {
  targets?: Array<{ r:number; fraction:number; price:number; moveStopToBreakeven?:boolean }>;
  finalTargetR?: number;
};

const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const atr=(bars:MarketBar[],p:number)=>{const s=bars.slice(-(p+1));return mean(s.slice(1).map((b,i)=>Math.max(b.high-b.low,Math.abs(b.high-s[i].close),Math.abs(b.low-s[i].close))));};
const efficiency=(x:number[])=>{if(x.length<3)return 0;const net=Math.abs(x.at(-1)!-x[0]);const path=x.slice(1).reduce((s,v,i)=>s+Math.abs(v-x[i]),0);return path?net/path:0;};
const vwap=(bars:MarketBar[])=>{let pv=0,v=0;for(const b of bars){const typical=(b.high+b.low+b.close)/3;const vol=Number.isFinite(b.volume)&&b.volume>0?b.volume:1;pv+=typical*vol;v+=vol;}return v?pv/v:bars.at(-1)?.close??0;};

function adx(bars:MarketBar[],period=14){
  if(bars.length<period*3)return 0;
  const tr:number[]=[],plus:number[]=[],minus:number[]=[];
  for(let i=1;i<bars.length;i++){
    const b=bars[i],p=bars[i-1];
    tr.push(Math.max(b.high-b.low,Math.abs(b.high-p.close),Math.abs(b.low-p.close)));
    const up=b.high-p.high,down=p.low-b.low;
    plus.push(up>down&&up>0?up:0);
    minus.push(down>up&&down>0?down:0);
  }
  const dx:number[]=[];
  for(let i=period;i<tr.length;i++){
    const atrN=mean(tr.slice(i-period+1,i+1));
    if(!(atrN>0))continue;
    const pdi=100*mean(plus.slice(i-period+1,i+1))/atrN;
    const mdi=100*mean(minus.slice(i-period+1,i+1))/atrN;
    const sum=pdi+mdi;dx.push(sum>0?100*Math.abs(pdi-mdi)/sum:0);
  }
  return mean(dx.slice(-period));
}

const wait=(signal:StrategySignal,reasons:string[]):StrategySignalV39=>({
  ...signal,action:'WAIT',strategy:'No Trade',stopLoss:signal.entry,takeProfit:signal.entry,riskReward:0,family:'none',reasons:[...signal.reasons,...reasons]
});

function normalize(signal:StrategySignal):StrategySignalV39{
  if(signal.action==='WAIT')return signal;
  const side=signal.action==='LONG'?1:-1;
  const risk=Math.abs(signal.entry-signal.stopLoss);
  if(!(risk>0)||!Number.isFinite(risk))return wait(signal,['v39 rejected invalid structural risk']);
  const targets=TARGET_LADDER.map(level=>({r:level.r,fraction:level.fraction,price:signal.entry+side*risk*level.r,moveStopToBreakeven:level.moveStopToBreakeven}));
  return {
    ...signal,
    strategy:'Trend Pullback v39',
    takeProfit:signal.entry+side*risk*FINAL_TARGET_R,
    riskReward:FINAL_TARGET_R,
    targets,
    finalTargetR:FINAL_TARGET_R,
    reasons:[...signal.reasons,'v39: hourly trend + ADX + structural pullback + rejection + volume','Asymmetric 3R/5R/10R ladder','10R runner allowed only when measured path capacity supports it','Validation remains the profitability gate']
  };
}

export function evaluateProductionStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV39{
  const bars=(typeof input[0]==='number'?[]:input as MarketBar[]).filter(b=>Number.isFinite(b.close)&&b.close>0);
  const baseCfg={
    ...config,
    minScore:Math.max(TRADING_CONFIG.minScore,config.minScore??TRADING_CONFIG.minScore),
    minRiskReward:FINAL_TARGET_R,
    maxRiskReward:FINAL_TARGET_R,
    riskReward:FINAL_TARGET_R,
    skipLegacyPathCapacity:true,
    maxStructuralRiskAtr:TRADING_CONFIG.maxStructuralRiskAtr,
    minStopAtr:TRADING_CONFIG.minStopAtr,
    maxCostFractionOfRisk:TRADING_CONFIG.maxCostFractionOfRisk,
  };
  const signal=evaluateV32(input,baseCfg);
  if(signal.action==='WAIT')return signal;
  if(signal.family!=='trend')return wait(signal,['v39 rejected non-trend family']);
  if(bars.length<250)return wait(signal,['v39 requires at least 250 completed 5m bars']);

  const side=signal.action==='LONG'?1:-1;
  const entry=signal.entry;
  const a14=atr(bars,14),a48=atr(bars,48),atrRatio=a48>0?a14/a48:0;
  const adx14=adx(bars,14);
  const p=bars.map(b=>b.close),e20=ema(p,20),e50=ema(p,50),sessionVwap=vwap(bars.slice(-288));
  const recent=bars.slice(-13,-1),recentEmaTouch=recent.some(b=>b.low<=e50+a14*.25&&b.high>=e50-a14*.25);
  const recentVwapTouch=recent.some(b=>b.low<=sessionVwap+a14*.20&&b.high>=sessionVwap-a14*.20);
  const pullback=recentEmaTouch||recentVwapTouch;
  const last=bars.at(-1)!,prev=bars.at(-2)!;
  const range=Math.max(last.high-last.low,entry*1e-8),body=Math.abs(last.close-last.open)/range;
  const closeLocLong=(last.close-last.low)/range,closeLocShort=(last.high-last.close)/range;
  const rejection=side===1
    ? last.close>last.open&&last.close>=prev.close&&body>=.35&&closeLocLong>=.65
    : last.close<last.open&&last.close<=prev.close&&body>=.35&&closeLocShort>=.65;
  const vols=bars.slice(-21,-1).map(b=>b.volume).filter(v=>Number.isFinite(v)&&v>0),avgVol=mean(vols),volRatio=avgVol>0?last.volume/avgVol:1;
  const volumeConfirmed=avgVol<=0||volRatio>=1.05;
  const momentumEfficiency=efficiency(p.slice(-24));
  const distanceToEma20=Math.abs(entry-e20)/Math.max(a14,entry*1e-8);
  const cost=2*((config.feeBps??TRADING_CONFIG.feeBps)+(config.slippageBps??TRADING_CONFIG.slippageBps))/10000;
  const costFraction=entry*cost/Math.max(Math.abs(entry-signal.stopLoss),1e-12);
  const hourlyConfirmed=signal.reasons.some(r=>r==='Completed-hour confirmation');
  const pathRequired=FINAL_TARGET_R*Math.abs(entry-signal.stopLoss);

  if(!hourlyConfirmed)return wait(signal,['v39 rejected: no completed 1h trend confirmation']);
  if(adx14<22)return wait(signal,[`v39 rejected: 5m ADX ${adx14.toFixed(1)} < 22 trend-strength floor`]);
  if(!pullback)return wait(signal,['v39 rejected: no recent EMA50/VWAP pullback']);
  if(!rejection)return wait(signal,['v39 rejected: no decisive pullback rejection candle']);
  if(!volumeConfirmed)return wait(signal,[`v39 rejected: volume ratio ${volRatio.toFixed(2)} < 1.05`]);
  if(atrRatio<.90)return wait(signal,[`v39 rejected: ATR regime is contracting (${atrRatio.toFixed(2)}x)`]);
  if(momentumEfficiency<.14)return wait(signal,[`v39 rejected: directional efficiency ${momentumEfficiency.toFixed(2)} < 0.14`]);
  if(distanceToEma20>1.0)return wait(signal,['v39 rejected: entry is too extended from EMA20']);
  if(costFraction>TRADING_CONFIG.maxCostFractionOfRisk)return wait(signal,[`v39 rejected: round-trip cost is ${(costFraction*100).toFixed(0)}% of 1R`]);
  if(signal.score<88)return wait(signal,[`v39 rejected: conviction score ${signal.score} < 88`]);
  if(!(signal.pathCapacity>=pathRequired))return wait(signal,[`v39 rejected: measured path capacity ${(signal.pathCapacity/Math.max(Math.abs(entry-signal.stopLoss),1e-12)).toFixed(1)}R < ${FINAL_TARGET_R}R target`]);

  return normalize(signal);
}

export function evaluateResearchStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV39{return evaluateProductionStrategy(input,config);}
export function evaluateStrategy(input:number[]|MarketBar[],config:Partial<StrategyConfig>={}):StrategySignalV39{return evaluateProductionStrategy(input,config);}
