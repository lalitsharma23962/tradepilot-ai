import { fetchHistoricalCandles, type Candle, type BacktestConfig, type StrategyResult, type ValidationReport, type ValidationGate, type FoldDiagnostic } from './backtestV6';
import { evaluateProductionStrategy } from './strategy';
import { runValidation as runResearchValidation } from './backtestV8';

/** V15: strict production validation for the high-RR paper strategy. */
const MAX_HISTORY_BARS = 20000;
const PRE_OOS = 0.70;
const FOLDS = 3;
const LOOKBACK = 240;
const MIN_FOLD_TRADES = 12;
const MIN_TEST_TRADES = 30;
const MIN_PF = 1.05;
const MAX_DD = 20;
const MAX_MC_LOSS = 45;
const MIN_SCORE = 85;
const ULTRA_SCORE = 94;
const LOW_RR = 10;
const HIGH_RR = 15;

const mean = (a:number[]) => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const sd = (a:number[]) => { const m=mean(a); return a.length>1 ? Math.sqrt(mean(a.map(x=>(x-m)**2))) : 0; };
const atr = (c:Candle[],p=14) => { const s=c.slice(-(p+1)); return mean(s.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-s[i].close),Math.abs(x.low-s[i].close)))); };

function summarize(id:string, returns:number[], initial:number):StrategyResult {
  const wins=returns.filter(x=>x>0), losses=returns.filter(x=>x<0), gp=wins.reduce((a,b)=>a+b,0), gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  const pf=gl?gp/gl:0;
  let equity=initial, peak=initial, dd=0;
  for(const r of returns){ equity*=1+r/100; peak=Math.max(peak,equity); dd=Math.max(dd,(peak-equity)/peak*100); }
  const ret=(equity/initial-1)*100, wr=returns.length?wins.length/returns.length*100:0, avg=mean(returns), neg=sd(losses), s=sd(returns), sh=s?Math.sqrt(returns.length)*avg/s:0, so=neg?Math.sqrt(returns.length)*avg/neg:0;
  return {id,name:'Production Regime Breakout v13',trades:returns.length,wins:wins.length,losses:losses.length,winRate:wr,profitFactor:pf,netPnl:equity-initial,returnPct:ret,maxDrawdownPct:dd,avgTrade:avg,score:(ret+Math.min(pf,5)*2.5+sh*2+so*.75+wr/25-dd*.8)*Math.min(1,returns.length/30),tradeReturnsPct:returns,sharpe:sh,sortino:so,calmar:dd?ret/dd:0,expectancy:avg,turnoverPct:returns.reduce((a,b)=>a+Math.abs(b),0)};
}

function monte(returns:number[],runs=5000){
  if(!returns.length)return{simulations:runs,probabilityOfLoss:100,medianReturnPct:0,p05ReturnPct:0,p95MaxDrawdownPct:0};
  let seed=0x7a11>>>0; const rnd=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
  const finals:number[]=[],dds:number[]=[];
  for(let k=0;k<runs;k++){let e=1,p=1,d=0;for(let i=0;i<returns.length;i++){e*=1+returns[Math.floor(rnd()*returns.length)]/100;p=Math.max(p,e);d=Math.max(d,(p-e)/p*100);}finals.push((e-1)*100);dds.push(d);}
  finals.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);
  return{simulations:runs,probabilityOfLoss:finals.filter(x=>x<0).length/runs*100,medianReturnPct:finals[Math.floor(runs*.5)]??0,p05ReturnPct:finals[Math.floor(runs*.05)]??0,p95MaxDrawdownPct:dds[Math.floor(runs*.95)]??0};
}

function simulate(c:Candle[],cfg:BacktestConfig,start:number,end:number):StrategyResult {
  let equity=cfg.initialCapital,peak=equity,dd=0;
  const returns:number[]=[];
  let open:null|{side:1|-1;entry:number;stop:number;target:number;qty:number;bars:number;initialRisk:number;rr:number}=null;
  const fee=cfg.feeBps/10000, slip=cfg.slippageBps/10000;

  for(let i=Math.max(start,LOOKBACK);i<end;i++){
    const b=c[i], hist=c.slice(Math.max(0,i-LOOKBACK),i);
    if(open){
      open.bars++;
      const favorable=open.side===1?b.high-open.entry:open.entry-b.low;
      const r=favorable/Math.max(open.initialRisk,1e-12);
      if(r>=2.5){
        const lock=open.entry+open.side*open.initialRisk;
        if(open.side===1)open.stop=Math.max(open.stop,lock);else open.stop=Math.min(open.stop,lock);
      }else if(r>=1.25){
        open.stop=open.side===1?Math.max(open.stop,open.entry):Math.min(open.stop,open.entry);
      }
      const stopHit=open.side===1?b.low<=open.stop:b.high>=open.stop;
      const targetHit=open.side===1?b.high>=open.target:b.low<=open.target;
      const timeout=open.bars>=cfg.maxBarsInTrade;
      if(stopHit||targetHit||timeout){
        const raw=stopHit?open.stop:targetHit?open.target:b.close;
        const exit=raw*(1-open.side*slip);
        const gross=open.side*(exit-open.entry)*open.qty;
        const fees=(Math.abs(open.entry*open.qty)+Math.abs(exit*open.qty))*fee;
        const pnl=gross-fees;
        returns.push(equity?100*pnl/equity:0);
        equity+=pnl;
        open=null;
      }
    }
    if(!open){
      const signal=evaluateProductionStrategy(hist.map(x=>x.close),{minScore:MIN_SCORE,lookback:LOOKBACK,feeBps:cfg.feeBps,slippageBps:cfg.slippageBps});
      if(signal.action!=='WAIT'&&signal.riskReward>=LOW_RR){
        const side=signal.action==='LONG'?1:-1;
        const entry=b.open*(1+side*slip);
        const risk=Math.max(Math.abs(signal.entry-signal.stopLoss),entry*0.0005);
        const rr=signal.score>=ULTRA_SCORE?HIGH_RR:LOW_RR;
        const riskBudget=Math.max(equity,0)*cfg.riskPerTradePct/100;
        const maxNotional=Math.max(equity,0)*cfg.maxPositionPct/100*Math.max(1,cfg.leverage);
        const q=Math.min(riskBudget/risk,maxNotional/entry);
        if(q>0){
          const stop=entry-side*risk;
          const target=entry+side*(risk*rr+entry*(2*slip+2*fee));
          open={side,entry,stop,target,qty:q,bars:0,initialRisk:risk,rr};
        }
      }
    }
    peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak*100);
  }
  return summarize('production',returns,cfg.initialCapital);
}

function foldPass(report:StrategyResult){return report.trades>=MIN_FOLD_TRADES&&report.returnPct>0&&report.profitFactor>=MIN_PF&&report.maxDrawdownPct<=MAX_DD;}

export async function runValidation(symbol='BTCUSDT',interval='1h',cfg:Partial<BacktestConfig>={}):Promise<ValidationReport>{
  const config={initialCapital:10000,feeBps:10,slippageBps:2,riskPerTradePct:.25,maxPositionPct:20,leverage:10,stopAtr:1.15,rewardRisk:10,maxBarsInTrade:240,...cfg};
  const fetched=await fetchHistoricalCandles(symbol,interval,MAX_HISTORY_BARS+5);
  const candles=fetched.slice(-MAX_HISTORY_BARS);
  if(candles.length<MAX_HISTORY_BARS)throw new Error(`Need ${MAX_HISTORY_BARS.toLocaleString()} completed candles; received ${candles.length.toLocaleString()}.`);

  const n=candles.length, pre=Math.floor(n*PRE_OOS), foldSize=Math.floor(pre/FOLDS), foldDiagnostics:Record<string,FoldDiagnostic[]>={production:[]};
  const folds:StrategyResult[]=[];
  for(let k=0;k<FOLDS;k++){
    const a=k*foldSize,b=(k+1)*foldSize,r=simulate(candles,config,a,b);folds.push(r);
    foldDiagnostics.production.push({fold:k+1,startBar:a,endBar:b,trades:r.trades,winRate:r.winRate,profitFactor:r.profitFactor,returnPct:r.returnPct,maxDrawdownPct:r.maxDrawdownPct,passesTrades:r.trades>=MIN_FOLD_TRADES,passesReturn:r.returnPct>0,passesProfitFactor:r.profitFactor>=MIN_PF,passesDrawdown:r.maxDrawdownPct<=MAX_DD,passed:foldPass(r)});
  }
  const allThree=folds.every(foldPass);
  const preReturns=folds.flatMap(x=>x.tradeReturnsPct);
  const validation=summarize('production',preReturns,config.initialCapital);
  const test=allThree?simulate(candles,config,pre,n):null;
  const mc=test?monte(test.tradeReturnsPct):monte([]);
  const reasons:string[]=[];
  if(!allThree){const passed=folds.filter(foldPass).length;reasons.push(`Production Regime Breakout v13 did not pass all 3 pre-OOS stability folds (${passed}/3 passed; minimum ${MIN_FOLD_TRADES} trades/fold, PF >= ${MIN_PF}, positive return, DD <= ${MAX_DD}%).`);}
  if(test&&test.trades<MIN_TEST_TRADES)reasons.push(`OOS trades ${test.trades} < ${MIN_TEST_TRADES}.`);
  if(test&&test.profitFactor<MIN_PF)reasons.push(`OOS PF ${test.profitFactor.toFixed(2)} < ${MIN_PF}.`);
  if(test&&test.returnPct<=0)reasons.push(`OOS return ${test.returnPct.toFixed(2)}% is not positive.`);
  if(test&&test.maxDrawdownPct>MAX_DD)reasons.push(`OOS drawdown ${test.maxDrawdownPct.toFixed(2)}% > ${MAX_DD}%.`);
  if(test&&mc.probabilityOfLoss>MAX_MC_LOSS)reasons.push(`Monte Carlo loss probability ${mc.probabilityOfLoss.toFixed(1)}% > ${MAX_MC_LOSS}%.`);

  let research:ValidationReport|null=null;
  try{research=await runResearchValidation(symbol,interval,config,undefined,candles,true);}catch{research=null;}
  const strategyRows=research?.strategies?.filter(s=>s.id!=='production')??[];
  const strategies=[validation,...strategyRows].sort((a,b)=>b.score-a.score);
  const gate:ValidationGate={status:reasons.length?'REJECTED':'VALIDATED',reasons,minimumTestTrades:MIN_TEST_TRADES,minimumProfitFactor:MIN_PF,minimumTestReturnPct:0,maximumTestDrawdownPct:MAX_DD,maximumMonteCarloLossProbability:MAX_MC_LOSS};
  const step=interval==='1h'?3600000:interval==='4h'?14400000:interval==='15m'?900000:interval==='5m'?300000:60000;
  return{symbol,interval,candles:n,dataQuality:{startTime:candles[0].openTime,endTime:candles.at(-1)!.openTime,durationDays:(candles.at(-1)!.openTime-candles[0].openTime)/864e5,expectedIntervalMinutes:step/60000,gaps:candles.slice(1).filter((x,i)=>x.openTime-candles[i].openTime!==step).length,duplicateTimestamps:n-new Set(candles.map(x=>x.openTime)).size},costs:{feeBps:config.feeBps,slippageBps:config.slippageBps,roundTripPct:2*(config.feeBps+config.slippageBps)/10000},strategies,walkForward:{trainBars:foldSize,validationBars:foldSize,testBars:n-pre,selectedStrategy:allThree?'Production Regime Breakout v13':'No eligible strategy',validation:allThree?validation:null,test},foldDiagnostics,monteCarlo:mc,gate,generatedAt:new Date().toISOString(),research:{asOf:new Date().toISOString(),dataWindowBars:n,selectionMethod:'Strict production strategy; 3 non-overlapping pre-OOS folds; exact 10R/15R score-based targets; all 3 folds required; untouched 30% OOS; costs included; no manual OOS tuning.',coverage:['10R target for score 85-93','15R target for score 94+','cost-aware stop and target','break-even at 1.25R','protected runner at 2.5R','strict 3-fold stability gate','untouched 30% OOS','5,000-run Monte Carlo loss test']}};
}
