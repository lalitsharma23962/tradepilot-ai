import { query, execute, resetDatabase } from './db';
import { getAccount, getPositions } from './repository';
import type { AiRecommendation, MarketTick, Position } from './types';

// Deterministic pseudo-random generator (mulberry32) so simulation is reproducible.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOLS = [
  { symbol: 'BTC/USDT', base: 68000, vol: 0.015 },
  { symbol: 'ETH/USDT', base: 3500, vol: 0.02 },
  { symbol: 'SOL/USDT', base: 145, vol: 0.025 },
  { symbol: 'BNB/USDT', base: 580, vol: 0.018 },
  { symbol: 'XRP/USDT', base: 0.62, vol: 0.03 },
  { symbol: 'ADA/USDT', base: 0.45, vol: 0.028 },
  { symbol: 'AVAX/USDT', base: 28, vol: 0.026 },
  { symbol: 'LINK/USDT', base: 14.5, vol: 0.024 },
];

interface PriceState {
  symbol: string;
  price: number;
  base: number;
  vol: number;
  rng: () => number;
  history: { ts: number; price: number }[];
}

const priceStates = new Map<string, PriceState>();
let tickCount = 0;
let engineRunning = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;

function seedPriceStates() {
  if (priceStates.size > 0) return;
  for (const s of SYMBOLS) {
    const rng = mulberry32(Math.floor(s.base * 1000) + Date.now() % 100000);
    priceStates.set(s.symbol, {
      symbol: s.symbol,
      price: s.base,
      base: s.base,
      vol: s.vol,
      rng,
      history: [{ ts: Date.now(), price: s.base }],
    });
  }
}

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

export function getPriceHistory(symbol: string, points = 60): { ts: number; price: number }[] {
  seedPriceStates();
  const s = priceStates.get(symbol);
  if (!s) return [];
  return s.history.slice(-points);
}

function advancePrices() {
  seedPriceStates();
  for (const s of priceStates.values()) {
    // Geometric brownian-ish motion with mean reversion to base.
    const drift = (s.base - s.price) / s.base * 0.05;
    const shock = (s.rng() - 0.5) * 2 * s.vol;
    s.price = Math.max(0.0001, s.price * (1 + drift + shock));
    s.history.push({ ts: Date.now(), price: s.price });
    if (s.history.length > 300) s.history.shift();
  }
  tickCount++;
}

function round(v: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

// --- Engine control ---

export async function startEngine(): Promise<{ ok: boolean; message: string }> {
  if (engineRunning) {
    return { ok: false, message: 'Engine is already running. Duplicate start rejected.' };
  }
  const account = await getAccount();
  if (account.bot_status === 'RUNNING') {
    return { ok: false, message: 'Bot is already RUNNING. Duplicate start rejected.' };
  }

  seedPriceStates();
  engineRunning = true;
  await execute(
    `UPDATE tp_account SET bot_status = 'RUNNING', started_at = now(), last_tick_at = now() WHERE id = 1;`
  );

  tickTimer = setInterval(tick, 2000);
  snapshotTimer = setInterval(takeSnapshot, 10000);
  // Run one immediate tick so the UI shows activity right away.
  setTimeout(tick, 100);
  return { ok: true, message: 'Paper bot started.' };
}

export async function stopEngine(): Promise<{ ok: boolean; message: string }> {
  engineRunning = false;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
  await execute(
    `UPDATE tp_account SET bot_status = 'STOPPED', last_tick_at = now() WHERE id = 1;`
  );
  return { ok: true, message: 'Paper bot stopped.' };
}

export async function restartEngine(): Promise<{ ok: boolean; message: string }> {
  await stopEngine();
  // brief pause to let stop flush
  await new Promise((r) => setTimeout(r, 200));
  return startEngine();
}

export function isEngineRunning(): boolean {
  return engineRunning;
}

// --- The tick: advance prices, maybe open a position, update PnL, check SL/TP ---

let ticking = false;

async function tick() {
  if (!engineRunning || ticking) return;
  ticking = true;
  try {
    advancePrices();

    const account = await getAccount();
    const positions = await getPositions();

    // Update existing positions with new prices and check SL/TP.
    for (const pos of positions) {
      const ps = priceStates.get(pos.symbol);
      if (!ps) continue;
      const newPrice = round(ps.price, pos.entry_price >= 100 ? 2 : 4);
      const pnl = calcUnrealizedPnl(pos, newPrice);
      await execute(
        `UPDATE tp_positions SET current_price = $1, unrealized_pnl = $2 WHERE id = $3;`,
        [newPrice, pnl, pos.id]
      );

      // Stop loss / take profit check.
      const slHit = pos.side === 'LONG' ? newPrice <= pos.stop_loss : newPrice >= pos.stop_loss;
      const tpHit = pos.side === 'LONG' ? newPrice >= pos.take_profit : newPrice <= pos.take_profit;
      if (slHit || tpHit) {
        await closePosition(pos.id, newPrice, slHit ? 'Stop Loss' : 'Take Profit');
      }
    }

    // Recompute equity immediately after price updates so the DB never serves
    // stale equity alongside freshly-updated position PnL.
    await recomputeEquity();

    // Maybe open a new position.
    const openCount = (await getPositions()).length;
    if (openCount < account.max_positions && priceStates.size > 0) {
      // ~35% chance per tick to attempt an open (throttled by risk limits).
      const rng = Math.random();
      if (rng < 0.35) {
        await tryOpenPosition();
      }
    }

    await recomputeEquity();
    await execute(`UPDATE tp_account SET last_tick_at = now() WHERE id = 1;`);
  } catch (err) {
    console.error('[engine] tick error:', err);
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
  // EQUITY = cash + open position value + unrealized PnL
  const equity = round(account.cash + openValue + unrealized, 2);
  const totalPnl = round(account.realized_pnl + unrealized, 2);
  await execute(
    `UPDATE tp_account SET equity = $1, total_pnl = $2 WHERE id = 1;`,
    [equity, totalPnl]
  );
}

async function tryOpenPosition(): Promise<void> {
  const account = await getAccount();
  const positions = await getPositions();

  // Max 3 positions.
  if (positions.length >= account.max_positions) return;

  // Don't open in a symbol we already hold.
  const held = new Set(positions.map((p) => p.symbol));
  const candidates = Array.from(priceStates.values()).filter((s) => !held.has(s.symbol));
  if (candidates.length === 0) return;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const price = round(pick.price, pick.price >= 100 ? 2 : 4);

  // Allocation: default % of equity, capped at max_allocation_pct (hard 20%).
  const allocPct = Math.min(account.max_allocation_pct, account.default_allocation_pct) / 100;
  const targetNotional = round(account.equity * allocPct, 2);

  // Never allow negative cash or over-allocate.
  if (targetNotional > account.cash) return;
  if (targetNotional < 1) return;

  const side = pick.rng() > 0.5 ? 'LONG' : 'SHORT';
  const quantity = round(targetNotional / price, 6);
  if (quantity <= 0) return;

  const slPct = account.stop_loss_pct / 100;
  const tpPct = account.take_profit_pct / 100;
  const stopLoss = round(side === 'LONG' ? price * (1 - slPct) : price * (1 + slPct), price >= 100 ? 2 : 4);
  const takeProfit = round(side === 'LONG' ? price * (1 + tpPct) : price * (1 - tpPct), price >= 100 ? 2 : 4);

  const strategy = pickStrategy();

  await execute(
    `INSERT INTO tp_positions (symbol, side, quantity, entry_price, current_price, notional, unrealized_pnl, stop_loss, take_profit, strategy, status)
     VALUES ($1, $2, $3, $4, $5, $6, 0.00, $7, $8, $9, 'OPEN');`,
    [pick.symbol, side, quantity, price, price, targetNotional, stopLoss, takeProfit, strategy]
  );

  // Commit cash.
  await execute(`UPDATE tp_account SET cash = cash - $1 WHERE id = 1;`, [targetNotional]);
}

function pickStrategy(): string {
  const strategies = ['AI Signal', 'Mean Reversion', 'Momentum', 'Breakout'];
  return strategies[Math.floor(Math.random() * strategies.length)];
}

export async function closePosition(
  positionId: string,
  exitPrice?: number,
  reason?: string
): Promise<{ ok: boolean; message: string }> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM tp_positions WHERE id = $1 AND status = 'OPEN';`,
    [positionId]
  );
  if (rows.length === 0) return { ok: false, message: 'Position not found or already closed.' };
  const r = rows[0];
  // PGlite returns numeric columns as strings — normalize before arithmetic.
  const pos = {
    id: String(r.id),
    symbol: String(r.symbol),
    side: r.side as 'LONG' | 'SHORT',
    quantity: Number(r.quantity),
    entry_price: Number(r.entry_price),
    current_price: Number(r.current_price),
    notional: Number(r.notional),
    unrealized_pnl: Number(r.unrealized_pnl),
    stop_loss: Number(r.stop_loss),
    take_profit: Number(r.take_profit),
    strategy: String(r.strategy ?? 'AI Signal'),
    status: String(r.status ?? 'OPEN'),
    opened_at: new Date(r.opened_at as string).toISOString(),
  };

  const ps = priceStates.get(pos.symbol);
  const exit = exitPrice ?? (ps ? round(ps.price, pos.entry_price >= 100 ? 2 : 4) : pos.current_price);

  const direction = pos.side === 'LONG' ? 1 : -1;
  const pnl = round(direction * (exit - pos.entry_price) * pos.quantity, 2);
  const returnPct = round((pnl / pos.notional) * 100, 2);

  // Return notional + pnl to cash.
  const cashReturn = round(pos.notional + pnl, 2);

  await execute(
    `INSERT INTO tp_trades (symbol, side, quantity, entry_price, exit_price, pnl, return_pct, strategy, status, opened_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CLOSED', $9, now());`,
    [pos.symbol, pos.side, pos.quantity, pos.entry_price, exit, pnl, returnPct, pos.strategy, pos.opened_at]
  );

  await execute(`DELETE FROM tp_positions WHERE id = $1;`, [pos.id]);
  await execute(
    `UPDATE tp_account SET cash = cash + $1, realized_pnl = realized_pnl + $2 WHERE id = 1;`,
    [cashReturn, pnl]
  );

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
    await execute(
      `INSERT INTO tp_snapshots (equity, cash, open_value, unrealized_pnl, realized_pnl, ts)
       VALUES ($1, $2, $3, $4, $5, now());`,
      [account.equity, account.cash, openValue, unrealized, account.realized_pnl]
    );
  } catch (err) {
    console.error('[engine] snapshot error:', err);
  }
}

export async function closeAllPositions(): Promise<{ ok: boolean; message: string }> {
  const positions = await getPositions();
  for (const p of positions) {
    await closePosition(p.id, undefined, 'Close All');
  }
  return { ok: true, message: `Closed ${positions.length} positions.` };
}

export async function resetAccount(): Promise<{ ok: boolean; message: string }> {
  if (engineRunning) await stopEngine();
  await resetDatabase();
  return { ok: true, message: 'Account reset to $10,000.' };
}

// --- AI recommendation (observation only, never auto-executes) ---

export function getAiRecommendation(symbol?: string): AiRecommendation {
  seedPriceStates();
  const ticks = getMarketTicks();
  let pick = symbol ? ticks.find((t) => t.symbol === symbol) : undefined;
  if (!pick) pick = ticks[Math.floor(Math.random() * ticks.length)];
  if (!pick) {
    return {
      symbol: 'BTC/USDT',
      action: 'WAIT',
      confidence: 0,
      entry: 0,
      stop_loss: 0,
      take_profit: 0,
      risk_score: 0,
      explanation: 'No market data available.',
    };
  }

  const ps = priceStates.get(pick.symbol)!;
  const recent = ps.history.slice(-10);
  const trendUp = recent.length > 1 && recent[recent.length - 1].price > recent[0].price;
  const action: AiRecommendation['action'] = trendUp ? 'LONG' : 'SHORT';
  const confidence = round(0.5 + Math.random() * 0.45, 2);
  const entry = pick.price;
  const slPct = 0.02;
  const tpPct = 0.04;
  const stopLoss = round(action === 'LONG' ? entry * (1 - slPct) : entry * (1 + slPct), entry >= 100 ? 2 : 4);
  const takeProfit = round(action === 'LONG' ? entry * (1 + tpPct) : entry * (1 - tpPct), entry >= 100 ? 2 : 4);
  const riskScore = round(1 + Math.random() * 5, 1);

  return {
    symbol: pick.symbol,
    action,
    confidence,
    entry,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    risk_score: riskScore,
    explanation: `Simulated market observation: ${pick.symbol} shows ${trendUp ? 'upward' : 'downward'} momentum over the last ${recent.length} ticks. This is a paper-trading signal only — no real exchange data.`,
  };
}

export function getTickCount(): number {
  return tickCount;
}

// ---------------------------------------------------------------------------
// Test-only helpers: deterministic position injection and SL/TP evaluation.
// These bypass the random price generator so tests can verify the exit logic
// in isolation. Not used by the production UI.
// ---------------------------------------------------------------------------

/** Insert a position with exact fields for deterministic testing. */
export async function injectPositionForTest(p: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entry_price: number;
  current_price: number;
  notional: number;
  stop_loss: number;
  take_profit: number;
  strategy?: string;
}): Promise<string> {
  await execute(
    `INSERT INTO tp_positions (symbol, side, quantity, entry_price, current_price, notional, unrealized_pnl, stop_loss, take_profit, strategy, status)
     VALUES ($1, $2, $3, $4, $5, $6, 0.00, $7, $8, $9, 'OPEN');`,
    [
      p.symbol, p.side, p.quantity, p.entry_price, p.current_price, p.notional,
      p.stop_loss, p.take_profit, p.strategy ?? 'Test',
    ]
  );
  // Deduct notional from cash, matching the real engine's open flow.
  await execute(`UPDATE tp_account SET cash = cash - $1 WHERE id = 1;`, [p.notional]);
  await recomputeEquity();
  const rows = await query<{ id: string }>(
    `SELECT id FROM tp_positions WHERE symbol = $1 AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1;`,
    [p.symbol]
  );
  return rows.length > 0 ? String(rows[0].id) : '';
}

/** Set the authoritative market price for a symbol (used by SL/TP checks). */
export function setPriceForTest(symbol: string, price: number): void {
  seedPriceStates();
  const ps = priceStates.get(symbol);
  if (ps) {
    ps.price = price;
    ps.history.push({ ts: Date.now(), price });
  }
}

/**
 * Run ONLY the SL/TP evaluation loop against open positions using the current
 * priceStates. Returns details about what was evaluated and closed.
 * This mirrors the exact logic from tick() lines 154-170.
 */
export async function evaluateExitsForTest(): Promise<{
  checked: { id: string; symbol: string; side: string; price: number; sl: number; tp: number; slHit: boolean; tpHit: boolean; closed: boolean }[];
  closedCount: number;
}> {
  const positions = await getPositions();
  const checked: { id: string; symbol: string; side: string; price: number; sl: number; tp: number; slHit: boolean; tpHit: boolean; closed: boolean }[] = [];
  let closedCount = 0;

  for (const pos of positions) {
    const ps = priceStates.get(pos.symbol);
    if (!ps) {
      checked.push({ id: pos.id, symbol: pos.symbol, side: pos.side, price: 0, sl: pos.stop_loss, tp: pos.take_profit, slHit: false, tpHit: false, closed: false });
      continue;
    }
    const newPrice = round(ps.price, pos.entry_price >= 100 ? 2 : 4);
    const pnl = calcUnrealizedPnl(pos, newPrice);
    await execute(
      `UPDATE tp_positions SET current_price = $1, unrealized_pnl = $2 WHERE id = $3;`,
      [newPrice, pnl, pos.id]
    );

    const slHit = pos.side === 'LONG' ? newPrice <= pos.stop_loss : newPrice >= pos.stop_loss;
    const tpHit = pos.side === 'LONG' ? newPrice >= pos.take_profit : newPrice <= pos.take_profit;
    let closed = false;
    if (slHit || tpHit) {
      const res = await closePosition(pos.id, newPrice, slHit ? 'Stop Loss' : 'Take Profit');
      closed = res.ok;
      if (closed) closedCount++;
    }
    checked.push({ id: pos.id, symbol: pos.symbol, side: pos.side, price: newPrice, sl: pos.stop_loss, tp: pos.take_profit, slHit, tpHit, closed });
  }

  await recomputeEquity();
  return { checked, closedCount };
}
