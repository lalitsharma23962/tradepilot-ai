import { evaluateProductionStrategy } from './strategy';

export type Candle={openTime:number;open:number;high:number;low:number;close:number;volume:number};
export type BacktestConfig={initialCapital:number;feeBps:number;slippageBps:number;riskPerTradePct:number;maxPositionPct:number;leverage:number;stopAtr:number;rewardRisk:number;maxBarsInTrade:number};
export type StrategyResult={id:string;name:string;trades:number;wins:number;losses:number;winRate:number;profitFactor:number;netPnl:number;returnPct:number;maxDrawdownPct:number;avgTrade:number;score:number;tradeReturnsPct:number[];sharpe:number;sortino:number;calmar:number;expectancy:number;turnoverPct:number};
export type ValidationGate={status:'VALIDATED'|'REJECTED';reasons:string[];minimumTestTrades:number;minimumProfitFactor:number;minimumTestReturnPct:number;maximumTestDrawdownPct:number;maximumMonteCarloLossProbability:number};
export type ValidationReport={symbol:string;interval:string;candles:number;dataQuality:{startTime:number;endTime:number;durationDays:number;expectedIntervalMinutes:number;gaps:number;duplicateTimestamps:number};costs:{feeBps:number;slippageBps:number};strategies:StrategyResult[];walkForward:{trainBars:number;validationBars:number;testBars:number;selectedStrategy:string;validation:StrategyResult|null;test:StrategyResult|null};monteCarlo:{simulations:number;probabilityOfLoss:number;medianReturnPct:number;p05ReturnPct:number;p95MaxDrawdownPct:number};gate:ValidationGate;generatedAt:string;research:{asOf:string;dataWindowBars:number;selectionMethod:string;coverage:string[]}};

export const MAX_STRATEGIES=17,MAX_HISTORY_BARS=40000;
export const DEFAULT_BACKTEST_CONFIG:BacktestConfig={initialCapital:10000,feeBps:10,slippageBps:2,riskPerTradePct:0.25,maxPositionPct:20,leverage:10,stopAtr:1.25,rewardRisk:1.8,maxBarsInTrade:48};
export const STRATEGIES=[
 {id:'production',name:'Production Regime Breakout v13'},{id:'ema-trend',name:'EMA Trend + Momentum'},
 {id:'breakout-20',name:'Donchian Breakout 20'},{id:'breakout-55',name:'Donchian Breakout 55'},{id:'pullback',name:'EMA Pullback'},
 {id:'rsi-reversion',name:'RSI Mean Reversion'},{id:'bollinger',name:'Bollinger Reversion'},{id:'macd',name:'MACD Trend'},
 {id:'range-break-20',name:'Volatility Range Break 20'},{id:'range-break-30',name:'Volatility Range Break 30'},{id:'range-break-40',name:'Volatility Range Break 40'},
 {id:'momentum-21',name:'Momentum 21-Bar'},{id:'momentum-72',name:'Momentum 72-Bar'},{id:'hybrid',name:'Regime Hybrid'},
 {id:'vol-contraction',name:'Volatility Contraction Breakout'},{id:'atr-channel',name:'ATR Channel Trend'},{id:'zscore',name:'Z-Score Mean Reversion'}
] as const;
const MIN_HISTORY=20000,MIN_TRAIN=30,MIN_VAL=20,MIN_TEST=30,MIN_PF=1.05,MAX_DD=20,MAX_MC=45,LOOKBACK=240;
const mean=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
const std=(x:number[])=>{const m=mean(x);return x.length>1?Math.sqrt(mean(x.map(v=>(v-m)**2))):0;};
const ema=(x:number[],p:number)=>{if(!x.length)return 0;const k=2/(p+1);let e=x[0];for(let i=1;i<x.length;i++)e=x[i]*k+e*(1-k);return e;};
const atr=(c:Candle[],p=14)=>{const x=c.slice(-(p+1));return mean(x.slice(1).map((v,i)=>Math.max(v.high-v.low,Math.abs(v.high-x[i].close),Math.abs(v.low-x[i].close))));};
const hi=(x:number[],n:number)=>Math.max(...x.slice(-n)),lo=(x:number[],n:number)=>Math.min(...x.slice(-n));
const rsi=(x:number[],p=14)=>{const s=x.slice(-(p+1)),d=s.slice(1).map((v,i)=>v-s[i]),g=mean(d.map(v=>Math.max(v,0))),l=mean(d.map(v=>Math.max(-v,0)));return l?100-100/(1+g/l):100;};
const slope=(x:number[])=>{if(x.length<2)return 0;const n=x.length,xm=(n-1)/2,ym=mean(x);let a=0,b=0;for(let i=0;i<n;i++){a+=(i-xm)*(x[i]-ym);b+=(i-xm)**2;}return b?a/b:0;};
const z=(x:number[],n=40)=>{const s=x.slice(-n),m=mean(s),d=std(s);return d?(s[s.length-1]-m)/d:0;};

function signal(id:string,c:Candle[]):1|-1|0{
 if(c.length<150)return 0;const p=c.map(x=>x.close),last=p[p.length-1],a=atr(c),v=a/last,e9=ema(p,9),e20=ema(p,20),e50=ema(p,50),e100=ema(p,100),r=rsi(p),prior=p.slice(0,-1);
 const up=e20>e50&&e50>e100,down=e20<e50&&e50<e100,s12=slope(p.slice(-12))/last,s36=slope(p.slice(-36))/last,m21=last/p[Math.max(0,p.length-22)]-1,m72=last/p[Math.max(0,p.length-73)]-1;
 const h20=hi(prior,20),l20=lo(prior,20),h30=hi(prior,30),l30=lo(prior,30),h40=hi(prior,40),l40=lo(prior,40),h55=hi(prior,55),l55=lo(prior,55);
 const mid=mean(p.slice(-20)),sd=std(p.slice(-20)),upper=mid+2*sd,lower=mid-2*sd,macd=ema(p,12)-ema(p,26),macdPrev=ema(p.slice(0,-1),12)-ema(p.slice(0,-1),26),af=atr(c,10),as=atr(c,40),contract=af>0&&as>0&&af/as<.72;
 const costAware=v>=Math.max(.00045,((10+2)*2/10000)*.55)&&v<=.025;
 switch(id){
  case'production':return up&&s12>0&&s36>0&&(last>h20||last>e20)&&r>=48&&r<=72&&costAware&&last<=e20+a*2.5?1:down&&s12<0&&s36<0&&(last<l20||last<e20)&&r>=28&&r<=52&&costAware&&last>=e20-a*2.5?-1:0;
  case'ema-trend':return up&&last>e9&&s36>0?1:down&&last<e9&&s36<0?-1:0;
  case'breakout-20':return last>h20&&v>.0015?1:last<l20&&v>.0015?-1:0;
  case'breakout-55':return last>h55&&v>.0018?1:last<l55&&v>.0018?-1:0;
  case'pullback':return up&&last>e20&&p.slice(-6,-1).some(x=>x<=e20*1.001)&&r>45&&r<70?1:down&&last<e20&&p.slice(-6,-1).some(x=>x>=e20*.999)&&r<55&&r>30?-1:0;
  case'rsi-reversion':return r<27&&last>p[p.length-2]?1:r>73&&last<p[p.length-2]?-1:0;
  case'bollinger':return last<lower&&last>p[p.length-2]?1:last>upper&&last<p[p.length-2]?-1:0;
  case'macd':return macd>0&&macd>macdPrev&&last>e50?1:macd<0&&macd<macdPrev&&last<e50?-1:0;
  case'range-break-20':return last>h20&&v>.002?1:last<l20&&v>.002?-1:0;
  case'range-break-30':return last>h30&&v>.002?1:last<l30&&v>.002?-1:0;
  case'range-break-40':return last>h40&&v>.0025&&up&&s12>0?1:last<l40&&v>.0025&&down&&s12<0?-1:0;
  case'momentum-21':return m21>.006&&last>e20&&r>50?1:m21<-.006&&last<e20&&r<50?-1:0;
  case'momentum-72':return m72>.015&&last>e50?1:m72<-.015&&last<e50?-1:0;
  case'hybrid':return up&&m21>.004&&r>50&&r<72?1:down&&m21<-.004&&r<50&&r>28?-1:0;
  case'vol-contraction':return contract&&last>h20&&s12>0?1:contract&&last<l20&&s12<0?-1:0;
  case'atr-channel':{const center=ema(p,50),band=a*1.6;return last>center+band&&s36>0?1:last<center-band&&s36<0?-1:0;}
  case'zscore':{const zz=z(p);return zz<-2.1&&r<40&&last>p[p.length-2]?1:zz>2.1&&r>60&&last<p[p.length-2]?-1:0;}
  default:return 0;
 }
}

function summarize(id:string,pnls:number[],initial:number,dd:number,tr:number[]):StrategyResult{
 const wins=pnls.filter(x=>x>0).length,losses=pnls.filter(x=>x<0).length,gp=pnls.filter(x=>x>0).reduce((a,b)=>a+b,0),gl=Math.abs(pnls.filter(x=>x<0).reduce((a,b)=>a+b,0)),pf=gl?gp/gl:gp>0?99:0,net=pnls.reduce((a,b)=>a+b,0),ret=initial?net/initial*100:0,wr=pnls.length?wins/pnls.length*100:0,avg=pnls.length?mean(pnls):0;
 const rr=tr.map(x=>x/100),m=mean(rr),sd=std(rr),neg=std(rr.filter(x=>x<0)),sh=sd?Math.sqrt(Math.max(1,tr.length))*m/sd:0,so=neg?Math.sqrt(Math.max(1,tr.length))*m/neg:0,cal=dd?ret/dd:ret>0?99:0,turn=initial?pnls.reduce((a,b)=>a+Math.abs(b),0)/initial*100:0,penalty=pnls.length<MIN_TRAIN?(MIN_TRAIN-pnls.length)*.5:0;
 const score=ret+Math.min(pf,5)*2.5+sh*2+so*.75+wr/25+cal*.25-dd*.8-penalty;
 return{id,name:STRATEGIES.find(s=>s.id===id)?.name??id,trades:pnls.length,wins,losses,winRate:wr,profitFactor:pf,netPnl:net,returnPct:ret,maxDrawdownPct:dd,avgTrade:avg,score,tradeReturnsPct:tr,sharpe:sh,sortino:so,calmar:cal,expectancy:avg,turnoverPct:turn};
}
function closePnl(raw:number,p:{side:1|-1;entry:number;qty:number},fee:number,slip:number){const exit=raw*(1-p.side*slip),gross=p.side*(exit-p.entry)*p.qty,fees=(Math.abs(p.entry*p.qty)+Math.abs(exit*p.qty))*fee;return gross-fees;}
function simulate(c:Candle[],id:string,cfg:BacktestConfig,start:number,end:number):StrategyResult{
 let equity=cfg.initialCapital,peak=equity,maxDd=0;const pnls:number[]=[],tr:number[]=[];let open:{side:1|-1;entry:number;stop:number;target:number;qty:number;bars:number}|null=null;const fee=cfg.feeBps/10000,slip=cfg.slippageBps/10000;
 for(let i=Math.max(150,start);i<end;i++){const bar=c[i];let closed=false;if(open){open.bars++;const stop=open.side===1?bar.low<=open.stop:bar.high>=open.stop,tp=open.side===1?bar.high>=open.target:bar.low<=open.target;if(stop||tp||open.bars>=cfg.maxBarsInTrade){const raw=stop?open.stop:tp?open.target:bar.close,pnl=closePnl(raw,open,fee,slip);tr.push(equity?100*pnl/equity:0);pnls.push(pnl);equity+=pnl;open=null;closed=true;}}
  if(!open&&!closed){const w=c.slice(Math.max(0,i-LOOKBACK),i),side=signal(id,w);if(side){const entry=bar.open*(1+side*slip),risk=Math.max(atr(w)*cfg.stopAtr,entry*.0015),rr=id==='production'?1.8:cfg.rewardRisk,stop=entry-side*risk,target=entry+side*risk*rr,riskBudget=Math.max(0,equity)*cfg.riskPerTradePct/100,riskQty=riskBudget/risk,maxNotional=Math.max(0,equity)*cfg.maxPositionPct/100*Math.max(1,cfg.leverage),qty=Math.min(riskQty,maxNotional/entry);if(qty>0)open={side,entry,stop,target,qty,bars:0};}}
  peak=Math.max(peak,equity);maxDd=Math.max(maxDd,peak?(peak-equity)/peak*100:0);
 }
 if(open){const pnl=closePnl(c[end-1].close,open,fee,slip);tr.push(equity?100*pnl/equity:0);pnls.push(pnl);equity+=pnl;}return summarize(id,pnls,cfg.initialCapital,maxDd,tr);
}
function intervalMs(interval:string){const m=interval.match(/^(\d+)([mhdw])$/i);if(!m)throw new Error(`Unsupported interval: ${interval}`);const n=Number(m[1]),u=m[2].toLowerCase();return n*(u==='m'?60000:u==='h'?3600000:u==='d'?86400000:604800000);}
export async function fetchHistoricalCandles(symbol='BTCUSDT',interval='5m',limit=MAX_HISTORY_BARS):Promise<Candle[]>{const target=Math.min(MAX_HISTORY_BARS,Math.max(MIN_HISTORY,limit)),ms=intervalMs(interval),start=Math.max(0,Date.now()-target*ms),rows:unknown[][]=[];let cursor=start;while(rows.length<target){const n=Math.min(1000,target-rows.length),url=`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&startTime=${cursor}&limit=${n}`,res=await fetch(url,{headers:{Accept:'application/json'}});if(!res.ok)throw new Error(`Historical market data request failed (${res.status}).`);const batch=await res.json() as unknown[][];if(!batch.length)break;rows.push(...batch);const last=Number(batch[batch.length-1]?.[0]);if(!Number.isFinite(last))break;cursor=last+ms;if(batch.length<n)break;await new Promise(r=>setTimeout(r,80));}const seen=new Set<number>(),now=Date.now();return rows.map(r=>({openTime:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})).filter(c=>[c.openTime,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.openTime+ms<=now&&!seen.has(c.openTime)&&seen.add(c.openTime)).sort((a,b)=>a.openTime-b.openTime).slice(-target);}
function mc(ret:number[],runs=5000,seed=0x7a11){if(!ret.length)return{simulations:runs,probabilityOfLoss:100,medianReturnPct:0,p05ReturnPct:0,p95MaxDrawdownPct:0};let s=seed>>>0;const rnd=()=>{s=(1664525*s+1013904223)>>>0;return s/4294967296};const finals:number[]=[],dds:number[]=[];for(let k=0;k<runs;k++){let eq=1,peak=1,dd=0;for(let i=0;i<ret.length;i++){const r=ret[Math.floor(rnd()*ret.length)]/100;eq*=1+r;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak*100);}finals.push((eq-1)*100);dds.push(dd);}finals.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);return{simulations:runs,probabilityOfLoss:finals.filter(x=>x<0).length/runs*100,medianReturnPct:finals[Math.floor(runs*.5)]??0,p05ReturnPct:finals[Math.floor(runs*.05)]??0,p95MaxDrawdownPct:dds[Math.floor(runs*.95)]??0};}

function aggregateFolds(id:string,folds:StrategyResult[]):StrategyResult{
 if(!folds.length)return summarize(id,[],10000,0,[]);
 const trades=folds.reduce((a,b)=>a+b.trades,0),wins=folds.reduce((a,b)=>a+b.wins,0),losses=folds.reduce((a,b)=>a+b.losses,0),returns=folds.flatMap(f=>f.tradeReturnsPct),avgReturn=mean(folds.map(f=>f.returnPct)),avgPf=mean(folds.map(f=>f.profitFactor)),avgDd=mean(folds.map(f=>f.maxDrawdownPct)),stability=folds.filter(f=>f.returnPct>0&&f.profitFactor>=1).length/folds.length;
 return {...folds[folds.length-1],trades,wins,losses,winRate:trades?wins/trades*100:0,returnPct:avgReturn,profitFactor:avgPf,maxDrawdownPct:avgDd,tradeReturnsPct:returns,score:mean(folds.map(f=>f.score))+stability*3};
}

export async function runValidation(symbol='BTCUSDT',interval='5m',cfg:Partial<BacktestConfig>={},selectedStrategyId?:string):Promise<ValidationReport>{
 const config={...DEFAULT_BACKTEST_CONFIG,...cfg},candles=await fetchHistoricalCandles(symbol,interval,MAX_HISTORY_BARS);if(candles.length<MIN_HISTORY)throw new Error(`Need at least ${MIN_HISTORY.toLocaleString()} completed candles; received ${candles.length.toLocaleString()}.`);
 const ms=intervalMs(interval),gaps=candles.slice(1).filter((x,i)=>x.openTime-candles[i].openTime!==ms).length,dup=candles.length-new Set(candles.map(x=>x.openTime)).size,duration=(candles[candles.length-1].openTime-candles[0].openTime)/86400000;
 const testStart=Math.floor(candles.length*.5),preOos=candles.slice(0,testStart),trainBars=Math.floor(preOos.length*.6),validationBars=preOos.length-trainBars,testBars=candles.length-testStart;
 const candidates=STRATEGIES.map(s=>s.id),foldsPerStrategy=new Map<string,StrategyResult[]>();
 for(const id of candidates){const folds:StrategyResult[]=[];const fold1Start=Math.floor(trainBars*.55),fold1End=trainBars;const fold2Start=Math.floor(trainBars*.7),fold2End=preOos.length;const windows=[[fold1Start,fold1End],[fold2Start,fold2End]];for(const [a,b] of windows){if(b-a<MIN_VAL)continue;folds.push(simulate(candles,id,config,a,b));}foldsPerStrategy.set(id,folds);}
 const ranked=STRATEGIES.map(s=>aggregateFolds(s.id,foldsPerStrategy.get(s.id)??[])).sort((a,b)=>b.score-a.score);
 const chosenId=selectedStrategyId&&candidates.includes(selectedStrategyId as any)?selectedStrategyId:ranked[0]?.id;
 const selected=STRATEGIES.find(s=>s.id===chosenId)??STRATEGIES[0];
 const validation=aggregateFolds(selected.id,foldsPerStrategy.get(selected.id)??[]);
 const test=simulate(candles,selected.id,config,testStart,candles.length);
 const monteCarlo=mc(test.tradeReturnsPct,5000);
 const reasons:string[]=[];
 if(test.trades<MIN_TEST)reasons.push(`Out-of-sample test has only ${test.trades} trades; at least ${MIN_TEST} are required.`);
 if(test.profitFactor<MIN_PF)reasons.push(`Out-of-sample profit factor ${test.profitFactor.toFixed(2)} is below ${MIN_PF.toFixed(2)}.`);
 if(test.returnPct<=0)reasons.push(`Out-of-sample return ${test.returnPct.toFixed(2)}% is not positive.`);
 if(test.maxDrawdownPct>MAX_DD)reasons.push(`Out-of-sample max drawdown ${test.maxDrawdownPct.toFixed(2)}% exceeds ${MAX_DD.toFixed(0)}%.`);
 if(monteCarlo.probabilityOfLoss>MAX_MC)reasons.push(`Monte Carlo loss probability ${monteCarlo.probabilityOfLoss.toFixed(1)}% exceeds ${MAX_MC.toFixed(0)}%.`);
 const gate:ValidationGate={status:reasons.length?'REJECTED':'VALIDATED',reasons,minimumTestTrades:MIN_TEST,minimumProfitFactor:MIN_PF,minimumTestReturnPct:0,maximumTestDrawdownPct:MAX_DD,maximumMonteCarloLossProbability:MAX_MC};
 return{symbol,interval,candles:candles.length,dataQuality:{startTime:candles[0].openTime,endTime:candles[candles.length-1].openTime,durationDays:duration,expectedIntervalMinutes:ms/60000,gaps,duplicateTimestamps:dup},costs:{feeBps:config.feeBps,slippageBps:config.slippageBps},strategies:ranked,walkForward:{trainBars,validationBars,testBars,selectedStrategy:selected.name,validation,test},monteCarlo,gate,generatedAt:new Date().toISOString(),research:{asOf:new Date().toISOString(),dataWindowBars:candles.length,selectionMethod:'Two-fold pre-OOS stability ranking; final 50% remains untouched OOS',coverage:['fees','slippage','walk-forward','multi-fold stability','Monte Carlo']}};
}
