import { query, execute, resetDatabase } from './db';
import { getAccount, getPositions, getTrades } from './repository';
import { fetchLatestBars, type MarketBar } from './marketData';
import { evaluateProductionStrategy, type StrategySignal } from './strategy';
import { TRADING_CONFIG } from './tradingConfig';
import { runnerProtectedStop } from './runnerProtection';
import type { AiRecommendation, MarketTick, Position } from './types';

const SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];
const TIMEFRAMES=TRADING_CONFIG.timeframes;
const POLL_MS=15000;
const LOCKOUT_MS=24*60*60*1000;
const intervalMs=(interval:string)=>{const m=interval.match(/^(\d+)([mhd])$/i);if(!m)throw new Error(`Unsupported interval: ${interval}`);const n=Number(m[1]),u=m[2].toLowerCase();return n*(u==='m'?60000:u==='h'?3600000:86400000);};
const contextFor=(interval:string)=>TRADING_CONFIG.lookback+TRADING_CONFIG.capacitySamples*(TRADING_CONFIG.maxBarsInTrade[interval]??240)+300;
interface MarketState{symbol:string;interval:string;bars:MarketBar[];updatedAt:number;}
interface Opportunity{symbol:string;interval:string;bar:MarketBar;signal:StrategySignal;quality:number;}
const states=new Map<string,MarketState>();
let tickCount=0,engineRunning=false,tickTimer:ReturnType<typeof setInterval>|null=null,snapshotTimer:ReturnType<typeof setInterval>|null=null,ticking=false,lastEntryTick=-Infinity,sessionStartEquity=TRADING_CONFIG.paperStartingCapital,accountPeakEquity=TRADING_CONFIG.paperStartingCapital,tradeDayKey='';
const stateKey=(symbol:string,interval:string)=>`${symbol}:${interval}`;
const round=(v:number,dp=2)=>{const f=10**dp;return Math.round(v*f)/f;};
const decimals=(p:number)=>p>=100?2:p>=1?4:6;
const dayKey=()=>new Date().toISOString().slice(0,10);
const mergeBars=(oldBars:MarketBar[],newBars:MarketBar[],limit:number)=>{const byTime=new Map<number,MarketBar>();for(const b of [...oldBars,...newBars])byTime.set(b.openTime,b);return [...byTime.values()].sort((a,b)=>a.openTime-b.openTime).slice(-limit);};

async function loadAll(){
 states.clear();
 for(const symbol of SYMBOLS){
  for(const interval of TIMEFRAMES){
   try{const bars=await fetchLatestBars(symbol,interval,Math.min(50000,contextFor(interval)));states.set(stateKey(symbol,interval),{symbol,interval,bars,updatedAt:Date.now()});}
   catch(err){console.warn(`[paper] no ${interval} data for ${symbol}`,err);}
  }
 }
 if(!states.size)throw new Error('No completed Binance market data is available; synthetic prices are disabled.');
}
async function refreshDue(){
 const now=Date.now();
 for(const state of states.values()){
  const last=state.bars.at(-1);if(!last)continue;
  const due=now-last.openTime>=intervalMs(state.interval);
  if(!due)continue;
  try{const latest=await fetchLatestBars(state.symbol,state.interval,1000);state.bars=mergeBars(state.bars,latest,Math.min(50000,contextFor(state.interval)));state.updatedAt=now;}catch(err){console.warn(`[paper] refresh skipped ${state.symbol} ${state.interval}`,err);}
 }
}
async function daily(){const key=dayKey();if(key!==tradeDayKey){tradeDayKey=key;sessionStartEquity=(await getAccount()).equity;}}
export function getTickCount(){return tickCount;}
export function isEngineRunning(){return engineRunning;}
export function getMarketTicks():MarketTick[]{const out:MarketTick[]=[];for(const symbol of SYMBOLS){const state=states.get(stateKey(symbol,'5m'))??Array.from(states.values()).find(s=>s.symbol===symbol);const a=state?.bars.at(-1),b=state?.bars.at(-2);if(a)out.push({symbol:symbol.replace('USDT','/USDT'),price:round(a.close,decimals(a.close)),change_pct:b?round((a.close-b.close)/b.close*100,2):0,ts:a.openTime});}return out;}
export function getPriceHistory(symbol:string,points=TRADING_CONFIG.lookback){const key=symbol.replace('/','').toUpperCase(),s=states.get(stateKey(key,'5m'))??Array.from(states.values()).find(x=>x.symbol===key);return s?s.bars.slice(-points).map(b=>({ts:b.openTime,price:b.close})):[];}
async function accountPeak(){const rows=await query<{peak:number}>(`SELECT COALESCE(MAX(equity),0) AS peak FROM tp_snapshots;`);accountPeakEquity=Math.max(TRADING_CONFIG.paperStartingCapital,Number(rows[0]?.peak)||0,(await getAccount()).equity);}
async function riskPause(reason:string){for(const p of await getPositions())await closePosition(p.id,undefined,`CAPITAL PROTECTION: ${reason}`);const until=new Date(Date.now()+LOCKOUT_MS).toISOString();engineRunning=false;if(tickTimer)clearInterval(tickTimer);if(snapshotTimer)clearInterval(snapshotTimer);tickTimer=null;snapshotTimer=null;await execute(`UPDATE tp_account SET bot_status='STOPPED',risk_pause_until=$1,last_tick_at=now() WHERE id=1;`,[until]);}
function profile(a:Awaited<ReturnType<typeof getAccount>>){const base=Math.max(TRADING_CONFIG.minScore,Math.min(95,Math.round(a.confidence_threshold_pct||TRADING_CONFIG.minScore)));if(a.risk_level==='Conservative')return{minScore:Math.max(92,base),risk:.15,allocation:15};if(a.risk_level==='Aggressive')return{minScore:base,risk:.35,allocation:20};return{minScore:base,risk:TRADING_CONFIG.riskPerTradePct,allocation:TRADING_CONFIG.maxAllocationPct};}
async function consecutiveLosses(){const trades=await getTrades(100);let n=0;for(const t of trades){if(t.pnl<0)n++;else break;}return n;}

async function scanOpportunities(a:Awaited<ReturnType<typeof getAccount>>,held:Set<string>):Promise<Opportunity[]>{
 const p=profile(a),out:Opportunity[]=[];
 for(const state of states.values()){
  if(held.has(state.symbol))continue;
  const bar=state.bars.at(-1);if(!bar)continue;
  const horizon=TRADING_CONFIG.maxBarsInTrade[state.interval]??240;
  const signal=evaluateProductionStrategy(state.bars,{minScore:p.minScore,lookback:TRADING_CONFIG.lookback,feeBps:a.fee_bps,slippageBps:a.slippage_bps,minStopAtr:TRADING_CONFIG.minStopAtr,maxStructuralRiskAtr:TRADING_CONFIG.maxStructuralRiskAtr,maxCostFractionOfRisk:TRADING_CONFIG.maxCostFractionOfRisk,swingLookback:TRADING_CONFIG.swingLookback,capacityHorizonBars:horizon,capacityBars:state.bars} as any);
  if(signal.action==='WAIT'||signal.score<p.minScore)continue;
  const risk=Math.abs(signal.entry-signal.stopLoss);if(!(risk>0)||!Number.isFinite(risk))continue;
  const costR=(signal.entry*2*(a.fee_bps+a.slippage_bps)/10000)/risk;
  const quality=signal.score*Math.max(0,1-costR)*Math.min(1.2,signal.riskReward/3);
  out.push({symbol:state.symbol,interval:state.interval,bar,signal,quality});
 }
 return out.sort((x,y)=>y.quality-x.quality);
}

async function tick(){if(!engineRunning||ticking)return;ticking=true;try{
 await daily();await refreshDue();
 const closed=new Set<string>();
 for(const p of await getPositions()){
  const state=states.get(stateKey(p.symbol,'5m'))??Array.from(states.values()).find(s=>s.symbol===p.symbol);const bar=state?.bars.at(-1);if(!bar)continue;
  const price=round(bar.close,decimals(bar.close));await execute(`UPDATE tp_positions SET current_price=$1,unrealized_pnl=$2 WHERE id=$3;`,[price,pnl(p,price),p.id]);
  const stop=p.side==='LONG'?bar.low<=p.stop_loss:bar.high>=p.stop_loss,target=p.side==='LONG'?bar.high>=p.take_profit:bar.low<=p.take_profit;
  if(stop||target){closed.add(p.symbol);await closePosition(p.id,stop?p.stop_loss:p.take_profit,stop?'Stop Loss':'Take Profit');}
  else{const side=p.side==='LONG'?1:-1,protectedStop=runnerProtectedStop(side,p.entry_price,p.take_profit,p.stop_loss,bar.high,bar.low);if(Number.isFinite(protectedStop)&&protectedStop!==p.stop_loss)await execute(`UPDATE tp_positions SET stop_loss=$1 WHERE id=$2;`,[round(protectedStop,decimals(p.entry_price)),p.id]);}
 }
 await equity();const a=await getAccount();const dd=accountPeakEquity>0?Math.max(0,(accountPeakEquity-a.equity)/accountPeakEquity*100):0;const dailyDd=sessionStartEquity>0?Math.max(0,(sessionStartEquity-a.equity)/sessionStartEquity*100):0;
 if(dailyDd>=Math.min(a.loss_limit_pct,TRADING_CONFIG.maxDailyLossPct)){await riskPause(`daily loss limit ${Math.min(a.loss_limit_pct,TRADING_CONFIG.maxDailyLossPct).toFixed(2)}% reached`);return;}
 if(dd>=TRADING_CONFIG.maxAccountDrawdownPct){await riskPause(`account drawdown ${dd.toFixed(2)}% reached`);return;}
 if(await consecutiveLosses()>=TRADING_CONFIG.maxConsecutiveLosses){await riskPause(`${TRADING_CONFIG.maxConsecutiveLosses} consecutive losses reached`);return;}
 const ps=await getPositions();if(ps.length<Math.min(a.max_positions,TRADING_CONFIG.maxPositions)&&tickCount-lastEntryTick>=TRADING_CONFIG.cooldownBars)await openBest(a,ps,closed);
 await equity();await execute(`UPDATE tp_account SET last_tick_at=now() WHERE id=1;`);tickCount++;
 }catch(err){console.error('[paper] tick error',err);}finally{ticking=false;}}

async function openBest(a:Awaited<ReturnType<typeof getAccount>>,positions:Position[],closed:Set<string>){
 const held=new Set([...positions.map(x=>x.symbol),...closed]),opps=await scanOpportunities(a,held),best=opps[0];if(!best)return;
 const {symbol,interval,bar,signal}=best,side=signal.action==='LONG'?1:-1,slip=a.slippage_bps/10000,entry=round(bar.close*(1+side*slip),decimals(bar.close)),risk=Math.abs(signal.entry-signal.stopLoss),roundTripCost=2*(a.fee_bps+a.slippage_bps)/10000,riskPct=profile(a).risk,riskBudget=a.equity*riskPct/100,allocation=Math.min(a.max_allocation_pct,profile(a).allocation,TRADING_CONFIG.maxAllocationPct),maxNotional=a.equity*allocation/100,q=Math.min(riskBudget/Math.max(risk+entry*roundTripCost,entry*1e-9),maxNotional/entry),notional=q*entry,leverage=Math.min(Math.max(1,a.leverage),TRADING_CONFIG.maxLeverage),margin=notional/leverage;
 if(!Number.isFinite(q)||q<=0||notional<TRADING_CONFIG.minNotionalUsd||margin>a.cash||!Number.isFinite(signal.riskReward)||signal.riskReward<=0)return;
 const atr=Math.max(Math.abs(signal.entry-signal.stopLoss)/Math.max(TRADING_CONFIG.minStopAtr,1),1e-9),liqDistanceAtr=(entry/leverage)/atr;if(leverage>1&&liqDistanceAtr<TRADING_CONFIG.minLiquidationDistanceAtr)return;
 const stop=round(side===1?entry-risk:entry+risk,decimals(entry)),targetPrice=round(side===1?entry+risk*signal.riskReward:entry-risk*signal.riskReward,decimals(entry));
 await execute(`INSERT INTO tp_positions (symbol,side,quantity,entry_price,current_price,notional,unrealized_pnl,stop_loss,take_profit,strategy,status) VALUES ($1,$2,$3,$4,$4,$5,0,$6,$7,$8,'OPEN');`,[symbol,signal.action,q,entry,notional,stop,targetPrice,`${signal.strategy} ${interval} ${signal.riskReward.toFixed(1)}R`]);
 await execute(`UPDATE tp_account SET cash=cash-$1 WHERE id=1;`,[margin]);lastEntryTick=tickCount;
}
function pnl(p:Position,price:number){return round((p.side==='LONG'?1:-1)*(price-p.entry_price)*p.quantity,2);}
async function equity(){const a=await getAccount(),ps=await getPositions(),margin=ps.reduce((x,p)=>x+p.notional/Math.max(1,a.leverage),0),u=ps.reduce((x,p)=>x+p.unrealized_pnl,0),eq=round(a.cash+margin+u,2);accountPeakEquity=Math.max(accountPeakEquity,eq);await execute(`UPDATE tp_account SET equity=$1,total_pnl=$2 WHERE id=1;`,[eq,round(a.realized_pnl+u,2)]);}
export async function startEngine(){if(engineRunning)return{ok:false,message:'Engine is already running.'};const account=await getAccount();if(account.bot_status==='RUNNING')return{ok:false,message:'Bot is already RUNNING.'};if(account.risk_pause_until&&new Date(account.risk_pause_until).getTime()>Date.now())return{ok:false,message:`Risk lockout active until ${new Date(account.risk_pause_until).toLocaleString()}.`};await loadAll();await accountPeak();await daily();sessionStartEquity=account.equity;engineRunning=true;await execute(`UPDATE tp_account SET bot_status='RUNNING',started_at=now(),last_tick_at=now() WHERE id=1;`);tickTimer=setInterval(()=>void tick(),POLL_MS);snapshotTimer=setInterval(()=>void snapshot(),15000);void tick();return{ok:true,message:'Paper engine started in v36 multi-timeframe mode using completed Binance candles, dynamic 2R-4R targets, cost-aware sizing and strict capital protection.'};}
export async function stopEngine(){engineRunning=false;if(tickTimer)clearInterval(tickTimer);if(snapshotTimer)clearInterval(snapshotTimer);tickTimer=null;snapshotTimer=null;await execute(`UPDATE tp_account SET bot_status='STOPPED',last_tick_at=now() WHERE id=1;`);return{ok:true,message:'Paper bot stopped.'};}
export async function restartEngine(){await stopEngine();await new Promise(r=>setTimeout(r,250));return startEngine();}
export async function closePosition(id:string,exitPrice?:number,reason?:string){const rows=await query<Record<string,unknown>>(`SELECT * FROM tp_positions WHERE id=$1 AND status='OPEN';`,[id]);if(!rows.length)return{ok:false,message:'Position not found or already closed.'};const r=rows[0],p={id:String(r.id),symbol:String(r.symbol),side:r.side as 'LONG'|'SHORT',quantity:Number(r.quantity),entry_price:Number(r.entry_price),current_price:Number(r.current_price),notional:Number(r.notional),unrealized_pnl:Number(r.unrealized_pnl),stop_loss:Number(r.stop_loss),take_profit:Number(r.take_profit),strategy:String(r.strategy??'Strategy'),opened_at:String(r.opened_at)},a=await getAccount(),state=states.get(stateKey(p.symbol,'5m'))??Array.from(states.values()).find(s=>s.symbol===p.symbol),bar=state?.bars.at(-1),raw=exitPrice??bar?.close??p.current_price,slip=a.slippage_bps/10000,exit=round(raw*(1-(p.side==='LONG'?slip:-slip)),decimals(p.entry_price)),dir=p.side==='LONG'?1:-1,gross=dir*(exit-p.entry_price)*p.quantity,fees=(p.entry_price*p.quantity+exit*p.quantity)*(a.fee_bps/10000),net=round(gross-fees,2),margin=p.notional/Math.max(1,a.leverage);await execute(`INSERT INTO tp_trades (symbol,side,quantity,entry_price,exit_price,pnl,return_pct,strategy,status,opened_at,closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CLOSED',$9,now());`,[p.symbol,p.side,p.quantity,p.entry_price,exit,net,round(margin?net/margin*100:0,2),p.strategy,p.opened_at]);await execute(`DELETE FROM tp_positions WHERE id=$1;`,[p.id]);await execute(`UPDATE tp_account SET cash=cash+$1,realized_pnl=realized_pnl+$2 WHERE id=1;`,[margin+net,net]);await equity();return{ok:true,message:`Position closed (${reason??'Manual'}). Net PnL after fees/slippage: ${net.toFixed(2)}`};}
async function snapshot(){if(!engineRunning)return;try{const a=await getAccount(),ps=await getPositions();await execute(`INSERT INTO tp_snapshots (equity,cash,open_value,unrealized_pnl,realized_pnl,ts) VALUES ($1,$2,$3,$4,$5,now());`,[a.equity,a.cash,ps.reduce((x,p)=>x+p.notional,0),ps.reduce((x,p)=>x+p.unrealized_pnl,0),a.realized_pnl]);}catch(err){console.error('[paper] snapshot error',err);}}
export async function closeAllPositions(){const ps=await getPositions();for(const p of ps)await closePosition(p.id,undefined,'Close All');return{ok:true,message:`Closed ${ps.length} positions.`};}
export async function resetAccount(){if(engineRunning)await stopEngine();await resetDatabase();states.clear();tickCount=0;lastEntryTick=-Infinity;tradeDayKey=dayKey();sessionStartEquity=TRADING_CONFIG.paperStartingCapital;accountPeakEquity=TRADING_CONFIG.paperStartingCapital;return{ok:true,message:`Account reset to $${TRADING_CONFIG.paperStartingCapital}.`};}
export async function getAiRecommendation(symbol?:string):Promise<AiRecommendation>{const gate=await query<{status:string}>(`SELECT status FROM tp_validation_gate WHERE id=1;`);if(gate[0]?.status!=='VALIDATED')return{symbol:(symbol??'BTCUSDT').replace('USDT','/USDT'),action:'WAIT',confidence:0,threshold:TRADING_CONFIG.minScore,entry:0,stop_loss:0,take_profit:0,risk_score:100,explanation:'Paper trading is locked until the current v36 validation gate passes.'};const key=(symbol??'BTCUSDT').replace('/','').toUpperCase(),a=await getAccount();let statesForSymbol=[...states.values()].filter(s=>s.symbol===key);if(!statesForSymbol.length){for(const interval of TIMEFRAMES){try{const bars=await fetchLatestBars(key,interval,Math.min(50000,contextFor(interval)));states.set(stateKey(key,interval),{symbol:key,interval,bars,updatedAt:Date.now()});}catch{}}statesForSymbol=[...states.values()].filter(s=>s.symbol===key);}const opps=await scanOpportunities(a,new Set());const best=opps.find(x=>x.symbol===key);if(!best)return{symbol:key.replace('USDT','/USDT'),action:'WAIT',confidence:0,threshold:Math.max(TRADING_CONFIG.minScore,a.confidence_threshold_pct),entry:0,stop_loss:0,take_profit:0,risk_score:100,explanation:'No statistically qualified opportunity across the available timeframes.'};return{symbol:key.replace('USDT','/USDT'),action:best.signal.action==='LONG'?'LONG':'SHORT',confidence:best.signal.confidence,threshold:Math.max(TRADING_CONFIG.minScore,a.confidence_threshold_pct),entry:best.signal.entry,stop_loss:best.signal.stopLoss,take_profit:best.signal.takeProfit,risk_score:100-best.signal.confidence,explanation:`${best.interval} ${best.signal.strategy}: ${best.signal.reasons.join('. ')}`};}
