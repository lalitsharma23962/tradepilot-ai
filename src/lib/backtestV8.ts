import { fetchHistoricalCandles, type Candle, type BacktestConfig, type StrategyResult, type ValidationReport } from './backtestV6';
import { TRADING_CONFIG } from './tradingConfig';

const LOOK=TRADING_CONFIG.lookback;
const mean=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function atr(c:Candle[],p=20){const s=c.slice(-(p+1));return mean(s.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-s[i].close),Math.abs(x.low-s[i].close))));}
function summarize(id:string,rs:number[],initial:number):StrategyResult{const wins=rs.filter(x=>x>0),losses=rs.filter(x=>x<0),gp=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0)),pf=gl?gp/gl:0;let e=initial,p=initial,dd=0;for(const r of rs){e*=1+r/100;p=Math.max(p,e);dd=Math.max(dd,(p-e)/p*100);}const ret=(e/initial-1)*100,wr=rs.length?wins.length/rs.length*100:0,avg=mean(rs);return{id,name:id,trades:rs.length,wins:wins.length,losses:losses.length,winRate:wr,profitFactor:pf,netPnl:e-initial,returnPct:ret,maxDrawdownPct:dd,avgTrade:avg,score:ret+Math.min(pf,5)*2.5+wr/25-dd*.8,tradeReturnsPct:rs,sharpe:0,sortino:0,calmar:dd?ret/dd:0,expectancy:avg,turnoverPct:rs.reduce((a,b)=>a+Math.abs(b),0)};}
function simulate(c:Candle[],cfg:BacktestConfig,start:number,end:number,id='production'){let equity=cfg.initialCapital,peak=equity,dd=0;const rs:number[]=[];let open:null|{side:1|-1;entry:number;stop:number;target:number;qty:number;bars:number}=null;const fee=cfg.feeBps/10000,slip=cfg.slippageBps/10000,roundTrip=2*(cfg.feeBps+cfg.slippageBps)/10000;for(let i=Math.max(start,200);i<end;i++){
  const b=c[i],a=atr(c.slice(Math.max(0,i-60),i)),hist=c.slice(Math.max(0,i-LOOK),i);
  if(open){open.bars++;const stopHit=open.side===1?b.low<=open.stop:b.high>=open.stop,targetHit=open.side===1?b.high>=open.target:b.low<=open.target,timeout=open.bars>=cfg.maxBarsInTrade;
   if(stopHit||targetHit||timeout){const raw=stopHit?open.stop:targetHit?open.target:b.close,exit=raw*(1-open.side*slip),gross=open.side*(exit-open.entry)*open.qty,fees=(Math.abs(open.entry*open.qty)+Math.abs(exit*open.qty))*fee,pnl=gross-fees;rs.push(equity?100*pnl/equity:0);equity+=pnl;open=null}
  }
  if(!open){const side=signal(id,hist,cfg);if(side){const entry=b.open*(1+side*slip),risk=Math.max(a*cfg.stopAtr,entry*roundTrip*1.5),riskBudget=Math.max(equity,0)*cfg.riskPerTradePct/100,maxNotional=Math.max(equity,0)*cfg.maxPositionPct/100*Math.max(1,cfg.leverage),riskQty=riskBudget/risk,q=Math.min(riskQty,maxNotional/entry),rr=id==='production'?2.5:(cfg.rewardRisk??2.5);if(q>0){open={side,entry,stop:entry-side*risk,target:entry+side*(risk*rr+entry*roundTrip),qty:q,bars:0}}}}
  peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak*100);
 }
 return summarize(id,rs,cfg.initialCapital);
}
