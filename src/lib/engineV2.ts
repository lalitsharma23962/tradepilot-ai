import { query, execute, resetDatabase } from './db';
import { getAccount, getPositions } from './repository';
import type { AiRecommendation, MarketTick, Position } from './types';
import { evaluateStrategy, type StrategySignal } from './strategy';

// PAPER TRADING ONLY. This module deliberately has no exchange/broker withdrawal path.
const SYMBOLS = [
  { symbol: 'BTC/USDT', base: 68000, vol: 0.0045 }, { symbol: 'ETH/USDT', base: 3500, vol: 0.006 },
  { symbol: 'SOL/USDT', base: 145, vol: 0.008 }, { symbol: 'BNB/USDT', base: 580, vol: 0.0055 },
  { symbol: 'XRP/USDT', base: 0.62, vol: 0.009 }, { symbol: 'ADA/USDT', base: 0.45, vol: 0.0085 },
  { symbol: 'AVAX/USDT', base: 28, vol: 0.008 }, { symbol: 'LINK/USDT', base: 14.5, vol: 0.007 },
];

const ENGINE = {
  defaultMinScore: 85, minRiskReward: 1.8, maxRiskReward: 3.2, atrStopMultiple: 1.15,
  lookback: 180, cooldownTicks: 12, riskPerTradePct: 0.25, maxAllocationPct: 20,
  breakEvenAtR: 1.25, trailAtR: 2.0, trailLockR: 0.75,
};

interface PriceState { symbol: string; price: number; base: number; vol: number; rng: () => number; history: { ts: number; price: number }[]; regimeDrift: number; regimeTicks: number; }
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const priceStates = new Map<string, PriceState>();
let tickCount = 0, engineRunning = false, ticking = false;
let tickTimer: ReturnType<typeof setInterval> | null = null, snapshotTimer: ReturnType<typeof setInterval> | null = null;
let lastEntryTick = -Infinity, sessionStartEquity = 10000;

function round(v: number, dp = 2) { const f = 10 ** dp; return Math.round(v * f) / f; }
function seedPriceStates() {
  if (priceStates.size) return;
  const now = Date.now();
  for (const s of SYMBOLS) {
    const rng = mulberry32(Math.floor(s.base * 1000) + 17391); let price = s.base, regimeDrift = 0, regimeTicks = 0;
    const history: { ts: number; price: number }[] = [];
    for (let i = ENGINE.lookback - 1; i >= 0; i--) {
      regimeTicks++; if (regimeTicks >= 70) { regimeTicks = 0; const r = rng(); regimeDrift = r < 0.42 ? (rng() > 0.5 ? 0.0011 : -0.0011) : 0; }
      const meanReversion = ((s.base - price) / s.base) * 0.002; const shock = (rng() - 0.5) * 2 * s.vol;
      price = Math.max(0.0001, price * (1 + regimeDrift + meanReversion + shock)); history.push({ ts: now - i * 2000, price });
    }
    priceStates.set(s.symbol, { symbol: s.symbol, price, base: s.base, vol: s.vol, rng, history, regimeDrift, regimeTicks });
  }
}
function advancePrices() {
  seedPriceStates();
  for (const s of priceStates.values()) {
    s.regimeTicks++; if (s.regimeTicks >= 70) { s.regimeTicks = 0; const r = s.rng(); s.regimeDrift = r < 0.42 ? (s.rng() > 0.5 ? 0.0011 : -0.0011) : 0; }
    const meanReversion = ((s.base - s.price) / s.base) * 0.002; const shock = (s.rng() - 0.5) * 2 * s.vol;
    s.price = Math.max(0.0001, s.price * (1 + s.regimeDrift + meanReversion + shock)); s.history.push({ ts: Date.now(), price: s.price });
    if (s.history.length > 400) s.history.shift();
  }
  tickCount++;
}
function clampScore(v: number) { return Math.max(60, Math.min(95, Math.round(v))); }
function riskProfile(level: string, threshold: number) {
  const minScore = clampScore(threshold);
  if (level === 'Conservative') return { minScore, riskPerTradePct: 0.15 };
  if (level === 'Aggressive') return { minScore, riskPerTradePct: 0.35 };
  return { minScore, riskPerTradePct: ENGINE.riskPerTradePct };
}

export function getTickCount() { return tickCount; }
export function isEngineRunning() { return engineRunning; }
export function getMarketTicks(): MarketTick[] { seedPriceStates(); return [...priceStates.values()].map((s) => { const prev = s.history.at(-2)?.price ?? s.price; return { symbol: s.symbol, price: round(s.price, s.price >= 100 ? 2 : 4), change_pct: round(((s.price - prev) / prev) * 100, 2), ts: s.history.at(-1)?.ts ?? Date.now() }; }); }
export function getPriceHistory(symbol: string, points = 180) { seedPriceStates(); return priceStates.get(symbol)?.history.slice(-points) ?? []; }

async function clearExpiredPause() {
  const account = await getAccount();
  if (account.bot_status === 'PAUSED' && account.pause_until && Date.now() >= new Date(account.pause_until).getTime()) {
    await execute(`UPDATE tp_account SET bot_status='RUNNING', pause_until=NULL, pause_reason=NULL, started_at=now() WHERE id=1;`);
  }
}

export async function startEngine(): Promise<{ ok: boolean; message: string }> {
  if (engineRunning) return { ok: false, message: 'Engine is already running.' };
  const account = await getAccount();
  if (account.bot_status === 'PAUSED' && account.pause_until && Date.now() < new Date(account.pause_until).getTime()) return { ok: false, message: `Risk pause active until ${new Date(account.pause_until).toLocaleString()}.` };
  await clearExpiredPause(); seedPriceStates(); sessionStartEquity = account.equity; lastEntryTick = -Infinity; engineRunning = true;
  await execute(`UPDATE tp_account SET bot_status='RUNNING', started_at=now(), last_tick_at=now() WHERE id=1;`);
  tickTimer = setInterval(tick, 2000); snapshotTimer = setInterval(takeSnapshot, 10000); setTimeout(tick, 100);
  return { ok: true, message: 'Selective paper engine started with hard risk limits.' };
}
export async function stopEngine() { engineRunning = false; if (tickTimer) clearInterval(tickTimer); if (snapshotTimer) clearInterval(snapshotTimer); tickTimer = null; snapshotTimer = null; await execute(`UPDATE tp_account SET bot_status='STOPPED', last_tick_at=now() WHERE id=1;`); return { ok: true, message: 'Paper bot stopped.' }; }
export async function restartEngine() { await stopEngine(); await new Promise((r) => setTimeout(r, 100)); return startEngine(); }

async function tick() {
  if (!engineRunning || ticking) return; ticking = true;
  try {
    await clearExpiredPause(); const account = await getAccount();
    if (account.bot_status === 'PAUSED') { await execute(`UPDATE tp_account SET last_tick_at=now() WHERE id=1;`); return; }
    advancePrices();
    for (const pos of await getPositions()) {
      const ps = priceStates.get(pos.symbol); if (!ps) continue;
      const price = round(ps.price, pos.entry_price >= 100 ? 2 : 4);
      await execute(`UPDATE tp_positions SET current_price=$1, unrealized_pnl=$2 WHERE id=$3`, [price, calcUnrealizedPnl(pos, price), pos.id]);
      await manageRunner(pos, price);
      const sl = pos.side === 'LONG' ? price <= pos.stop_loss : price >= pos.stop_loss;
      const tp = pos.side === 'LONG' ? price >= pos.take_profit : price <= pos.take_profit;
      if (sl || tp) await closePosition(pos.id, price, sl ? 'Stop Loss' : 'Take Profit');
    }
    await recomputeEquity();
    const refreshed = await getAccount();
    const drawdown = sessionStartEquity > 0 ? ((sessionStartEquity - refreshed.equity) / sessionStartEquity) * 100 : 0;
    if (drawdown >= refreshed.loss_limit_pct) { await triggerCapitalPause(`Loss limit ${refreshed.loss_limit_pct.toFixed(2)}% reached (drawdown ${drawdown.toFixed(2)}%).`); return; }
    const positions = await getPositions(); const profile = riskProfile(refreshed.risk_level, refreshed.confidence_threshold_pct);
    if (positions.length < Math.min(20, refreshed.max_positions) && tickCount - lastEntryTick >= ENGINE.cooldownTicks) await tryOpenPosition(profile, refreshed.max_strategies);
    await recomputeEquity(); await execute(`UPDATE tp_account SET last_tick_at=now() WHERE id=1;`);
  } catch (err) { console.error('[engine] tick error', err); } finally { ticking = false; }
}

async function triggerCapitalPause(reason: string) {
  const account = await getAccount();
  for (const p of await getPositions()) await closePosition(p.id, undefined, 'Capital Protection');
  const pauseUntil = new Date(Date.now() + account.loss_pause_hours * 3600000).toISOString();
  await execute(`UPDATE tp_account SET bot_status='PAUSED', pause_until=$1, pause_reason=$2, last_tick_at=now() WHERE id=1;`, [pauseUntil, reason]);
}
function calcUnrealizedPnl(pos: Position, price: number) { return round((pos.side === 'LONG' ? 1 : -1) * (price - pos.entry_price) * pos.quantity, 2); }
async function manageRunner(pos: Position, price: number) {
  const risk = Math.abs(pos.entry_price - pos.stop_loss); if (!risk) return;
  const favorable = pos.side === 'LONG' ? price - pos.entry_price : pos.entry_price - price; const r = favorable / risk;
  if (r < ENGINE.breakEvenAtR) return;
  const newStop = r >= ENGINE.trailAtR ? (pos.side === 'LONG' ? pos.entry_price + risk * ENGINE.trailLockR : pos.entry_price - risk * ENGINE.trailLockR) : pos.entry_price;
  const improves = pos.side === 'LONG' ? newStop > pos.stop_loss : newStop < pos.stop_loss;
  if (improves) await execute(`UPDATE tp_positions SET stop_loss=$1 WHERE id=$2`, [round(newStop, pos.entry_price >= 100 ? 2 : 4), pos.id]);
}
async function recomputeEquity() { const a = await getAccount(), p = await getPositions(); const open = p.reduce((x, v) => x + v.notional, 0), u = p.reduce((x, v) => x + v.unrealized_pnl, 0); await execute(`UPDATE tp_account SET equity=$1,total_pnl=$2 WHERE id=1`, [round(a.cash + open + u, 2), round(a.realized_pnl + u, 2)]); }

async function tryOpenPosition(profile: { minScore: number; riskPerTradePct: number }, strategyLimit: number) {
  const account = await getAccount(), positions = await getPositions();
  if (positions.length >= Math.min(20, account.max_positions)) return;
  const held = new Set(positions.map((p) => p.symbol)); let best: { state: PriceState; signal: StrategySignal } | null = null;
  for (const state of [...priceStates.values()].filter((s) => !held.has(s.symbol))) {
    const signal = evaluateStrategy(state.history.map((x) => x.price), { minScore: profile.minScore, minRiskReward: ENGINE.minRiskReward, maxRiskReward: ENGINE.maxRiskReward, atrStopMultiple: ENGINE.atrStopMultiple, lookback: ENGINE.lookback, strategyLimit });
    if (signal.action !== 'WAIT' && (!best || signal.score > best.signal.score || (signal.score === best.signal.score && signal.riskReward > best.signal.riskReward))) best = { state, signal };
  }
  if (!best) return;
  const { state, signal } = best, price = round(state.price, state.price >= 100 ? 2 : 4), stop = round(signal.stopLoss, price >= 100 ? 2 : 4), target = round(signal.takeProfit, price >= 100 ? 2 : 4);
  const riskPerUnit = Math.abs(price - stop); if (!riskPerUnit || signal.riskReward < ENGINE.minRiskReward) return;
  const leverage = Math.min(10, Math.max(1, account.leverage));
  const riskBudget = account.equity * profile.riskPerTradePct / 100;
  const riskNotional = riskBudget * price / riskPerUnit;
  const allocationNotional = account.equity * (Math.min(100, Math.max(1, account.max_allocation_pct)) / 100) * leverage;
  const buyingPower = Math.max(0, account.cash) * leverage;
  const targetNotional = round(Math.min(riskNotional, allocationNotional, buyingPower), 2);
  if (targetNotional < 1) return;
  const quantity = round(targetNotional / price, 8); if (quantity <= 0) return;
  await execute(`INSERT INTO tp_positions(symbol,side,quantity,entry_price,current_price,notional,unrealized_pnl,stop_loss,take_profit,strategy,status) VALUES($1,$2,$3,$4,$4,$5,0,$6,$7,$8,'OPEN')`, [state.symbol, signal.action, quantity, price, targetNotional, stop, target, `${signal.strategy} ${signal.riskReward.toFixed(1)}R`]);
  // Paper margin model: only margin is reserved; leverage never exceeds the hard 10x ceiling.
  await execute(`UPDATE tp_account SET cash=cash-$1 WHERE id=1`, [round(targetNotional / leverage, 2)]);
  lastEntryTick = tickCount;
}

export async function closePosition(positionId: string, exitPrice?: number, reason?: string) {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM tp_positions WHERE id=$1 AND status='OPEN'`, [positionId]); if (!rows.length) return { ok: false, message: 'Position not found.' };
  const r = rows[0]; const pos = { id: String(r.id), symbol: String(r.symbol), side: r.side as 'LONG'|'SHORT', quantity: Number(r.quantity), entry_price: Number(r.entry_price), current_price: Number(r.current_price), notional: Number(r.notional), unrealized_pnl: Number(r.unrealized_pnl), stop_loss: Number(r.stop_loss), take_profit: Number(r.take_profit), strategy: String(r.strategy ?? 'Strategy'), opened_at: String(r.opened_at) };
  const ps = priceStates.get(pos.symbol); const exit = exitPrice ?? (ps ? round(ps.price, pos.entry_price >= 100 ? 2 : 4) : pos.current_price); const pnl = round((pos.side === 'LONG' ? 1 : -1) * (exit - pos.entry_price) * pos.quantity, 2); const returnPct = pos.notional ? round(pnl / pos.notional * 100, 2) : 0;
  await execute(`INSERT INTO tp_trades(symbol,side,quantity,entry_price,exit_price,pnl,return_pct,strategy,status,opened_at,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CLOSED',$9,now())`, [pos.symbol,pos.side,pos.quantity,pos.entry_price,exit,pnl,returnPct,pos.strategy,pos.opened_at]);
  await execute(`DELETE FROM tp_positions WHERE id=$1`, [pos.id]);
  const account = await getAccount(); const leverage = Math.min(10, Math.max(1, account.leverage)); const margin = round(pos.notional / leverage, 2);
  await execute(`UPDATE tp_account SET cash=cash+$1+($2) / $3, realized_pnl=realized_pnl+$2 WHERE id=1`, [margin,pnl,leverage]);
  await recomputeEquity(); return { ok: true, message: `Position closed (${reason ?? 'Manual'}). PnL: ${pnl.toFixed(2)}` };
}
async function takeSnapshot() { if (!engineRunning) return; try { const a = await getAccount(), p = await getPositions(); await execute(`INSERT INTO tp_snapshots(equity,cash,open_value,unrealized_pnl,realized_pnl,ts) VALUES($1,$2,$3,$4,$5,now())`, [a.equity,a.cash,p.reduce((x,v)=>x+v.notional,0),p.reduce((x,v)=>x+v.unrealized_pnl,0),a.realized_pnl]); } catch (e) { console.error('[engine] snapshot error', e); } }
export async function closeAllPositions() { const p = await getPositions(); for (const x of p) await closePosition(x.id, undefined, 'Close All'); return { ok: true, message: `Closed ${p.length} positions.` }; }
export async function resetAccount() { if (engineRunning) await stopEngine(); await resetDatabase(); priceStates.clear(); tickCount=0; lastEntryTick=-Infinity; sessionStartEquity=10000; return { ok:true, message:'Account reset to $10,000.' }; }

export async function getAiRecommendation(symbol?: string): Promise<AiRecommendation> {
  seedPriceStates(); const state = symbol ? priceStates.get(symbol) : priceStates.get('BTC/USDT');
  if (!state) return { symbol: symbol ?? 'BTC/USDT', action:'WAIT', confidence:0, threshold:85, entry:0, stop_loss:0, take_profit:0, risk_score:100, explanation:'No market data.' };
  const a = await getAccount(), threshold = clampScore(a.confidence_threshold_pct);
  const signal = evaluateStrategy(state.history.map((x)=>x.price), { minScore:threshold, minRiskReward:ENGINE.minRiskReward, maxRiskReward:ENGINE.maxRiskReward, atrStopMultiple:ENGINE.atrStopMultiple, lookback:ENGINE.lookback, strategyLimit:a.max_strategies });
  return { symbol:state.symbol, action:signal.action, confidence:signal.confidence, threshold, entry:round(signal.entry,state.price>=100?2:4), stop_loss:round(signal.stopLoss,state.price>=100?2:4), take_profit:round(signal.takeProfit,state.price>=100?2:4), risk_score:Math.max(0,100-signal.score), explanation:`${signal.strategy}: ${signal.reasons.join('; ') || 'No qualifying setup.'}${signal.action!=='WAIT'?` | ${signal.riskReward.toFixed(1)}R target.`:''} | threshold ${threshold}/100` };
}
