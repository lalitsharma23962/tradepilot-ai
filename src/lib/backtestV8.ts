import { fetchHistoricalCandles, type Candle, type BacktestConfig, type StrategyResult, type ValidationReport, type ValidationGate, type FoldDiagnostic } from './backtestV6';
import { evaluateProductionStrategy } from './strategy';

export const MAX_STRATEGIES=17, MAX_HISTORY_BARS=40000;
export const DEFAULT_BACKTEST_CONFIG:BacktestConfig={initialCapital:10000,feeBps:10,slippageBps:2,riskPerTradePct:.25,maxPositionPct:20,leverage:10,stopAtr:1.75,rewardRisk:2.2,maxBarsInTrade:48};
export const STRATEGIES=[
{id:'production',name:'Production Regime Breakout v13'},{id:'ema-trend',name:'EMA Trend + Momentum'},{id:'breakout-20',name:'Donchian Breakout 20'},{id:'breakout-55',name:'Donchian Breakout 55'},{id:'pullback',name:'EMA Pullback'},{id:'rsi-reversion',name:'RSI Mean Reversion'},{id:'bollinger',name:'Bollinger Reversion'},{id:'macd',name:'MACD Trend'},{id:'range-break-20',name:'Volatility Range Break 20'},{id:'range-break-30',name:'Volatility Range Break 30'},{id:'range-break-40',name:'Volatility Range Break 40'},{id:'momentum-21',name:'Momentum 21-Bar'},{id:'momentum-72',name:'Momentum 72-Bar'},{id:'hybrid',name:'Regime Hybrid'},{id:'vol-contraction',name:'Volatility Contraction Breakout'},{id:'atr-channel',name:'ATR Channel Trend'},{id:'zscore',name:'Z-Score Mean Reversion'}] as const;

const MIN_HISTORY=20000,MIN_TEST=30,MIN_PF=1.05,MAX_DD=20,PRE=.70,FOLDS=3,LOOK=240,MIN_MC_LOSS=45;
const mean=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const sd=(a:number[])=>{const m=mean(a);return a.length>1?Math.sqrt(mean(a.map(x=>(x-m)**2))):0};
const ema=(a:number[],p:number)=>{if(!a.length)return 0;const k=2/(p+1);let e=a[0];for(let i=1;i<a.length;i++)e=a[i]*k+e*(1-k);return e};
const atr=(c:Candle[],p=14)=>{const s=c.slice(-(p+1));return mean(s.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-s[i].close),Math.abs(x.low-s[i].close))))};
const rsi=(a:number[],n=14)=>{const s=a.slice(-(n+1)),d=s.slice(1).map((x,i)=>x-s[i]),g=mean(d.map(x=>Math.max(x,0))),l=mean(d.map(x=>Math.max(-x,0)));return l?100-100/(1+g/l):100};
const er=(a:number[],n=24)=>{const s=a.slice(-(n+1));if(s.length<3)return 0;const path=s.slice(1).reduce((q,x,i)=>q+Math.abs(x-s[i]),0);return path?Math.abs(s.at(-1)!-s[0])/path:0};
const slope=(a:number[])=>{if(a.length<2)return 0;const n=a.length,m=mean(a),xm=(n-1)/2;let p=0,q=0;for(let i=0;i<n;i++){p+=(i-xm)*(a[i]-m);q+=(i-xm)**2}return q?p/q:0};
const hi=(a:number[],n:number)=>Math.max(...a.slice(-n)),lo=(a:number[],n:number)=>Math.min(...a.slice(-n));
const typicalVol=(c:Candle[],n=80)=>{const v:number[]=[];for(let i=Math.max(1,c.length-n);i<c.length;i++){const x=c[i],p=c[i-1].close;v.push(Math.max(x.high-x.low,Math.abs(x.high-p),Math.abs(x.low-p))/x.close)}return Math.max(mean(v),.0001)};
const volumeRatio=(c:Candle[],n=30)=>{const last=c.at(-1)?.volume??0,base=mean(c.slice(-(n+1),-1).map(x=>x.volume).filter(Number.isFinite));return base>0?last/base:1};

function signal(id:string,c:Candle[],cfg:BacktestConfig):1|-1|0{
 if(c.length<200)return 0;
 if(id==='production'){
  const s=evaluateProductionStrategy(c.map(x=>x.close),{minScore:75,lookback:LOOK,feeBps:cfg.feeBps,slippageBps:cfg.slippageBps});
  return s.action==='LONG'?1:s.action==='SHORT'?-1:0;
 }
 const p=c.map(x=>x.close),x=p.at(-1)!,a=atr(c),v=a/x,tv=typicalVol(c),e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),r=rsi(p),q=er(p),s12=slope(p.slice(-12))/x,s36=slope(p.slice(-36))/x;
 const up=e20>e50&&e50>e100,down=e20<e50&&e50<e100,prior=p.slice(0,-1),h20=hi(prior,20),l20=lo(prior,20),h40=hi(prior,40),l40=lo(prior,40),h55=hi(prior,55),l55=lo(prior,55),m21=x/p.at(-22)!-1,m72=x/p.at(-73)!-1,mid=mean(p.slice(-20)),st=sd(p.slice(-20)),z=(x-mid)/(st||1),vr=volumeRatio(c),macd=ema(p,12)-ema(p,26),macdPrev=ema(p.slice(0,-1),12)-ema(p.slice(0,-1),26),a10=atr(c,10),a40=atr(c,40);
 const cost=2*(cfg.feeBps+cfg.slippageBps)/10000,volOk=v>=tv*.7&&v<=tv*3.5,buffer=Math.max(tv*.15,.0004)*x,confirm=vr>=.9,notExt=Math.abs(x-e20)<=a*2.4;
 switch(id){
  case'ema-trend':return up&&x>e9&&s36>0&&q>.24&&volOk&&r>50?1:down&&x<e9&&s36<0&&q>.24&&volOk&&r<50?-1:0;
  case'breakout-20':case'range-break-20':return up&&x>h20+buffer&&s12>0&&q>.25&&confirm?1:down&&x<l20-buffer&&s12<0&&q>.25&&confirm?-1:0;
  case'breakout-55':case'range-break-40':return up&&x>h55+buffer&&s36>0&&q>.28&&confirm?1:down&&x<l55-buffer&&s36<0&&q>.28&&confirm?-1:0;
  case'pullback':return up&&x>e20&&p.slice(-7,-1).some(y=>y<=e20+a*.35)&&r>=48&&r<=68&&s12>0&&q>.2?1:down&&x<e20&&p.slice(-7,-1).some(y=>y>=e20-a*.35)&&r>=32&&r<=52&&s12<0&&q>.2?-1:0;
  case'rsi-reversion':return r<25&&x>p.at(-2)!&&v>=tv*.8?1:r>75&&x<p.at(-2)!&&v>=tv*.8?-1:0;
  case'bollinger':return z<-2&&r<45&&x>p.at(-2)!?1:z>2&&r>55&&x<p.at(-2)!?-1:0;
  case'macd':return macd>0&&macd>macdPrev&&x>e50&&q>.2&&volOk?1:macd<0&&macd<macdPrev&&x<e50&&q>.2&&volOk?-1:0;
  case'range-break-30':return up&&x>hi(prior,30)+buffer&&q>.24&&confirm?1:down&&x<lo(prior,30)-buffer&&q>.24&&confirm?-1:0;
  case'momentum-21':return up&&m21>Math.max(.002,tv*1.4)&&r>=52&&r<=72&&q>.23&&notExt?1:down&&m21<-Math.max(.002,tv*1.4)&&r>=28&&r<=48&&q>.23&&notExt?-1:0;
  case'momentum-72':return up&&m72>Math.max(.005,tv*3)&&r>=52&&r<=72&&q>.27&&notExt?1:down&&m72<-Math.max(.005,tv*3)&&r>=28&&r<=48&&q>.27&&notExt?-1:0;
  case'hybrid':return up&&m21>Math.max(.002,tv*1.3)&&r>=52&&r<=70&&q>.26&&confirm?1:down&&m21<-Math.max(.002,tv*1.3)&&r>=30&&r<=48&&q>.26&&confirm?-1:0;
  case'vol-contraction':return a10<a40*.78&&up&&x>h20+buffer&&q>.25&&confirm?1:a10<a40*.78&&down&&x<l20-buffer&&q>.25&&confirm?-1:0;
  case'atr-channel':return up&&x>e50+a*1.35&&s36>0&&q>.25?1:down&&x<e50-a*1.35&&s36<0&&q>.25?-1:0;
  case'zscore':return z<-2.1&&r<40&&x>p.at(-2)!?1:z>2.1&&r>60&&x<p.at(-2)!?-1:0;
  default:return 0;
 }
}

function summarize(id:string,rs:number[],initial:number):StrategyResult{
 const wins=rs.filter(x=>x>0),loss=rs.filter(x=>x<0),gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(loss.reduce((a,b)=>a+b,0)),pf=gl?gp/gl:0;let eq=initial,peak=eq,dd=0;for(const r of rs){eq*=1+r/100;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak*100)}const ret=(eq/initial-1)*100,wr=rs.length?wins.length/rs.length*100:0,m=mean(rs),s=sd(rs),sh=s?Math.sqrt(rs.length)*m/s:0,neg=sd(rs.filter(x=>x<0)),so=neg?Math.sqrt(rs.length)*m/neg:0;return{id,name:STRATEGIES.find(x=>x.id===id)?.name??id,trades:rs.length,wins:wins.length,losses:loss.length,winRate:wr,profitFactor:pf,netPnl:eq-initial,returnPct:ret,maxDrawdownPct:dd,avgTrade:m,score:(ret+Math.min(pf,5)*2.5+sh*2+so*.75+wr/25-dd*.8)*Math.min(1,rs.length/30),tradeReturnsPct:rs,sharpe:sh,sortino:so,calmar:dd?ret/dd:0,expectancy:m,turnoverPct:rs.reduce((a,b)=>a+Math.abs(b),0)};
}

function simulate(c:Candle[],id:string,cfg:BacktestConfig,start:number,end:number):StrategyResult{
 let equity=cfg.initialCapital,peak=equity,dd=0;const rs:number[]=[];let open:null|{side:1|-1;entry:number;stop:number;target:number;qty:number;bars:number}=null;const fee=cfg.feeBps/10000,slip=cfg.slippageBps/10000,roundTrip=2*(fee+slip);
 for(let i=Math.max(start,200);i<end;i++){
  const b=c[i],a=atr(c.slice(Math.max(0,i-60),i)),hist=c.slice(Math.max(0,i-LOOK),i);
  if(open){open.bars++;const stopHit=open.side===1?b.low<=open.stop:b.high>=open.stop,targetHit=open.side===1?b.high>=open.target:b.low<=open.target,timeout=open.bars>=cfg.maxBarsInTrade;
   if(stopHit||targetHit||timeout){const raw=stopHit?open.stop:targetHit?open.target:b.close,exit=raw*(1-open.side*slip),gross=open.side*(exit-open.entry)*open.qty,fees=(Math.abs(open.entry*open.qty)+Math.abs(exit*open.qty))*fee,pnl=gross-fees;rs.push(equity?100*pnl/equity:0);equity+=pnl;open=null}
  }
  if(!open){const side=signal(id,hist,cfg);if(side){const entry=b.open*(1+side*slip),risk=Math.max(a*cfg.stopAtr,entry*roundTrip*1.5),riskBudget=Math.max(equity,0)*cfg.riskPerTradePct/100,maxNotional=Math.max(equity,0)*cfg.maxPositionPct/100*Math.max(1,cfg.leverage),riskQty=riskBudget/risk,q=Math.min(riskQty,maxNotional/entry);if(q>0){const rr=id==='production'?2.5:cfg.rewardRisk;open={side,entry,stop:entry-side*risk,target:entry+side*(risk*rr+entry*roundTrip),qty:q,bars:0}}}}
  peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak*100);
 }
 return summarize(id,rs,cfg.initialCapital);
}

function monte(ret:number[],runs=5000){if(!ret.length)return{simulations:runs,probabilityOfLoss:100,medianReturnPct:0,p05ReturnPct:0,p95MaxDrawdownPct:0};let seed=0x7a11>>>0;const rnd=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296};const finals:number[]=[],dds:number[]=[];for(let k=0;k<runs;k++){let e=1,p=1,d=0;for(let i=0;i<ret.length;i++){e*=1+ret[Math.floor(rnd()*ret.length)]/100;p=Math.max(p,e);d=Math.max(d,(p-e)/p*100)}finals.push((e-1)*100);dds.push(d)}finals.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);return{simulations:runs,probabilityOfLoss:finals.filter(x=>x<0).length/runs*100,medianReturnPct:finals[Math.floor(runs*.5)]??0,p05ReturnPct:finals[Math.floor(runs*.05)]??0,p95MaxDrawdownPct:dds[Math.floor(runs*.95)]??0}}

export async function runValidation(symbol='BTCUSDT',interval='1h',cfg:Partial<BacktestConfig>={},selectedStrategyId?:string):Promise<ValidationReport>{
 const config={...DEFAULT_BACKTEST_CONFIG,...cfg},candles=await fetchHistoricalCandles(symbol,interval,MAX_HISTORY_BARS);if(candles.length<MIN_HISTORY)throw Error(`Need ${MIN_HISTORY} completed candles; received ${candles.length}.`);
 const step=interval==='1h'?3600000:interval==='4h'?14400000:interval==='15m'?900000:interval==='5m'?300000:60000,n=candles.length,pre=Math.floor(n*PRE),foldSize=Math.floor(pre/FOLDS),minFold=Math.max(12,Math.min(30,Math.floor(foldSize/400))),foldDiagnostics:Record<string,FoldDiagnostic[]>={};const perStrategy=new Map<string,StrategyResult[]>();
 const roundTrip=2*(config.feeBps+config.slippageBps)/10000;
 for(const s of STRATEGIES){const fs:StrategyResult[]=[];const ds:FoldDiagnostic[]=[];for(let k=0;k<FOLDS;k++){const a=k*foldSize,b=(k+1)*foldSize,r=simulate(candles,s.id,config,a,b);fs.push(r);ds.push({fold:k+1,startBar:a,endBar:b,trades:r.trades,winRate:r.winRate,profitFactor:r.profitFactor,returnPct:r.returnPct,maxDrawdownPct:r.maxDrawdownPct,passesTrades:r.trades>=minFold,passesReturn:r.returnPct>0,passesProfitFactor:r.profitFactor>=MIN_PF,passesDrawdown:r.maxDrawdownPct<=MAX_DD,passed:r.trades>=minFold&&r.returnPct>0&&r.profitFactor>=MIN_PF&&r.maxDrawdownPct<=MAX_DD})}perStrategy.set(s.id,fs);foldDiagnostics[s.id]=ds}
 const ranked=STRATEGIES.map(s=>{const folds=perStrategy.get(s.id)!;return{s,folds,agg:summarize(s.id,folds.flatMap(x=>x.tradeReturnsPct),config.initialCapital)}}).sort((a,b)=>b.agg.score-a.agg.score);
 const eligible=ranked.filter(x=>{const passed=x.folds.filter(f=>f.trades>=minFold&&f.returnPct>0&&f.profitFactor>=MIN_PF&&f.maxDrawdownPct<=MAX_DD).length;return passed>=2&&x.agg.trades>=MIN_TEST&&x.agg.profitFactor>=MIN_PF&&x.agg.returnPct>0&&x.agg.maxDrawdownPct<=MAX_DD});
 const pick=selectedStrategyId&&eligible.some(x=>x.s.id===selectedStrategyId)?eligible.find(x=>x.s.id===selectedStrategyId):eligible[0];const test=pick?simulate(candles,pick.s.id,config,pre,n):null,mc=test?monte(test.tradeReturnsPct):monte([]),reasons:string[]=[];
 if(!pick){const b=ranked[0];reasons.push(`No strategy passed pre-OOS stability. Best candidate: ${b?.agg.name??'none'} (PF ${b?.agg.profitFactor.toFixed(2)??'0.00'}, return ${b?.agg.returnPct.toFixed(2)??'0.00'}%).`)}
 if(test&&test.trades<MIN_TEST)reasons.push(`OOS trades ${test.trades} < ${MIN_TEST}.`);if(test&&test.profitFactor<MIN_PF)reasons.push(`OOS PF ${test.profitFactor.toFixed(2)} < ${MIN_PF}.`);if(test&&test.returnPct<=0)reasons.push(`OOS return ${test.returnPct.toFixed(2)}% is not positive.`);if(test&&test.maxDrawdownPct>MAX_DD)reasons.push(`OOS drawdown ${test.maxDrawdownPct.toFixed(2)}% > ${MAX_DD}%.`);if(test&&mc.probabilityOfLoss>MIN_MC_LOSS)reasons.push(`Monte Carlo loss probability ${mc.probabilityOfLoss.toFixed(1)}% > ${MIN_MC_LOSS}%.`);
 const gate:ValidationGate={status:reasons.length?'REJECTED':'VALIDATED',reasons,minimumTestTrades:MIN_TEST,minimumProfitFactor:MIN_PF,minimumTestReturnPct:0,maximumTestDrawdownPct:MAX_DD,maximumMonteCarloLossProbability:MIN_MC_LOSS};
 return{symbol,interval,candles:n,dataQuality:{startTime:candles[0].openTime,endTime:candles.at(-1)!.openTime,durationDays:(candles.at(-1)!.openTime-candles[0].openTime)/864e5,expectedIntervalMinutes:step/60000,gaps:candles.slice(1).filter((x,i)=>x.openTime-candles[i].openTime!==step).length,duplicateTimestamps:n-new Set(candles.map(x=>x.openTime)).size},costs:{feeBps:config.feeBps,slippageBps:config.slippageBps,roundTripPct:roundTrip},strategies:ranked.map(x=>x.agg),walkForward:{trainBars:foldSize,validationBars:foldSize,testBars:n-pre,selectedStrategy:pick?.agg.name??'No eligible strategy',validation:pick?.agg??null,test},foldDiagnostics,monteCarlo:mc,gate,generatedAt:new Date().toISOString(),research:{asOf:new Date().toISOString(),dataWindowBars:n,selectionMethod:'Three non-overlapping pre-OOS folds; candidate must pass at least 2 of 3 folds; untouched 30% OOS; costs included in every trade.',coverage:['cost-aware stop floor','cost-aware target','actual notional cap','adaptive volatility filters','trend/momentum confirmation','volume confirmation','fixed 2.2R research target; production 2.5R','Monte Carlo loss test']}};
}
