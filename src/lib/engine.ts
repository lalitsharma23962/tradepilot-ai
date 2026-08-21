import { query, execute, resetDatabase } from './db';
import { getAccount, getPositions } from './repository';
import { fetchMarketBars, type MarketBar } from './marketData';
import { evaluateV39, type StrategySignalV39 } from './strategyV39';
import type { AiRecommendation, MarketTick, Position } from './types';

const SYMBOL = 'BTC/USDT';
const DATA_SYMBOL = 'BTCUSDT';
const MIN_CONVICTION_SCORE = 82;
const COOLDOWN_BARS = 12;
const priceStates = new Map<string, { price: number; history: { ts: number; price: number }[] }>();
let latestSignal: StrategySignalV39 | null = null;
let latestBars: MarketBar[] = [];
let tickCount = 0;
let engineRunning = false;
let ticking = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let lastSignalBar = 0;
let lastEntryBar = 0;

function round(v: number, dp = 2) { const f = 10 ** dp; return Math.round(v * f) / f; }
function decimals(price: number) { return price >= 100 ? 2 : 4; }
function slippagePrice(price: number, side: 'LONG' | 'SHORT', bps: number, isEntry: boolean) {
  const adverse = (bps / 10000) * price;
  if (side === 'LONG') return isEntry ? price + adverse : price - adverse;
  return isEntry ? price - adverse : price + adverse;
}
function calcPnl(pos: Position, price: number) { return round((pos.side === 'LONG' ? 1 : -1) * (price - pos.entry_price) * pos.quantity, 2); }

async function riskBlocked(account: Awaited<ReturnType<typeof getAccount>>): Promise<boolean> {
  if (account.risk_pause_until && new Date(account.risk_pause_until).getTime() > Date.now()) return true;
  const rows = await query<{ pnl: string | number; losses: string | number }>(
    `SELECT COALESCE(SUM(pnl),0) AS pnl, COUNT(*) FILTER (WHERE pnl < 0) AS losses
     FROM tp_trades WHERE closed_at >= date_trunc('day', now());`
  );
  const todayPnl = Number(rows[0]?.pnl ?? 0);
  const dailyLossPct = account.equity > 0 ? Math.max(0, -todayPnl / account.equity * 100) : 0;
  if (dailyLossPct >= account.loss_limit_pct) return true;

  const recent = await query<{ pnl: string | number }>(
    `SELECT pnl FROM tp_trades ORDER BY closed_at DESC LIMIT 4;`
  );
  const consecutiveLosses = recent.length >= 4 && recent.every(r => Number(r.pnl) < 0);
  return consecutiveLosses;
}

function setLatestPrice(price: number, ts: number) {
  const old = priceStates.get(SYMBOL) ?? { price, history: [] };
  old.price = price; old.history.push({ ts, price });
  if (old.history.length > 500) old.history.shift();
  priceStates.set(SYMBOL, old);
}

export function getMarketTicks(): MarketTick[] {
  const p = priceStates.get(SYMBOL);
  if (!p) return [];
  const prev = p.history.length > 1 ? p.history[p.history.length - 2].price : p.price;
  return [{ symbol: SYMBOL, price: round(p.price, decimals(p.price)), change_pct: prev ? round((p.price - prev) / prev * 100, 2) : 0, ts: p.history.at(-1)?.ts ?? Date.now() }];
}
export function getPriceHistory(symbol: string, points = 60) { if (symbol !== SYMBOL) return []; return (priceStates.get(SYMBOL)?.history ?? []).slice(-points); }

async function refreshMarket(): Promise<{ bars5: MarketBar[]; bars1h: MarketBar[]; bars4h: MarketBar[] }> {
  const [bars5, bars1h, bars4h] = await Promise.all([
    fetchMarketBars(DATA_SYMBOL, '5m', 500),
    fetchMarketBars(DATA_SYMBOL, '1h', 210),
    fetchMarketBars(DATA_SYMBOL, '4h', 210),
  ]);
  latestBars = bars5;
  const last = bars5.at(-1);
  if (last) setLatestPrice(last.close, last.openTime);
  return { bars5, bars1h, bars4h };
}

export async function startEngine(): Promise<{ ok: boolean; message: string }> {
  if (engineRunning) return { ok: false, message: 'Engine is already running. Duplicate start rejected.' };
  const account = await getAccount();
  if (account.bot_status === 'RUNNING') return { ok: false, message: 'Bot is already RUNNING. Duplicate start rejected.' };
  try { await refreshMarket(); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : 'Live market data unavailable.' }; }
  engineRunning = true;
  await execute(`UPDATE tp_account SET bot_status='RUNNING', started_at=now(), last_tick_at=now() WHERE id=1;`);
  tickTimer = setInterval(tick, 5000);
  snapshotTimer = setInterval(takeSnapshot, 10000);
  setTimeout(tick, 50);
  return { ok: true, message: 'Paper bot started on completed BTCUSDT candles.' };
}
export async function stopEngine(): Promise<{ ok: boolean; message: string }> {
  engineRunning=false;
  if(tickTimer){clearInterval(tickTimer);tickTimer=null;}
  if(snapshotTimer){clearInterval(snapshotTimer);snapshotTimer=null;}
  await execute(`UPDATE tp_account SET bot_status='STOPPED', last_tick_at=now() WHERE id=1;`);
  return {ok:true,message:'Paper bot stopped.'};
}
export async function restartEngine(){await stopEngine(); await new Promise(r=>setTimeout(r,200)); return startEngine();}
export function isEngineRunning(){return engineRunning;}

async function tick() {
  if(!engineRunning||ticking)return; ticking=true;
  try {
    const {bars5,bars1h,bars4h}=await refreshMarket();
    const account=await getAccount();
    const positions=await getPositions();
    for(const pos of positions){
      const market=priceStates.get(pos.symbol); if(!market)continue;
      const price=round(market.price,decimals(pos.entry_price));
      const pnl=calcPnl(pos,price);
      await execute(`UPDATE tp_positions SET current_price=$1, unrealized_pnl=$2 WHERE id=$3;`,[price,pnl,pos.id]);
      const sl=pos.side==='LONG'?price<=pos.stop_loss:price>=pos.stop_loss;
      const tp=pos.side==='LONG'?price>=pos.take_profit:price<=pos.take_profit;
      if(sl||tp) await closePosition(pos.id,price,sl?'Stop Loss':'Take Profit');
    }
    await recomputeEquity();
    const open=(await getPositions()).length;
    const currentBar=bars5.at(-1)?.openTime??0;
    const configuredThreshold=Number(account.confidence_threshold_pct);
    const convictionThreshold=Math.max(MIN_CONVICTION_SCORE,Number.isFinite(configuredThreshold)?configuredThreshold:MIN_CONVICTION_SCORE);
    const cooldownMs=COOLDOWN_BARS*5*60*1000;
    const cooldownActive=lastEntryBar>0 && currentBar-lastEntryBar<cooldownMs;
    if(open<account.max_positions && currentBar!==lastSignalBar && !cooldownActive){
      latestSignal=evaluateV39(bars5,{htf1h:bars1h,htf4h:bars4h,minRiskReward:2,minScore:convictionThreshold});
      lastSignalBar=currentBar;
      if(latestSignal.action!=='WAIT' && latestSignal.score>=convictionThreshold) await tryOpenPosition(account,latestSignal,currentBar);
    }
    tickCount++;
    await execute(`UPDATE tp_account SET last_tick_at=$1 WHERE id=1;`,[new Date().toISOString()]);
  }catch(err){console.error('[engine] tick error:',err);}finally{ticking=false;}
}

async function tryOpenPosition(account: Awaited<ReturnType<typeof getAccount>>, signal: StrategySignalV39, signalBar: number) {
  const positions=await getPositions(); if(positions.length>=account.max_positions)return;
  if(await riskBlocked(account)) return;
  if(signal.action==='WAIT'||signal.riskReward!==2||signal.score<MIN_CONVICTION_SCORE)return;
  const market=priceStates.get(SYMBOL); if(!market)return;
  const rawEntry=signal.entry;
  const entry=round(slippagePrice(rawEntry,signal.action,account.slippage_bps,true),2);
  const riskDistance=Math.abs(signal.entry-signal.stopLoss);
  if(!Number.isFinite(riskDistance)||riskDistance<=0)return;
  const riskBudget=account.equity*(0.5/100);
  const qtyByRisk=riskBudget/riskDistance;
  const allocation=Math.min(account.max_allocation_pct,account.default_allocation_pct)/100;
  const maxQty=(account.equity*allocation)/entry;
  const quantity=round(Math.min(qtyByRisk,maxQty),6);
  if(quantity<=0)return;
  const notional=round(entry*quantity,2);
  if(notional<5||notional>account.cash)return;
  const stop=round(signal.action==='LONG'?entry-riskDistance:entry+riskDistance,2);
  const targetDistance=riskDistance*2;
  const target=round(signal.action==='LONG'?entry+targetDistance:entry-targetDistance,2);
  await execute(`INSERT INTO tp_positions (symbol,side,quantity,entry_price,current_price,notional,unrealized_pnl,stop_loss,take_profit,strategy,status) VALUES ($1,$2,$3,$4,$4,$5,0,$6,$7,$8,'OPEN');`,[SYMBOL,signal.action,quantity,entry,notional,stop,target,'Trend Pullback v39']);
  await execute(`UPDATE tp_account SET cash=cash-$1 WHERE id=1;`,[notional]);
  lastEntryBar=signalBar;
}

async function recomputeEquity(){
  const account=await getAccount(),positions=await getPositions();
  const openValue=positions.reduce((a,p)=>a+p.notional,0),unrealized=positions.reduce((a,p)=>a+p.unrealized_pnl,0);
  await execute(`UPDATE tp_account SET equity=$1,total_pnl=$2 WHERE id=1;`,[round(account.cash+openValue+unrealized,2),round(account.realized_pnl+unrealized,2)]);
}

export async function closePosition(positionId:string,exitPrice?:number,reason?:string):Promise<{ok:boolean;message:string}>{
  const rows=await query<Record<string,unknown>>(`SELECT * FROM tp_positions WHERE id=$1 AND status='OPEN';`,[positionId]);
  if(!rows.length)return{ok:false,message:'Position not found or already closed.'};
  const r=rows[0];
  const pos={id:String(r.id),symbol:String(r.symbol),side:r.side as 'LONG'|'SHORT',quantity:Number(r.quantity),entry_price:Number(r.entry_price),current_price:Number(r.current_price),notional:Number(r.notional),unrealized_pnl:Number(r.unrealized_pnl),stop_loss:Number(r.stop_loss),take_profit:Number(r.take_profit),strategy:String(r.strategy??'Trend Pullback v39'),status:String(r.status??'OPEN'),opened_at:new Date(r.opened_at as string).toISOString()};
  const account=await getAccount(); const market=priceStates.get(pos.symbol); const rawExit=exitPrice??market?.price??pos.current_price;
  const exit=round(slippagePrice(rawExit,pos.side,account.slippage_bps,false),2);
  const gross=round((pos.side==='LONG'?1:-1)*(exit-pos.entry_price)*pos.quantity,2);
  const feeBps=account.fee_bps/10000;
  const fees=round((pos.entry_price*pos.quantity+exit*pos.quantity)*feeBps,2);
  const pnl=round(gross-fees,2), returnPct=round(pnl/pos.notional*100,2),cashReturn=round(pos.notional+pnl,2);
  await execute(`INSERT INTO tp_trades(symbol,side,quantity,entry_price,exit_price,pnl,return_pct,strategy,status,opened_at,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CLOSED',$9,now());`,[pos.symbol,pos.side,pos.quantity,pos.entry_price,exit,pnl,returnPct,pos.strategy,pos.opened_at]);
  await execute(`DELETE FROM tp_positions WHERE id=$1;`,[pos.id]);
  await execute(`UPDATE tp_account SET cash=cash+$1,realized_pnl=realized_pnl+$2 WHERE id=1;`,[cashReturn,pnl]);
  await recomputeEquity(); return{ok:true,message:`Position closed (${reason??'Manual'}). Net PnL: ${pnl.toFixed(2)}`};
}

async function takeSnapshot(){if(!engineRunning)return;try{const a=await getAccount(),p=await getPositions();await execute(`INSERT INTO tp_snapshots(equity,cash,open_value,unrealized_pnl,realized_pnl,ts) VALUES($1,$2,$3,$4,$5,now());`,[a.equity,a.cash,p.reduce((s,x)=>s+x.notional,0),p.reduce((s,x)=>s+x.unrealized_pnl,0),a.realized_pnl]);}catch(e){console.error('[engine] snapshot error:',e);}}
export async function closeAllPositions(){const p=await getPositions();for(const x of p)await closePosition(x.id,undefined,'Close All');return{ok:true,message:`Closed ${p.length} positions.`};}
export async function resetAccount(){if(engineRunning)await stopEngine();await resetDatabase();return{ok:true,message:'Account reset to $10,000.'};}

export function getAiRecommendation(symbol?:string):AiRecommendation{
  const p=priceStates.get(SYMBOL); const s=symbol&&symbol!==SYMBOL?null:latestSignal;
  if(!p||!s)return{symbol:SYMBOL,action:'WAIT',confidence:0,threshold:MIN_CONVICTION_SCORE/100,entry:0,stop_loss:0,take_profit:0,risk_score:0,explanation:'Waiting for a completed BTCUSDT candle and validated v39 setup.'};
  return{symbol:SYMBOL,action:s.action,confidence:s.score/100,threshold:MIN_CONVICTION_SCORE/100,entry:s.entry,stop_loss:s.stopLoss,take_profit:s.takeProfit,risk_score:Math.max(0,10-s.score/10),targets:s.targets.map(t=>({r:t.r,fraction:t.fraction,price:t.price})),explanation:s.reasons.join('; ')};
}
export function getTickCount(){return tickCount;}

export async function injectPositionForTest(p:{symbol:string;side:'LONG'|'SHORT';quantity:number;entry_price:number;current_price:number;notional:number;stop_loss:number;take_profit:number;strategy?:string}):Promise<string>{
  await execute(`INSERT INTO tp_positions(symbol,side,quantity,entry_price,current_price,notional,unrealized_pnl,stop_loss,take_profit,strategy,status) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9,'OPEN');`,[p.symbol,p.side,p.quantity,p.entry_price,p.current_price,p.notional,p.stop_loss,p.take_profit,p.strategy??'Test']);
  await execute(`UPDATE tp_account SET cash=cash-$1 WHERE id=1;`,[p.notional]); await recomputeEquity();
  const rows=await query<{id:string}>(`SELECT id FROM tp_positions WHERE symbol=$1 AND status='OPEN' ORDER BY opened_at DESC LIMIT 1;`,[p.symbol]); return rows[0]?.id??'';
}
export function setPriceForTest(symbol:string,price:number){if(symbol!==SYMBOL)return;setLatestPrice(price,Date.now());}
export async function evaluateExitsForTest(){
  const positions=await getPositions(); const checked:{id:string;symbol:string;side:string;price:number;sl:number;tp:number;slHit:boolean;tpHit:boolean;closed:boolean}[]=[]; let closedCount=0;
  for(const pos of positions){const p=priceStates.get(pos.symbol);if(!p){checked.push({id:pos.id,symbol:pos.symbol,side:pos.side,price:0,sl:pos.stop_loss,tp:pos.take_profit,slHit:false,tpHit:false,closed:false});continue;}const price=round(p.price,decimals(pos.entry_price));const pnl=calcPnl(pos,price);await execute(`UPDATE tp_positions SET current_price=$1,unrealized_pnl=$2 WHERE id=$3;`,[price,pnl,pos.id]);const slHit=pos.side==='LONG'?price<=pos.stop_loss:price>=pos.stop_loss,tpHit=pos.side==='LONG'?price>=pos.take_profit:price<=pos.take_profit;let closed=false;if(slHit||tpHit){closed=(await closePosition(pos.id,price,slHit?'Stop Loss':'Take Profit')).ok;if(closed)closedCount++;}checked.push({id:pos.id,symbol:pos.symbol,side:pos.side,price,sl:pos.stop_loss,tp:pos.take_profit,slHit,tpHit,closed});}
  await recomputeEquity(); return{checked,closedCount};
}
