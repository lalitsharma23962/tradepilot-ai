import { evaluateProductionStrategy } from './strategy';

export type Candle={openTime:number;open:number;high:number;low:number;close:number;volume:number};
export type BacktestConfig={initialCapital:number;feeBps:number;slippageBps:number;riskPerTradePct:number;maxPositionPct:number;leverage:number;stopAtr:number;rewardRisk:number;maxBarsInTrade:number};
export type StrategyResult={id:string;name:string;trades:number;wins:number;losses:number;winRate:number;profitFactor:number;netPnl:number;returnPct:number;maxDrawdownPct:number;avgTrade:number;score:number;tradeReturnsPct:number[]};
export type ValidationGate={status:'VALIDATED'|'REJECTED';reasons:string[];minimumTestTrades:number;minimumProfitFactor:number;minimumTestReturnPct:number;maximumTestDrawdownPct:number;maximumMonteCarloLossProbability:number};
export type ValidationReport={symbol:string;interval:string;candles:number;dataQuality:{startTime:number;endTime:number;durationDays:number;expectedIntervalMinutes:number;gaps:number;duplicateTimestamps:number};costs:{feeBps:number;slippageBps:number};strategies:StrategyResult[];walkForward:{trainBars:number;validationBars:number;testBars:number;selectedStrategy:string;validation:StrategyResult|null;test:StrategyResult|null};monteCarlo:{simulations:number;probabilityOfLoss:number;medianReturnPct:number;p05ReturnPct:number;p95MaxDrawdownPct:number};gate:ValidationGate;generatedAt:string};

export const MAX_STRATEGIES=10;
export const DEFAULT_BACKTEST_CONFIG:BacktestConfig={initialCapital:10000,feeBps:10,slippageBps:2,riskPerTradePct:0.25,maxPositionPct:20,leverage:10,stopAtr:1.25,rewardRisk:1.8,maxBarsInTrade:48};
export const STRATEGIES=[
 {id:'production',name:'Production Breakout v12'},
 {id:'ema-trend',name:'EMA Trend + Momentum'},
 {id:'breakout',name:'Donchian Breakout'},
 {id:'pullback',name:'EMA Pullback'},
 {id:'rsi-reversion',name:'RSI Mean Reversion'},
 {id:'bollinger',name:'Bollinger Reversion'},
 {id:'macd',name:'MACD Trend'},
 {id:'range-break',name:'Volatility Range Break'},
 {id:'momentum',name:'Multi-Horizon Momentum'},
 {id:'hybrid',name:'Regime Hybrid'},
] as const;

const MIN_HISTORY_BARS=10000,MIN_TRAIN_TRADES=30,MIN_VALIDATION_TRADES=15,MIN_TEST_TRADES=30,MIN_TEST_PF=1.05,MAX_TEST_DD=20,MAX_MC_LOSS=45;
const INDICATOR_LOOKBACK=180;
const clamp=(v:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,v));
const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const std=(xs:number[])=>{const m=mean(xs);return xs.length>1?Math.sqrt(mean(xs.map(x=>(x-m)**2))):0;};
const ema=(xs:number[],p:number)=>{if(!xs.length)return 0;const k=2/(p+1);let e=xs[0];for(let i=1;i<xs.length;i++)e=xs[i]*k+e*(1-k);return e;};
const atr=(cs:Candle[],p=14)=>{const x=cs.slice(-(p+1));return mean(x.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-x[i].close),Math.abs(c.low-x[i].close))));};
const highest=(xs:number[],n:number)=>Math.max(...xs.slice(-n));
const lowest=(xs:number[],n:number)=>Math.min(...xs.slice(-n));
const rsi=(xs:number[],p=14)=>{const x=xs.slice(-(p+1)),d=x.slice(1).map((v,i)=>v-x[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l===0?100:100-100/(1+g/l);};

function legacySignal(id:string,cs:Candle[]):1|-1|0{
 if(cs.length<120)return 0;
 const closes=cs.map(c=>c.close),last=closes[closes.length-1],prevClose=closes[closes.length-2];
 const e10=ema(closes,10),e20=ema(closes,20),e50=ema(closes,50),e100=ema(closes,100),a=atr(cs),r=rsi(closes);
 if(!a||!Number.isFinite(a))return 0;
 const prior=closes.slice(0,-1),hi20=highest(prior,20),lo20=lowest(prior,20),hi50=highest(prior,50),lo50=lowest(prior,50);
 const last20=closes.slice(-20),sd20=std(last20),mid20=mean(last20),upper=mid20+2*sd20,lower=mid20-2*sd20;
 const macd=ema(closes,12)-ema(closes,26),prev=closes.slice(0,-1),macdPrev=ema(prev,12)-ema(prev,26);
 const momentum=last/closes[Math.max(0,closes.length-21)]-1,vol=cs[cs.length-1].volume,avgVol=mean(cs.slice(-20).map(c=>c.volume));
 void vol; void avgVol;
 switch(id){
  case'ema-trend':return e20>e50&&e50>e100&&last>e10?1:e20<e50&&e50<e100&&last<e10?-1:0;
  case'breakout':return last>hi20?1:last<lo20?-1:0;
  case'pullback':return e20>e50&&last>e20&&closes.slice(-5).some(x=>x<=e20)?1:e20<e50&&last<e20&&closes.slice(-5).some(x=>x>=e20)?-1:0;
  case'rsi-reversion':return r<28&&last>prevClose?1:r>72&&last<prevClose?-1:0;
  case'bollinger':return last<lower&&last>prevClose?1:last>upper&&last<prevClose?-1:0;
  case'macd':return macd>0&&macd>macdPrev&&last>e50?1:macd<0&&macd<macdPrev&&last<e50?-1:0;
  case'range-break':return last>hi50&&a/last>0.003?1:last<lo50&&a/last>0.003?-1:0;
  case'momentum':return momentum>0.008&&last>e20?1:momentum<-0.008&&last<e20?-1:0;
  case'hybrid':return e20>e50&&momentum>0.004&&r>50&&r<72?1:e20<e50&&momentum<-0.004&&r<50&&r>28?-1:0;
  default:return 0;
 }
}

function summarize(id:string,pnls:number[],initialCapital:number,maxDd:number,tradeReturnsPct=pnls.map(p=>initialCapital?p/initialCapital*100:0)):StrategyResult{
 const wins=pnls.filter(x=>x>0).length,losses=pnls.filter(x=>x<0).length;
 const gp=pnls.filter(x=>x>0).reduce((a,b)=>a+b,0),gl=Math.abs(pnls.filter(x=>x<0).reduce((a,b)=>a+b,0));
 const pf=gl?gp/gl:gp>0?99:0,netPnl=pnls.reduce((a,b)=>a+b,0),returnPct=initialCapital?netPnl/initialCapital*100:0;
 const winRate=pnls.length?wins/pnls.length*100:0,avgTrade=pnls.length?mean(pnls):0;
 const edgePenalty=pnls.length<MIN_TRAIN_TRADES?(MIN_TRAIN_TRADES-pnls.length)*0.5:0;
 const score=returnPct+Math.min(pf,5)*3+winRate/20-maxDd*.75-edgePenalty;
 return{id,name:STRATEGIES.find(s=>s.id===id)?.name??id,trades:pnls.length,wins,losses,winRate,profitFactor:pf,netPnl,returnPct,maxDrawdownPct:maxDd,avgTrade,score,tradeReturnsPct};
}

function closePnl(raw:number,p:{side:1|-1;entry:number;qty:number},fee:number,slip:number){
 const exit=raw*(1-p.side*slip),gross=p.side*(exit-p.entry)*p.qty,fees=(Math.abs(p.entry*p.qty)+Math.abs(exit*p.qty))*fee;
 return gross-fees;
}

function simulateLegacyRange(cs:Candle[],id:string,cfg:BacktestConfig,startIndex=120,endIndex=cs.length):StrategyResult{
 const start=Math.max(120,startIndex),end=Math.min(cs.length,endIndex);if(end<=start)return summarize(id,[],cfg.initialCapital,0);
 let equity=cfg.initialCapital,peak=equity,maxDd=0;const pnls:number[]=[];const tradeReturns:number[]=[];
 let open:{side:1|-1;entry:number;stop:number;target:number;qty:number;bars:number}|null=null;
 const fee=cfg.feeBps/10000,slip=cfg.slippageBps/10000;
 for(let i=start;i<end;i++){
  const window=cs.slice(Math.max(0,i-INDICATOR_LOOKBACK+1),i+1),c=cs[i];let closedThisBar=false;
  if(open){open.bars++;const hitStop=open.side===1?c.low<=open.stop:c.high>=open.stop,hitTarget=open.side===1?c.high>=open.target:c.low<=open.target;
   if(hitStop||hitTarget||open.bars>=cfg.maxBarsInTrade){const raw=hitStop?open.stop:hitTarget?open.target:c.close,pnl=closePnl(raw,open,fee,slip);tradeReturns.push(equity?100*pnl/equity:0);pnls.push(pnl);equity+=pnl;open=null;closedThisBar=true;}
  }
  if(!open&&!closedThisBar){const side=legacySignal(id,window);if(side){const entry=c.open*(1+side*slip),a=atr(window),riskDistance=Math.max(a*cfg.stopAtr,entry*0.0015),stop=entry-side*riskDistance,target=entry+side*riskDistance*cfg.rewardRisk,riskBudget=Math.max(0,equity)*cfg.riskPerTradePct/100,riskQty=riskBudget/riskDistance,maxNotional=Math.max(0,equity)*cfg.maxPositionPct/100*Math.max(1,cfg.leverage),qty=Math.max(0,Math.min(riskQty,maxNotional/entry));if(qty>0)open={side,entry,stop,target,qty,bars:0};}}
  peak=Math.max(peak,equity);maxDd=Math.max(maxDd,peak?(peak-equity)/peak*100:0);
 }
 if(open){const pnl=closePnl(cs[end-1].close,open,fee,slip);tradeReturns.push(equity?100*pnl/equity:0);pnls.push(pnl);equity+=pnl;}
 return summarize(id,pnls,cfg.initialCapital,maxDd,tradeReturns);
}

function simulateProductionRange(cs:Candle[],cfg:BacktestConfig,startIndex=120,endIndex=cs.length):StrategyResult{
 const start=Math.max(120,startIndex),end=Math.min(cs.length,endIndex);if(end<=start)return summarize('production',[],cfg.initialCapital,0);
 let equity=cfg.initialCapital,peak=equity,maxDd=0;const pnls:number[]=[];const tradeReturns:number[]=[];
 let open:{side:1|-1;entry:number;stop:number;target:number;qty:number;bars:number}|null=null;
 const fee=cfg.feeBps/10000,slip=cfg.slippageBps/10000;
 for(let i=start;i<end;i++){
  const c=cs[i];let closedThisBar=false;
  if(open){open.bars++;const hitStop=open.side===1?c.low<=open.stop:c.high>=open.stop,hitTarget=open.side===1?c.high>=open.target:c.low<=open.target;
   if(hitStop||hitTarget||open.bars>=cfg.maxBarsInTrade){const raw=hitStop?open.stop:hitTarget?open.target:c.close,pnl=closePnl(raw,open,fee,slip);tradeReturns.push(equity?100*pnl/equity:0);pnls.push(pnl);equity+=pnl;open=null;closedThisBar=true;}
  }
  if(!open&&!closedThisBar){
   const closes=cs.slice(Math.max(0,i-INDICATOR_LOOKBACK),i).map(x=>x.close);
   const sig=evaluateProductionStrategy(closes,{lookback:180,strategyLimit:MAX_STRATEGIES,feeBps:cfg.feeBps,slippageBps:cfg.slippageBps,minRiskReward:1.5,maxRiskReward:2.0,atrStopMultiple:1.25});
   if(sig.action!=='WAIT'&&Number.isFinite(sig.entry)&&Number.isFinite(sig.stopLoss)&&Number.isFinite(sig.takeProfit)){
    const side=sig.action==='LONG'?1:-1,signalRisk=Math.abs(sig.entry-sig.stopLoss),signalReward=Math.abs(sig.takeProfit-sig.entry);
    if(signalRisk>0&&signalReward>0){const entry=c.open*(1+side*slip),stopDistance=signalRisk,stop=entry-side*stopDistance,target=entry+side*signalReward,riskBudget=Math.max(0,equity)*cfg.riskPerTradePct/100,riskQty=riskBudget/stopDistance,maxNotional=Math.max(0,equity)*cfg.maxPositionPct/100*Math.max(1,cfg.leverage),qty=Math.max(0,Math.min(riskQty,maxNotional/entry));if(qty>0)open={side,entry,stop,target,qty,bars:0};}
   }
  }
  peak=Math.max(peak,equity);maxDd=Math.max(maxDd,peak?(peak-equity)/peak*100:0);
 }
 if(open){const pnl=closePnl(cs[end-1].close,open,fee,slip);tradeReturns.push(equity?100*pnl/equity:0);pnls.push(pnl);equity+=pnl;}
 return summarize('production',pnls,cfg.initialCapital,maxDd,tradeReturns);
}

function simulateRange(cs:Candle[],id:string,cfg:BacktestConfig,startIndex=120,endIndex=cs.length){return id==='production'?simulateProductionRange(cs,cfg,startIndex,endIndex):simulateLegacyRange(cs,id,cfg,startIndex,endIndex);}
function intervalToMs(interval:string){const m=interval.match(/^(\d+)([mhdw])$/i);if(!m)throw new Error(`Unsupported interval: ${interval}`);const n=Number(m[1]),u=m[2].toLowerCase();return n*(u==='m'?60000:u==='h'?3600000:u==='d'?86400000:604800000);}

export async function fetchHistoricalCandles(symbol='BTCUSDT',interval='5m',limit=20000):Promise<Candle[]>{
 const target=Math.min(20000,Math.max(10000,limit)),intervalMs=intervalToMs(interval),start=Math.max(0,Date.now()-target*intervalMs),rows:unknown[][]=[];let cursor=start;
 while(rows.length<target){const batchLimit=Math.min(1000,target-rows.length),url=`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&startTime=${cursor}&limit=${batchLimit}`;const response=await fetch(url,{headers:{Accept:'application/json'}});if(!response.ok)throw new Error(`Historical market data request failed (${response.status}).`);const batch=await response.json() as unknown[][];if(!batch.length)break;rows.push(...batch);const lastOpen=Number(batch[batch.length-1]?.[0]);if(!Number.isFinite(lastOpen)||lastOpen<cursor)break;cursor=lastOpen+intervalMs;if(batch.length<batchLimit)break;await new Promise(resolve=>setTimeout(resolve,60));}
 const seen=new Set<number>(),now=Date.now();
 return rows.map(r=>({openTime:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})).filter(c=>[c.openTime,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.openTime+intervalMs<=now&&!seen.has(c.openTime)&&seen.add(c.openTime)).sort((a,b)=>a.openTime-b.openTime).slice(-target);
}

function monteCarlo(returnsPct:number[],simulations=5000,seed=0x51a7):ValidationReport['monteCarlo']{
 if(!returnsPct.length)return{simulations,probabilityOfLoss:100,medianReturnPct:0,p05ReturnPct:0,p95MaxDrawdownPct:0};
 let s=seed>>>0;const rand=()=>{s=(1664525*s+1013904223)>>>0;return s/4294967296;},endings:number[]=[],dds:number[]=[];
 for(let run=0;run<simulations;run++){let eq=1,peak=1,dd=0;for(let i=0;i<returnsPct.length;i++){eq*=1+returnsPct[Math.floor(rand()*returnsPct.length)]/100;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak*100);}endings.push((eq-1)*100);dds.push(dd);}
 endings.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);const q=(xs:number[],p:number)=>xs[Math.floor((xs.length-1)*p)]??0;
 return{simulations,probabilityOfLoss:endings.filter(x=>x<0).length/simulations*100,medianReturnPct:q(endings,.5),p05ReturnPct:q(endings,.05),p95MaxDrawdownPct:q(dds,.95)};
}

function buildQuality(candles:Candle[],interval:string){const expected=intervalToMs(interval),gaps=candles.slice(1).filter((c,i)=>c.openTime-candles[i].openTime!==expected).length,duplicates=candles.length-new Set(candles.map(c=>c.openTime)).size;return{startTime:candles[0]?.openTime??0,endTime:candles[candles.length-1]?.openTime??0,durationDays:candles.length?(candles[candles.length-1].openTime-candles[0].openTime)/86400000:0,expectedIntervalMinutes:expected/60000,gaps,duplicateTimestamps:duplicates};}

const validationSelectionScore=(train:StrategyResult,validation:StrategyResult)=>{
 const consistencyPenalty=Math.max(0,train.score-validation.score)*0.25;
 return validation.score*0.7+train.score*0.3-consistencyPenalty;
};

export async function runValidation(symbol='BTCUSDT',interval='5m',cfg:Partial<BacktestConfig>={}):Promise<ValidationReport>{
 const config={...DEFAULT_BACKTEST_CONFIG,...cfg,maxPositionPct:clamp(cfg.maxPositionPct??20,1,20),leverage:clamp(cfg.leverage??10,1,10),riskPerTradePct:clamp(cfg.riskPerTradePct??0.25,0.05,1)};
 const candles=await fetchHistoricalCandles(symbol,interval,20000);if(candles.length<MIN_HISTORY_BARS)throw new Error(`Validation requires at least ${MIN_HISTORY_BARS.toLocaleString()} completed historical candles; received ${candles.length.toLocaleString()}.`);
 // 35/15/50 gives the selection stages enough history while reserving half the data
 // for one untouched out-of-sample test. Strategy selection happens only on train+validation;
 // the test window is never used to choose a strategy.
 const trainEnd=Math.floor(candles.length*.35),validationEnd=Math.floor(candles.length*.50);
 const trainResults=STRATEGIES.map(s=>simulateRange(candles,s.id,config,120,trainEnd));
 const eligibleTrain=trainResults.filter(r=>r.trades>=MIN_TRAIN_TRADES);
 const validationCandidates=eligibleTrain.map(train=>({train,validation:simulateRange(candles,train.id,config,trainEnd,validationEnd)})).filter(x=>x.validation.trades>=MIN_VALIDATION_TRADES);
 const selectedCandidate=validationCandidates.slice().sort((a,b)=>validationSelectionScore(b.train,b.validation)-validationSelectionScore(a.train,a.validation))[0];
 const selectedTrain=selectedCandidate?.train??eligibleTrain.slice().sort((a,b)=>b.score-a.score)[0]??trainResults.slice().sort((a,b)=>b.score-a.score)[0];
 const selectedId=selectedTrain?.id??'production';
 const validation=selectedCandidate?.validation??simulateRange(candles,selectedId,config,trainEnd,validationEnd);
 // IMPORTANT: this is the only time the selected strategy is evaluated on OOS data.
 const testResult=simulateRange(candles,selectedId,config,validationEnd,candles.length);
 const fullResults=trainResults.map(r=>r.id==='production'?simulateProductionRange(candles,config,120,candles.length):simulateRange(candles,r.id,config,120,candles.length)).sort((a,b)=>b.score-a.score);
 const mc=monteCarlo(testResult.tradeReturnsPct),reasons:string[]=[];
 if(buildQuality(candles,interval).gaps>Math.max(3,Math.floor(candles.length*.001)))reasons.push(`Historical data contains ${buildQuality(candles,interval).gaps} interval gaps.`);
 if(buildQuality(candles,interval).duplicateTimestamps>0)reasons.push(`Historical data contains ${buildQuality(candles,interval).duplicateTimestamps} duplicate timestamps.`);
 if(selectedTrain.trades<MIN_TRAIN_TRADES)reasons.push(`Selected strategy produced only ${selectedTrain.trades} training trades; at least ${MIN_TRAIN_TRADES} are required.`);
 if(validation.trades<MIN_VALIDATION_TRADES)reasons.push(`Selected strategy produced only ${validation.trades} validation trades; at least ${MIN_VALIDATION_TRADES} are required.`);
 if(testResult.trades<MIN_TEST_TRADES)reasons.push(`Out-of-sample test has only ${testResult.trades} trades; at least ${MIN_TEST_TRADES} are required.`);
 if(testResult.profitFactor<MIN_TEST_PF)reasons.push(`Out-of-sample profit factor ${testResult.profitFactor.toFixed(2)} is below ${MIN_TEST_PF.toFixed(2)}.`);
 if(testResult.returnPct<=0)reasons.push(`Out-of-sample return ${testResult.returnPct.toFixed(2)}% is not positive.`);
 if(testResult.maxDrawdownPct>MAX_TEST_DD)reasons.push(`Out-of-sample max drawdown ${testResult.maxDrawdownPct.toFixed(2)}% exceeds ${MAX_TEST_DD}%.`);
 if(mc.probabilityOfLoss>MAX_MC_LOSS)reasons.push(`Monte Carlo loss probability ${mc.probabilityOfLoss.toFixed(1)}% exceeds ${MAX_MC_LOSS}%.`);
 const gate:ValidationGate={status:reasons.length?'REJECTED':'VALIDATED',reasons,minimumTestTrades:MIN_TEST_TRADES,minimumProfitFactor:MIN_TEST_PF,minimumTestReturnPct:0,maximumTestDrawdownPct:MAX_TEST_DD,maximumMonteCarloLossProbability:MAX_MC_LOSS};
 const quality=buildQuality(candles,interval);
 return{symbol,interval,candles:candles.length,dataQuality:quality,costs:{feeBps:config.feeBps,slippageBps:config.slippageBps},strategies:fullResults,walkForward:{trainBars:trainEnd,validationBars:validationEnd-trainEnd,testBars:candles.length-validationEnd,selectedStrategy:selectedTrain.name,validation,test:testResult},monteCarlo:mc,gate,generatedAt:new Date().toISOString()};
}
