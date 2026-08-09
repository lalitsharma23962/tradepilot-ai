import { fetchHistoricalCandles, newFunnelCounters, type Candle, type BacktestConfig, type StrategyResult, type ValidationReport, type ValidationGate, type FoldDiagnostic, type FunnelCounters, type FamilyPerformance } from './backtestV6';
export type { BacktestConfig, StrategyResult, ValidationReport, ValidationGate, FoldDiagnostic, FunnelCounters, FamilyPerformance } from './backtestV6';
import { evaluateProductionStrategy } from './strategy';
import { TRADING_CONFIG } from './tradingConfig';
import { runnerProtectedStop } from './runnerProtection';

const MAX_HISTORY_BARS=100000,PRE_OOS=TRADING_CONFIG.preOosFraction,FOLDS=TRADING_CONFIG.folds,LOOKBACK=TRADING_CONFIG.lookback,MIN_FOLD_TRADES=TRADING_CONFIG.minFoldTrades,MIN_TEST_TRADES=TRADING_CONFIG.minTestTrades,MIN_PF=TRADING_CONFIG.minProfitFactor,MAX_DD=TRADING_CONFIG.maxDrawdownPct,MAX_MC_LOSS=TRADING_CONFIG.maxMonteCarloLossProbability,MIN_SCORE=TRADING_CONFIG.minScore;
const MAX_CAPACITY_HORIZON=Math.max(...Object.values(TRADING_CONFIG.maxBarsInTrade));
const CAPACITY_CONTEXT=LOOKBACK+MAX_CAPACITY_HORIZON+260;
const mean=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function summarize(id:string,returns:number[],initial:number):StrategyResult{const wins=returns.filter(x=>x>0),losses=returns.filter(x=>x<0),gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0)),pf=gl?gp/gl:0;let equity=initial,peak=initial,dd=0;for(const r of returns){equity*=1+r/100;peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak*100);}const ret=(equity/initial-1)*100,wr=returns.length?wins.length/returns.length*100:0,avg=mean(returns),sh=returns.length?Math.sqrt(returns.length)*avg/(Math.sqrt(mean(returns.map(x=>(x-avg)**2)))||1):0;return{id,name:'Production Regime Breakout v35',trades:returns.length,wins:wins.length,losses:losses.length,winRate:wr,profitFactor:pf,netPnl:equity-initial,returnPct:ret,maxDrawdownPct:dd,avgTrade:avg,score:(ret+Math.min(pf,5)*2.5+sh*2+wr/25-dd*.8)*Math.min(1,returns.length/30),tradeReturnsPct:returns,sharpe:sh,sortino:sh,calmar:dd?ret/dd:0,expectancy:avg,turnoverPct:returns.reduce((a,b)=>a+Math.abs(b),0)};}
function summarizeFamily(returns:number[]):FamilyPerformance{const wins=returns.filter(x=>x>0),losses=returns.filter(x=>x<0),gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0)),pf=gl?gp/gl:(gp>0?Infinity:0);return{trades:returns.length,wins:wins.length,winRate:returns.length?wins.length/returns.length*100:0,profitFactor:Number.isFinite(pf)?pf:0,returnPct:returns.reduce((a,b)=>a+b,0),avgTrade:mean(returns)};}
const cloneFunnel=():FunnelCounters=>newFunnelCounters();

interface FamilyTaggedReturn{pct:number;family:string;}

function simulate(c:Candle[],cfg:BacktestConfig,start:number,end:number,funnel?:FunnelCounters,familyReturns?:FamilyTaggedReturn[]):StrategyResult{
 let equity=cfg.initialCapital;const returns:number[]=[];let open:null|{side:1|-1;entry:number;stop:number;target:number;qty:number;bars:number;family:string}=null;const fee=cfg.feeBps/10000,slip=cfg.slippageBps/10000;
 const record=(pnl:number,family:string)=>{const pct=equity?100*pnl/equity:0;returns.push(pct);familyReturns?.push({pct,family});equity+=pnl;};
 const closeOpen=(bar:Candle)=>{if(!open)return;const exit=bar.close*(1-open.side*slip),gross=open.side*(exit-open.entry)*open.qty,fees=(Math.abs(open.entry*open.qty)+Math.abs(exit*open.qty))*fee;record(gross-fees,open.family);open=null;};
 for(let i=Math.max(start,LOOKBACK);i<end;i++){
  const b=c[i],hist=c.slice(Math.max(0,i-CAPACITY_CONTEXT+1),i+1);let closed=false;
  if(open){
   open.bars++;
   const stop=open.side===1?b.low<=open.stop:b.high>=open.stop,tp=open.side===1?b.high>=open.target:b.low<=open.target,timeout=open.bars>=cfg.maxBarsInTrade;
   if(stop||tp||timeout){const raw=stop?open.stop:tp?open.target:b.close,exit=raw*(1-open.side*slip),gross=open.side*(exit-open.entry)*open.qty,fees=(Math.abs(open.entry*open.qty)+Math.abs(exit*open.qty))*fee;record(gross-fees,open.family);open=null;closed=true;}
   else open.stop=runnerProtectedStop(open.side,open.entry,open.target,open.stop,b.high,b.low);
  }
  if(!open&&!closed&&i<end-1){
   // IMPORTANT: pass the same funnel object through the strategy call. The
   // strategy owns the rejection counters; omitting this argument makes the
   // validation UI report zeros even while the exact same simulation opens
   // trades. This was the source of the 23-trades/0-bars contradiction.
   const signal=evaluateProductionStrategy(hist,{minScore:MIN_SCORE,minRiskReward:TRADING_CONFIG.researchMinRiskReward,maxRiskReward:TRADING_CONFIG.researchMaxRiskReward,lookback:LOOKBACK,feeBps:cfg.feeBps,slippageBps:cfg.slippageBps,maxStructuralRiskAtr:TRADING_CONFIG.maxStructuralRiskAtr,swingLookback:TRADING_CONFIG.swingLookback,capacityHorizonBars:cfg.maxBarsInTrade,capacityBars:hist,funnel} as any);
   if(signal.action!=='WAIT'){
    const side=signal.action==='LONG'?1:-1,entry=signal.entry*(1+side*slip),signalRisk=Math.abs(signal.entry-signal.stopLoss),rr=signal.riskReward,risk=signalRisk,stop=entry-side*risk,target=entry+side*risk*rr;
    const riskBudget=Math.max(equity,0)*cfg.riskPerTradePct/100,maxNotional=Math.max(equity,0)*cfg.maxPositionPct/100*Math.max(1,cfg.leverage),q=Math.min(riskBudget/Math.max(risk,entry*.0008),maxNotional/entry);
    if(q>0&&Number.isFinite(risk)&&risk>0&&Number.isFinite(rr)&&rr>0&&Number.isFinite(target)){open={side,entry,stop,target,qty:q,bars:0,family:signal.family};if(funnel)funnel.tradesOpened++;}
   }
  }
 }
 if(open&&end>Math.max(start,LOOKBACK))closeOpen(c[end-1]);
 return summarize('production',returns,cfg.initialCapital);
}
function foldPass(f:StrategyResult){return f.trades>=MIN_FOLD_TRADES&&f.returnPct>0&&f.profitFactor>=MIN_PF&&f.maxDrawdownPct<=MAX_DD;}
export async function runValidation(symbol='BTCUSDT',interval='5m',cfg:Partial<BacktestConfig>={},_selectedStrategyId?:string):Promise<ValidationReport>{
 const config={initialCapital:10000,feeBps:TRADING_CONFIG.feeBps,slippageBps:TRADING_CONFIG.slippageBps,riskPerTradePct:TRADING_CONFIG.riskPerTradePct,maxPositionPct:TRADING_CONFIG.maxAllocationPct,leverage:1,stopAtr:TRADING_CONFIG.atrStopMultiple,maxBarsInTrade:TRADING_CONFIG.maxBarsInTrade[interval]??240,...cfg};
 const fetched=await fetchHistoricalCandles(symbol,interval,MAX_HISTORY_BARS);if(fetched.length<MAX_HISTORY_BARS)throw new Error(`Need ${MAX_HISTORY_BARS.toLocaleString()} completed candles; received ${fetched.length.toLocaleString()}.`);
 const candles=fetched.slice(-MAX_HISTORY_BARS),n=candles.length,pre=Math.floor(n*PRE_OOS),foldSize=Math.floor(pre/FOLDS),funnel=newFunnelCounters(),familyReturns:FamilyTaggedReturn[]=[],foldDiagnostics:Record<string,FoldDiagnostic[]>={production:[]},folds:StrategyResult[]=[];
 for(let k=0;k<FOLDS;k++){const a=k*foldSize,b=(k+1)*foldSize,r=simulate(candles,config,a,b,funnel,familyReturns);folds.push(r);foldDiagnostics.production.push({fold:k+1,startBar:a,endBar:b,trades:r.trades,winRate:r.winRate,profitFactor:r.profitFactor,returnPct:r.returnPct,maxDrawdownPct:r.maxDrawdownPct,passesTrades:r.trades>=MIN_FOLD_TRADES,passesReturn:r.returnPct>0,passesProfitFactor:r.profitFactor>=MIN_PF,passesDrawdown:r.maxDrawdownPct<=MAX_DD,passed:foldPass(r)});}
 const allThree=folds.every(foldPass),preReturns=folds.flatMap(x=>x.tradeReturnsPct),validation=summarize('production',preReturns,config.initialCapital),test=allThree?simulate(candles,config,pre,n,funnel,familyReturns):null,mc=test?monte(test.tradeReturnsPct):monte([]),reasons:string[]=[];
 if(!allThree){const passed=folds.filter(foldPass).length;reasons.push(`Production Regime Breakout v35 did not pass all ${FOLDS} pre-OOS stability folds (${passed}/${FOLDS} passed). ${folds.map((f,i)=>`fold ${i+1}: ${f.trades} trades, PF ${f.profitFactor.toFixed(2)}, return ${f.returnPct.toFixed(2)}%, DD ${f.maxDrawdownPct.toFixed(2)}%`).join(' | ')}`);}
 if(test&&test.trades<MIN_TEST_TRADES)reasons.push(`OOS trades ${test.trades} < ${MIN_TEST_TRADES}.`);if(test&&test.profitFactor<MIN_PF)reasons.push(`OOS PF ${test.profitFactor.toFixed(2)} < ${MIN_PF}.`);if(test&&test.returnPct<=0)reasons.push(`OOS return ${test.returnPct.toFixed(2)}% is not positive.`);if(test&&test.maxDrawdownPct>MAX_DD)reasons.push(`OOS drawdown ${test.maxDrawdownPct.toFixed(2)}% > ${MAX_DD}%.`);if(test&&mc.probabilityOfLoss>MAX_MC_LOSS)reasons.push(`Monte Carlo loss probability ${mc.probabilityOfLoss.toFixed(1)}% > ${MAX_MC_LOSS}%.`);
 const step=interval==='1h'?3600000:interval==='4h'?14400000:interval==='15m'?900000:interval==='5m'?300000:60000;const gate:ValidationGate={status:reasons.length?'REJECTED':'VALIDATED',reasons,minimumTestTrades:MIN_TEST_TRADES,minimumProfitFactor:MIN_PF,minimumTestReturnPct:0,maximumTestDrawdownPct:MAX_DD,maximumMonteCarloLossProbability:MAX_MC_LOSS};
 const familyPerformance:Record<string,FamilyPerformance>={};for(const fam of ['trend','breakout','retest','compression','reversion'])familyPerformance[fam]=summarizeFamily(familyReturns.filter(x=>x.family===fam).map(x=>x.pct));
 return{symbol,interval,candles:n,dataQuality:{startTime:candles[0].openTime,endTime:candles.at(-1)!.openTime,durationDays:(candles.at(-1)!.openTime-candles[0].openTime)/864e5,expectedIntervalMinutes:step/60000,gaps:candles.slice(1).filter((x,i)=>x.openTime-candles[i].openTime!==step).length,duplicateTimestamps:n-new Set(candles.map(x=>x.openTime)).size},costs:{feeBps:config.feeBps,slippageBps:config.slippageBps,roundTripPct:2*(config.feeBps+config.slippageBps)/10000},strategies:[validation],walkForward:{trainBars:foldSize,validationBars:foldSize,testBars:n-pre,selectedStrategy:allThree?'Production Regime Breakout v35':'No eligible strategy',validation:allThree?validation:null,test},foldDiagnostics,monteCarlo:mc,gate,generatedAt:new Date().toISOString(),research:{asOf:new Date().toISOString(),dataWindowBars:n,selectionMethod:'A+ v35 uses the proven v32 entry/risk qualification at 1.5R-3R, then assigns 10R by default and 15R only for score >=99; runner protection uses the shared target-anchored monotonic stop ratchet in both validation and paper trading; three non-overlapping pre-OOS folds; untouched 30% OOS; realistic fees/slippage; no gate weakening or OOS tuning.',coverage:['EMA20 pullback/reclaim with decision-candle confirmation','fresh breakout','compression expansion','range RSI/Bollinger reversal','completed-hour confirmation when available','strong local-regime fallback for trend evidence','real OHLC ATR','shared structural stop ceiling','cost-aware position sizing','slippage-adjusted stop/target parity','entry qualification separated from 10R/15R target research','shared runner protection with monotonic stop ratchet','strict 3-fold stability gate','untouched 30% OOS','5,000-run Monte Carlo']},signalFunnel:funnel,familyPerformance};
}
