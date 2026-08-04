import { query, execute, resetDatabase } from './db';
import { getAccount, getPositions } from './repository';
import type { AiRecommendation, MarketTick, Position } from './types';
import { evaluateStrategy, type StrategySignal } from './strategy';

// PAPER TRADING ONLY. No broker/exchange API is called by this module.
const SYMBOLS = [
  { symbol: 'BTC/USDT', base: 68000, vol: 0.0045 },
  { symbol: 'ETH/USDT', base: 3500, vol: 0.006 },
  { symbol: 'SOL/USDT', base: 145, vol: 0.008 },
  { symbol: 'BNB/USDT', base: 580, vol: 0.0055 },
  { symbol: 'XRP/USDT', base: 0.62, vol: 0.009 },
  { symbol: 'ADA/USDT', base: 0.45, vol: 0.0085 },
  { symbol: 'AVAX/USDT', base: 28, vol: 0.008 },
  { symbol: 'LINK/USDT', base: 14.5, vol: 0.007 },
];

const STRATEGY = {
  minScore: 82,
  minRiskReward: 10,
  maxRiskReward: 15,
  atrStopMultiple: 1.0,
  lookback: 120,
  maxTradesPerSession: 5,
  maxConsecutiveLosses: 2,
  cooldownTicks: 8,
};

interface PriceState {
  symbol: string;
  price: number;
  base: number;
  vol: number;
  rng: () => number;
  history: { ts: number; price: number }[];
  regimeDrift: number;
  regimeTicks: number;
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const priceStates = new Map<string, PriceState>();
let tickCount = 0;
let engineRunning = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let sessionTrades = 0;
let consecutiveLosses = 0;
let lastEntryTick = -Infinity;

function seedPriceStates() {
  if (priceStates.size > 0) return;
  for (const s of SYMBOLS) {
    const rng = mulberry32(Math.floor(s.base * 1000) + 17391);
    priceStates.set(s.symbol, {
      symbol: s.symbol,
      price: s.base,
      base: s.base,
      vol: s.vol,
      rng,
      history: [{ ts: Date.now(), price: s.base }],
      regimeDrift: 0,
      regimeTicks: 0,
    });
  }
}

export function getTickCount(): number { return tickCount; }

export function getMarketTicks(): MarketTick[] {
  seedPriceStates();
  return Array.from(priceStates.values()).map((s) => {
    const prev = s.history.length > 1 ? s.history[s.history.length - 2].price : s.price;
    return {
      symbol: s.symbol,
      price: round(s.price, s.price >= 100 ? 2 : 4),
      change_pct: round(((s.price - prev) / prev) * 100, 2),
      ts: s.history[s.history.length - 1].ts,
    };
  });
}

export function getPriceHistory(symbol: string, points = 120): { ts: number; price: number }[] {
  seedPriceStates();
  const s = priceStates.get(symbol);
  return s ? s.history.slice(-points) : [];
}

function advancePrices() {
  seedPriceStates();
  for (const s of priceStates.values()) {
    s.regimeTicks++;
    if (s.regimeTicks >= 70) {
      s.regimeTicks = 0;
      const r = s.rng();
      s.regimeDrift = r < 0.42 ? (s.rng() > 0.5 ? 0.0011 : -0.0011) : 0;
    }
    const meanReversion = ((s.base - s.price) / s.base) * 0.002;
    const shock = (s.rng() - 0.5) * 2 * s.vol;
    s.price = Math.max(0.0001, s.price * (1 + s.regimeDrift + meanReversion + shock));
    s.history.push({ ts: Date.now(), price: s.price });
    if (s.history.length > 400) s.history.shift();
  }
  tickCount++;
}

function round(v: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

export async function startEngine(): Promise<{ ok: boolean; message: string }> {
  if (engineRunning) return { ok: false, message: 'Engine is already running. Duplicate start rejected.' };
  const account = await getAccount();
  if (account.bot_status === 'RUNNING') return { ok: false, message: 'Bot is already RUNNING. Duplicate start rejected.' };
  seedPriceStates();
  engineRunning = true;
  sessionTrades = 0;
  consecutiveLosses = 0;
  lastEntryTick = -Infinity;
  await execute(`UPDATE tp_account SET bot_status = 'RUNNING', started_at = now(), last_tick_at = now() WHERE id = 1;`);
  tickTimer = setInterval(tick, 2000);
  snapshotTimer = setInterval(takeSnapshot, 10000);
  setTimeout(tick, 100);
  return { ok: true, message: 'Selective paper bot started. Score >= 82 and minimum 10R potential required.' };
}

export async function stopEngine(): Promise<{ ok: boolean; message: string }> {
  engineRunning = false;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
  await execute(`UPDATE tp_account SET bot_status = 'STOPPED', last_tick_at = now() WHERE id = 1;`);
  return { ok: true, message: 'Paper bot stopped.' };
}

export async function restartEngine(): Promise<{ ok: boolean; message: string }> {
  await stopEngine();
  await new Promise((r) => setTimeout(r, 200));
  return startEngine();
}

export function isEngineRunning(): boolean { return engineRunning; }

async function tick() {
  if (!engineRunning || ticking) return;
  ticking = true;
  try {
    advancePrices();
    const account = await getAccount();
    const positions = await getPositions();

    for (const pos of positions) {
      const ps = priceStates.get(pos.symbol);
      if (!ps) continue;
      const newPrice = round(ps.price, pos.entry_price >= 100 ? 2 : 4);
      const pnl = calcUnrealizedPnl(pos, newPrice);
      await execute(`UPDATE tp_positions SET current_price = $1, unrealized_pnl = $2 WHERE id = $3;`, [newPrice, pnl, pos.id]);
      const slHit = pos.side === 'LONG' ? newPrice <= pos.stop_loss : newPrice >= pos.stop_loss;
      const tpHit = pos.side === 'LONG' ? newPrice >= pos.take_profit : newPrice <= pos.take_profit;
      if (slHit || tpHit) await closePosition(pos.id, newPrice, slHit ? 'Stop Loss' : 'Take Profit');
    }

    await recomputeEquity();
    const currentPositions = await getPositions();
    if (currentPositions.length < account.max_positions && sessionTrades < STRATEGY.maxTradesPerSession && consecutiveLosses < STRATEGY.maxConsecutiveLosses && tickCount - lastEntryTick >= STRATEGY.cooldownTicks) {
      await tryOpenPosition();
    }
    await recomputeEquity();
    await execute(`UPDATE tp_account SET last_tick_at = now() WHERE id = 1;`);
  } catch (err) {
    console.error('[engine-v2] tick error:', err);
  } finally {
    ticking = false;
  }
}

function calcUnrealizedPnl(pos: Position, currentPrice: number): number {
  const direction = pos.side === 'LONG' ? 1 : -1;
  return round(direction * (currentPrice - pos.entry_price) * pos.quantity, 2);
}

async function recomputeEquity() {
  const account = await getAccount();
  const positions = await getPositions();
  const openValue = positions.reduce((a, p) => a + p.notional, 0);
  const unrealized = positions.reduce((a, p) => a + p.unrealized_pnl, 0);
  const equity = round(account.cash + openValue + unrealized, 2);
  const totalPnl = round(account.realized_pnl + unrealized, 2);
  await execute(`UPDATE tp_account SET equity = $1, total_pnl = $2 WHERE id = 1;`, [equity, totalPnl]);
}

async function tryOpenPosition(): Promise<void> {
  const account = await getAccount();
  const positions = await getPositions();
  if (positions.length >= account.max_positions) return;
  const held = new Set(positions.map((p) => p.symbol));
  const candidates = Array.from(priceStates.values()).filter((s) => !held.has(s.symbol));
  if (!candidates.length) return;

  let best: { state: PriceState; signal: StrategySignal } | null = null;
  for (const state of candidates) {
    const signal = evaluateStrategy(state.history.map((x) => x.price), STRATEGY);
    if (signal.action === 'WAIT') continue;
    if (!best || signal.score > best.signal.score || signal.riskReward > best.signal.riskReward) best = { state, signal };
  }
  if (!best) return;

  const { state, signal } = best;
  const price = round(state.price, state.price >= 100 ? 2 : 4);
  const allocPct = Math.min(account.max_allocation_pct, account.default_allocation_pct) / 100;
  const targetNotional = round(account.equity * allocPct, 2);
  if (targetNotional > account.cash || targetNotional < 1) return;
  const quantity = round(targetNotional / price, 8);
  if (quantity <= 0) return;
  const stopLoss = round(signal.stopLoss, price >= 100 ? 2 : 4);
  const takeProfit = round(signal.takeProfit, price >= 100 ? 2 : 4);
  if (Math.abs(price - stopLoss) <= 0) return;

  await execute(
    `INSERT INTO tp_positions (symbol, side, quantity, entry_price, current_price, notional, unrealized_pnl, stop_loss, take_profit, strategy, status)
     VALUES ($1, $2, $3, $4, $5, $6, 0.00, $7, $8, $9, 'OPEN');`,
    [state.symbol, signal.action, quantity, price, price, targetNotional, stopLoss, takeProfit, `${signal.strategy} ${signal.riskReward.toFixed(1)}R`],
  );
  await execute(`UPDATE tp_account SET cash = cash - $1 WHERE id = 1;`, [targetNotional]);
  sessionTrades++;
  lastEntryTick = tickCount;
}

export async function closePosition(positionId: string, exitPrice?: number, reason?: string): Promise<{ ok: boolean; message: string }> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM tp_positions WHERE id = $1 AND status = 'OPEN';`, [positionId]);
  if (rows.length === 0) return { ok: false, message: 'Position not found or already closed.' };
  const r = rows[0];
  const pos = {
    id: String(r.id), symbol: String(r.symbol), side: r.side as 'LONG' | 'SHORT', quantity: Number(r.quantity),
    entry_price: Number(r.entry_price), current_price: Number(r.current_price), notional: Number(r.notional),
    unrealized_pnl: Number(r.unrealized_pnl), stop_loss: Number(r.stop_loss), take_profit: Number(r.take_profit),
    strategy: String(r.strategy ?? 'Strategy'), status: String(r.status ?? 'OPEN'), opened_at: new Date(r.opened_at as string).toISOString(),
  };
  const ps = priceStates.get(pos.symbol);
  const exit = exitPrice ?? (ps ? round(ps.price, pos.entry_price >= 100 ? 2 : 4) : pos.current_price);
  const direction = pos.side === 'LONG' ? 1 : -1;
  const pnl = round(direction * (exit - pos.entry_price) * pos.quantity, 2);
  const returnPct = round((pnl / pos.notional) * 100, 2);
  const cashReturn = round(pos.notional + pnl, 2);

  await execute(
    `INSERT INTO tp_trades (symbol, side, quantity, entry_price, exit_price, pnl, return_pct, strategy, status, opened_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CLOSED', $9, now());`,
    [pos.symbol, pos.side, pos.quantity, pos.entry_price, exit, pnl, returnPct, pos.strategy, pos.opened_at],
  );
  await execute(`DELETE FROM tp_positions WHERE id = $1;`, [pos.id]);
  await execute(`UPDATE tp_account SET cash = cash + $1, realized_pnl = realized_pnl + $2 WHERE id = 1;`, [cashReturn, pnl]);
  if (pnl < 0) consecutiveLosses++; else consecutiveLosses = 0;
  await recomputeEquity();
  return { ok: true, message: `Position closed (${reason ?? 'Manual'}). PnL: ${pnl.toFixed(2)}` };
}

async function takeSnapshot() {
  if (!engineRunning) return;
  try {
    const account = await getAccount();
    const positions = await getPositions();
    const openValue = positions.reduce((a, p) => a + p.notional, 0);
    const unrealized = positions.reduce((a, p) => a + p.unrealized_pnl, 0);
    await execute(`INSERT INTO tp_snapshots (equity, cash, open_value, unrealized_pnl, realized_pnl, ts) VALUES ($1, $2, $3, $4, $5, now());`, [account.equity, account.cash, openValue, unrealized, account.realized_pnl]);
  } catch (err) {
    console.error('[engine-v2] snapshot error:', err);
  }
}

export async function closeAllPositions(): Promise<{ ok: boolean; message: string }> {
  const positions = await getPositions();
  for (const p of positions) await closePosition(p.id, undefined, 'Close All');
  return { ok: true, message: `Closed ${positions.length} positions.` };
}

export async function resetAccount(): Promise<{ ok: boolean; message: string }> {
  if (engineRunning) await stopEngine();
  await resetDatabase();
  priceStates.clear();
  tickCount = 0;
  sessionTrades = 0;
  consecutiveLosses = 0;
  lastEntryTick = -Infinity;
  return { ok: true, message: 'Account reset to $10,000.' };
}

export function getAiRecommendation(symbol?: string): AiRecommendation {
  seedPriceStates();
  const state = symbol ? priceStates.get(symbol) : priceStates.get('BTC/USDT');
  if (!state) return { symbol: symbol ?? 'BTC/USDT', action: 'WAIT', confidence: 0, entry: 0, stop_loss: 0, take_profit: 0, risk_score: 100, explanation: 'No market data available.' };
  const signal = evaluateStrategy(state.history.map((x) => x.price), STRATEGY);
  return {
    symbol: state.symbol,
    action: signal.action,
    confidence: signal.confidence,
    entry: round(signal.entry, state.price >= 100 ? 2 : 4),
    stop_loss: round(signal.stopLoss, state.price >= 100 ? 2 : 4),
    take_profit: round(signal.takeProfit, state.price >= 100 ? 2 : 4),
    risk_score: signal.action === 'WAIT' ? 100 : Math.max(0, 100 - signal.score),
    explanation: `${signal.strategy}: ${signal.reasons.join('; ') || 'No qualifying setup.'}${signal.action !== 'WAIT' ? ` | ${signal.riskReward.toFixed(1)}R target.` : ''}`,
  };
}
