import { fetchHistoricalCandles, newFunnelCounters, type Candle, type BacktestConfig, type StrategyResult, type ValidationReport, type ValidationGate, type FoldDiagnostic, type FunnelCounters, type FamilyPerformance } from './backtestV6';
export type { BacktestConfig, StrategyResult, ValidationReport, ValidationGate, FoldDiagnostic, FunnelCounters, FamilyPerformance } from './backtestV6';
import { evaluateProductionStrategy } from './strategy';
import { MIN_INDEPENDENT_SAMPLES } from './strategyV35';
import { TRADING_CONFIG } from './tradingConfig';
import { runnerProtectedStop } from './runnerProtection';
import { calculatePositionSize } from '../engine/risk';
import { DEFAULT_TARGETS } from '../engine/targets';

const MAX_HISTORY_BARS=100000,PRE_OOS=TRADING_CONFIG.preOosFraction,FOLDS=TRADING_CONFIG.folds,LOOKBACK=TRADING_CONFIG.lookback,MIN_FOLD_TRADES=10,MIN_TEST_TRADES=TRADING_CONFIG.minTestTrades,MIN_PF=TRADING_CONFIG.minProfitFactor,MAX_DD=TRADING_CONFIG.maxDrawdownPct,MAX_MC_LOSS=TRADING_CONFIG.maxMonteCarloLossProbability,MIN_SCORE=TRADING_CONFIG.minScore;
const HISTORY_TARGET:Record<string,number>={'5m':100000,'15m':100000,'30m':80000,'45m':60000,'1h':50000,'2h':40000,'3h':30000,'4h':25000,'1d':2500};
const intervalMs=(interval:string)=>{const m=interval.match(/^(\d+)([mhd])$/i);if(!m)throw new Error(`Unsupported interval: ${interval}`);const n=Number(m[1]),u=m[2].toLowerCase();return n*(u==='m'?60000:u==='h'?3600000:86400000);};
const mean=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function summarize(id:string,returns:number[],initial:number):StrategyResult{const wins=returns.filter(x=>x>0),losses=returns.filter(x=>x<0),gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0)),pf=gl?gp/gl:0;let equity=initial,peak=initial,dd=0;for(const r of returns){equity*=1+r/100;peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak*100);}const ret=(equity/initial-1)*100,wr=returns.length?wins.length/returns.length*100:0,avg=mean(returns),variance=mean(returns.map(x=>(x-avg)**2)),sh=returns.length?Math.sqrt(returns.length)*avg/(Math.sqrt(variance)||1):0;return{id,name:'Production Regime Breakout v38',trades:returns.length,wins:wins.length,losses:losses.length,winRate:wr,profitFactor:pf,netPnl:equity-initial,returnPct:ret,maxDrawdownPct:dd,avgTrade:avg,score:(ret+Math.min(pf,5)*2.5+sh*2+wr/25-dd*.8)*Math.min(1,returns.length/30),tradeReturnsPct:returns,sharpe:sh,sortino:sh,calmar:dd?ret/dd:0,expectancy:avg,turnoverPct:returns.reduce((a,b)=>a+Math.abs(b),0)};}
function summarizeFamily(returns:number[]):FamilyPerformance{const wins=returns.filter(x=>x>0),losses=returns.filter(x=>x<0),gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0)),pf=gl?gp/gl:(gp>0?Infinity:0);return{trades:returns.length,wins:wins.length,winRate:returns.length?wins.length/returns.length*100:0,profitFactor:Number.isFinite(pf)?pf:0,returnPct:returns.reduce((a,b)=>a+b,0),avgTrade:mean(returns)};}
function monte(returns:number[],runs=TRADING_CONFIG.monteCarloRuns){if(!returns.length)return{simulations:runs,probabilityOfLoss:100,medianReturnPct:0,p05ReturnPct:0,p95MaxDrawdownPct:0};let seed=0x7a11>>>0;const rnd=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};const finals:number[]=[],dds:number[]=[];for(let k=0;k<runs;k++){let e=1,p=1,d=0;for(let i=0;i<returns.length;i++){e*=1+returns[Math.floor(rnd()*returns.length)]/100;p=Math.max(p,e);d=Math.max(d,(p-e)/p*100);}finals.push((e-1)*100);dds.push(d);}finals.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);return{simulations:runs,probabilityOfLoss:finals.filter(x=>x<0).length/runs*100,medianReturnPct:finals[Math.floor(runs*.5)]??0,p05ReturnPct:finals[Math.floor(runs*.05)]??0,p95MaxDrawdownPct:dds[Math.floor(runs*.95)]??0};}
interface FamilyTaggedReturn{pct:number;family:string;}
interface OpenTrade{side:1|-1;entry:number;stop:number;risk:number;initialQty:number;remainingQty:number;bars:number;family:string;targetIndex:number;realizedPnl:number;realizedFees:number;}

function simulate(c:Candle[],cfg:BacktestConfig,start:number,end:number,funnel?:FunnelCounters,familyReturns?:FamilyTaggedReturn[]):StrategyResult{
 let equity=cfg.initialCapital;const returns:number[]=[];let open:OpenTrade|null=null;const fee=cfg.feeBps/10000,slip=cfg.slippageBps/10000;
 const record=(pnl:number,family:string)=>{const pct=equity?100*pnl/equity:0;returns.push(pct);familyReturns?.push({pct,family});equity+=pnl;};
 const finishTrade=(trade:OpenTrade,bar:Candle,rawExit:number)=>{const exit=rawExit*(1-trade.side*slip),gross=trade.side*(exit-trade.entry)*trade.remainingQty,fees=(Math.abs(trade.entry*trade.remainingQty)+Math.abs(exit*trade.remainingQty))*fee;record(trade.realizedPnl+gross-(trade.realizedFees+fees),trade.family);if(funnel)funnel.tradesClosed++;open=null;};
 for(let i=Math.max(start,Math.min(LOOKBACK,220));i<end;i++){
  const b=c[i],hist=c.slice(Math.max(0,i-((MIN_INDEPENDENT_SAMPLES*(cfg.maxBarsInTrade||240)+(cfg.maxBarsInTrade||240)+64))),i+1);let closed=false;
  if(open){
   open.bars++;
   const stopHit=open.side===1?b.low<=open.stop:b.high>=open.stop;
   if(stopHit){finishTrade(open,b,open.stop);closed=true;}
   else{
    while(open&&open.targetIndex<DEFAULT_TARGETS.length){const tier=DEFAULT_TARGETS[open.targetIndex],target=open.entry+open.side*open.risk*tier.multipleR,hit=open.side===1?b.high>=target:b.low<=target;if(!hit)break;
      const exitQty=open.targetIndex===DEFAULT_TARGETS.length-1?open.remainingQty:Math.min(open.remainingQty,open.initialQty*tier.allocationPct),exit=target*(1-open.side*slip),gross=open.side*(exit-open.entry)*exitQty,fees=(Math.abs(open.entry*exitQty)+Math.abs(exit*exitQty))*fee;open.realizedPnl+=gross;open.realizedFees+=fees;open.remainingQty-=exitQty;open.targetIndex++;
      if(open.targetIndex===1)open.stop=open.entry;
      else if(open.targetIndex===2)open.stop=open.entry+open.side*open.risk*0.5;
      if(open.remainingQty<=Math.max(open.initialQty*1e-9,1e-12)){record(open.realizedPnl-open.realizedFees,open.family);if(funnel)funnel.tradesClosed++;open=null;closed=true;break;}
    }
    if(open){open.stop=runnerProtectedStop(open.side,open.entry,open.entry+open.side*open.risk*2,open.stop,b.high,b.low);if(open.bars>=cfg.maxBarsInTrade){finishTrade(open,b,b.close);closed=true;}}
   }
  }
  if(!open&&!closed&&i<end-1){
   const signal=evaluateProductionStrategy(hist,{minScore:MIN_SCORE,minRiskReward:TRADING_CONFIG.productionMinRiskReward,maxRiskReward:TRADING_CONFIG.productionMaxRiskReward,lookback:LOOKBACK,feeBps:cfg.feeBps,slippageBps:cfg.slippageBps,minStopAtr:TRADING_CONFIG.minStopAtr,maxStructuralRiskAtr:TRADING_CONFIG.maxStructuralRiskAtr,maxCostFractionOfRisk:0.15,swingLookback:TRADING_CONFIG.swingLookback,capacityHorizonBars:cfg.maxBarsInTrade,capacityBars:hist,funnel} as any);
   if(signal.action!=='WAIT'){
    if(funnel)funnel.ordersAttempted++;
    const fill=c[i+1],side=signal.action==='LONG'?1:-1,entry=fill.open*(1+side*slip),risk=Math.abs(signal.entry-signal.stopLoss),stop=entry-side*risk;
    const sizing=calculatePositionSize({accountEquity:Math.max(equity,0),riskPct:cfg.riskPerTradePct/100,entryPrice:entry,stopLossPrice:stop,maxPositionPct:Math.max(0,cfg.maxPositionPct/100),maxLeverage:Math.max(0,Math.min(cfg.leverage,TRADING_CONFIG.maxLeverage))});
    const q=sizing.finalQuantity,notional=sizing.effectiveNotional;
    if(q>0&&Number.isFinite(risk)&&risk>0&&Number.isFinite(entry)&&notional>=TRADING_CONFIG.minNotionalUsd){open={side,entry,stop,risk,initialQty:q,remainingQty:q,bars:0,family:signal.family,targetIndex:0,realizedPnl:0,realizedFees:0};if(funnel)funnel.tradesOpened++;}
   }
  }
 }
 if(open&&end>Math.max(start,LOOKBACK))finishTrade(open,c[end-1],c[end-1].close);
 return summarize('production',returns,cfg.initialCapital);
}
function foldPass(f:StrategyResult){return f.trades>=MIN_FOLD_TRADES&&f.returnPct>0&&f.profitFactor>=MIN_PF&&f.maxDrawdownPct<=MAX_DD;}
export async function runValidation(symbol='BTCUSDT',interval='5m',cfg:Partial<BacktestConfig>={},_selectedStrategyId?:string):Promise<ValidationReport>{
 const historyTarget=HISTORY_TARGET[interval]??50000,horizon=TRADING_CONFIG.maxBarsInTrade[interval]??240,config={initialCapital:TRADING_CONFIG.paperStartingCapital,feeBps:TRADING_CONFIG.feeBps,slippageBps:TRADING_CONFIG.slippageBps,riskPerTradePct:TRADING_CONFIG.riskPerTradePct,maxPositionPct:TRADING_CONFIG.maxAllocationPct,leverage:TRADING_CONFIG.maxLeverage,stopAtr:TRADING_CONFIG.atrStopMultiple,maxBarsInTrade:horizon,...cfg};
 // Causal capacity requires 20 non-overlapping episodes plus one horizon and indicator/HTF buffer; avoid the old oversized LOOKBACK+300 reserve.
 const capacityContext=Math.max(220,MIN_INDEPENDENT_SAMPLES*horizon+horizon+32),fetched=await fetchHistoricalCandles(symbol,interval,historyTarget);if(fetched.length<historyTarget)throw new Error(`Need ${historyTarget.toLocaleString()} completed ${interval} candles; received ${fetched.length.toLocaleString()}.`);const candles=fetched.slice(-historyTarget),n=candles.length;
 if(n<=capacityContext+FOLDS*MIN_FOLD_TRADES)throw new Error(`Need more history for v38 validation: ${capacityContext.toLocaleString()} candles are reserved for causal capacity context.`);
 const preStart=capacityContext,scoredBars=n-preStart,preBars=Math.floor(scoredBars*PRE_OOS),preEnd=preStart+preBars,foldSize=Math.floor(preBars/FOLDS),funnel=newFunnelCounters(),familyReturns:FamilyTaggedReturn[]=[],foldDiagnostics:Record<string,FoldDiagnostic[]>={production:[]},folds:StrategyResult[]=[];
 for(let k=0;k<FOLDS;k++){const a=preStart+k*foldSize,b=k===FOLDS-1?preEnd:a+foldSize,r=simulate(candles,config,a,b,funnel,familyReturns);folds.push(r);foldDiagnostics.production.push({fold:k+1,startBar:a,endBar:b,trades:r.trades,winRate:r.winRate,profitFactor:r.profitFactor,returnPct:r.returnPct,maxDrawdownPct:r.maxDrawdownPct,passesTrades:r.trades>=MIN_FOLD_TRADES,passesReturn:r.returnPct>0,passesProfitFactor:r.profitFactor>=MIN_PF,passesDrawdown:r.maxDrawdownPct<=MAX_DD,passed:foldPass(r)});}
 const allThree=folds.every(foldPass),preReturns=folds.flatMap(x=>x.tradeReturnsPct),validation=summarize('production',preReturns,config.initialCapital),test=allThree?simulate(candles,config,preEnd,n,funnel,familyReturns):null,mc=test?monte(test.tradeReturnsPct):monte([]),reasons:string[]=[];
 const insufficientOos=!test||test.trades<MIN_TEST_TRADES||folds.some(f=>f.trades<MIN_FOLD_TRADES);
 if(insufficientOos)reasons.push(`INSUFFICIENT_DATA: OOS sample requires at least ${MIN_TEST_TRADES} total trades and ${MIN_FOLD_TRADES} trades in every walk-forward fold.`);
 if(!allThree&&!insufficientOos){const passed=folds.filter(foldPass).length;reasons.push(`Production Regime Breakout v38 did not pass all ${FOLDS} pre-OOS stability folds (${passed}/${FOLDS} passed). ${folds.map((f,i)=>`fold ${i+1}: ${f.trades} trades, PF ${f.profitFactor.toFixed(2)}, return ${f.returnPct.toFixed(2)}%, DD ${f.maxDrawdownPct.toFixed(2)}%`).join(' | ')}`);}
 if(test&&test.profitFactor<MIN_PF)reasons.push(`OOS PF ${test.profitFactor.toFixed(2)} < ${MIN_PF}.`);if(test&&test.returnPct<=0)reasons.push(`OOS return ${test.returnPct.toFixed(2)}% is not positive.`);if(test&&test.maxDrawdownPct>MAX_DD)reasons.push(`OOS drawdown ${test.maxDrawdownPct.toFixed(2)}% > ${MAX_DD}%.`);if(test&&mc.probabilityOfLoss>MAX_MC_LOSS)reasons.push(`Monte Carlo loss probability ${mc.probabilityOfLoss.toFixed(1)}% > ${MAX_MC_LOSS}%.`);
 const gate:ValidationGate={status:insufficientOos?'INSUFFICIENT_DATA':reasons.length?'REJECTED':'VALIDATED',reasons,minimumTestTrades:MIN_TEST_TRADES,minimumProfitFactor:MIN_PF,minimumTestReturnPct:0,maximumTestDrawdownPct:MAX_DD,maximumMonteCarloLossProbability:MAX_MC_LOSS};
 const familyPerformance:Record<string,FamilyPerformance>={};for(const fam of ['trend','breakout','retest','compression','reversion'])familyPerformance[fam]=summarizeFamily(familyReturns.filter(x=>x.family===fam).map(x=>x.pct));const step=intervalMs(interval);
 return{symbol,interval,candles:n,dataQuality:{startTime:candles[0].openTime,endTime:candles.at(-1)!.openTime,durationDays:(candles.at(-1)!.openTime-candles[0].openTime)/864e5,expectedIntervalMinutes:step/60000,gaps:candles.slice(1).filter((x,i)=>x.openTime-candles[i].openTime!==step).length,duplicateTimestamps:n-new Set(candles.map(x=>x.openTime)).size},costs:{feeBps:config.feeBps,slippageBps:config.slippageBps,roundTripPct:2*(config.feeBps+config.slippageBps)/10000},strategies:[validation],walkForward:{trainBars:foldSize,validationBars:foldSize,testBars:n-preEnd,selectedStrategy:!insufficientOos&&allThree?'Production Regime Breakout v38':'No eligible strategy',validation:allThree?validation:null,test},foldDiagnostics,monteCarlo:mc,gate,generatedAt:new Date().toISOString(),research:{asOf:new Date().toISOString(),dataWindowBars:n,selectionMethod:`v38 fixed 2R final target with 1R/1.5R/2R partial exits; friction gate is measured in R-units; signals fill on the next candle open; position sizing is risk-budget constrained with explicit notional/leverage limits; capacity uses ${MIN_INDEPENDENT_SAMPLES} non-overlapping causal episodes; untouched 30% OOS.`,coverage:['EMA20/50/100 trend evidence','fresh breakout','compression expansion','range RSI/Bollinger reversal','completed-hour confirmation when available','real OHLC ATR','cost in R-units <= 0.15R','next-open execution','1R/1.5R/2R partial ladder','TP1 breakeven','risk/notional/leverage sizing','strict fold and OOS sample gates','5,000-run Monte Carlo']},signalFunnel:funnel,familyPerformance};
}
