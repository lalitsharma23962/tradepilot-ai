import { query, execute } from './db';
import type { Account, Position, Trade, Snapshot, Performance, Settings, RiskLevel, ThemeMode } from './types';

function num(v: unknown): number { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : 0; }

export async function getAccount(): Promise<Account> {
  const rows = await query<Record<string, unknown>>('SELECT * FROM tp_account WHERE id = 1;');
  if (rows.length === 0) {
    await execute(`INSERT INTO tp_account (id, cash, equity, total_pnl, realized_pnl, bot_status) VALUES (1, 10000.00, 10000.00, 0.00, 0.00, 'STOPPED')`);
    const fresh = await query<Record<string, unknown>>('SELECT * FROM tp_account WHERE id = 1;');
    return normalizeAccount(fresh[0]);
  }
  return normalizeAccount(rows[0]);
}

function normalizeAccount(r: Record<string, unknown>): Account {
  return {
    id: num(r.id), cash: num(r.cash), equity: num(r.equity), total_pnl: num(r.total_pnl), realized_pnl: num(r.realized_pnl),
    bot_status: (r.bot_status as Account['bot_status']) ?? 'STOPPED', started_at: (r.started_at as string | null) ?? null,
    last_tick_at: (r.last_tick_at as string | null) ?? null, max_positions: Math.max(1, num(r.max_positions) || 3),
    max_strategies: Math.min(10, Math.max(1, num(r.max_strategies) || 10)), max_allocation_pct: Math.min(20, Math.max(1, num(r.max_allocation_pct) || 20)),
    default_allocation_pct: Math.min(20, Math.max(1, num(r.default_allocation_pct) || 15)), stop_loss_pct: num(r.stop_loss_pct) || 2,
    take_profit_pct: num(r.take_profit_pct) || 4, confidence_threshold_pct: Math.min(95, Math.max(60, num(r.confidence_threshold_pct) || 75)),
    leverage: Math.min(10, Math.max(1, num(r.leverage) || 1)), loss_limit_pct: Math.min(20, Math.max(0.25, num(r.loss_limit_pct) || 2)),
    risk_pause_until: (r.risk_pause_until as string | null) ?? null, fee_bps: Math.max(0, num(r.fee_bps) || 10), slippage_bps: Math.max(0, num(r.slippage_bps) || 2),
    risk_level: (r.risk_level as RiskLevel) ?? 'Balanced', theme: (r.theme as ThemeMode) ?? 'Dark', trade_alerts: r.trade_alerts as boolean | null ?? true,
    pnl_alerts: r.pnl_alerts as boolean | null ?? true, risk_alerts: r.risk_alerts as boolean | null ?? true,
  };
}

export async function getPositions(): Promise<Position[]> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM tp_positions WHERE status = 'OPEN' ORDER BY opened_at DESC;`);
  return rows.map(normalizePosition);
}
function normalizePosition(r: Record<string, unknown>): Position {
  return { id: String(r.id), symbol: String(r.symbol), side: r.side as Position['side'], quantity: num(r.quantity), entry_price: num(r.entry_price), current_price: num(r.current_price), notional: num(r.notional), unrealized_pnl: num(r.unrealized_pnl), stop_loss: num(r.stop_loss), take_profit: num(r.take_profit), strategy: String(r.strategy ?? 'AI Signal'), status: String(r.status ?? 'OPEN'), opened_at: String(r.opened_at) };
}

export async function getTrades(limit = 200): Promise<Trade[]> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM tp_trades ORDER BY closed_at DESC LIMIT $1;`, [limit]);
  return rows.map(normalizeTrade);
}
function normalizeTrade(r: Record<string, unknown>): Trade {
  return { id: String(r.id), symbol: String(r.symbol), side: r.side as Trade['side'], quantity: num(r.quantity), entry_price: num(r.entry_price), exit_price: num(r.exit_price), pnl: num(r.pnl), return_pct: num(r.return_pct), strategy: String(r.strategy ?? 'AI Signal'), status: String(r.status ?? 'CLOSED'), opened_at: String(r.opened_at), closed_at: String(r.closed_at) };
}

export async function getSnapshots(limit = 500): Promise<Snapshot[]> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM tp_snapshots ORDER BY ts DESC LIMIT $1;`, [limit]);
  return rows.map(normalizeSnapshot).reverse();
}
function normalizeSnapshot(r: Record<string, unknown>): Snapshot {
  return { id: String(r.id), equity: num(r.equity), cash: num(r.cash), open_value: num(r.open_value), unrealized_pnl: num(r.unrealized_pnl), realized_pnl: num(r.realized_pnl), ts: String(r.ts) };
}

export async function getPerformance(): Promise<Performance> {
  const account = await getAccount(); const positions = await getPositions(); const trades = await getTrades(1000);
  const wins = trades.filter(t => t.pnl > 0).length, losses = trades.filter(t => t.pnl < 0).length, tradeCount = trades.length;
  const winRate = tradeCount ? wins / tradeCount * 100 : 0, pnls = trades.map(t => t.pnl);
  const bestTrade = pnls.length ? Math.max(...pnls) : 0, worstTrade = pnls.length ? Math.min(...pnls) : 0, avgTrade = pnls.length ? pnls.reduce((a,b) => a+b,0)/pnls.length : 0;
  const grossProfit = pnls.filter(p => p > 0).reduce((a,b) => a+b,0), grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a,b) => a+b,0));
  const profitFactor = grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const snapshots = await getSnapshots(500); let maxEquity = account.equity, maxDrawdown = 0;
  for (const s of snapshots) { if (s.equity > maxEquity) maxEquity = s.equity; maxDrawdown = Math.max(maxDrawdown, maxEquity - s.equity); }
  const unrealized = positions.reduce((a,p) => a+p.unrealized_pnl,0);
  return { equity: account.equity, total_pnl: account.total_pnl, realized_pnl: account.realized_pnl, unrealized_pnl: unrealized, win_rate: winRate, wins, losses, trade_count: tradeCount, open_positions: positions.length, best_trade: bestTrade, worst_trade: worstTrade, avg_trade: avgTrade, profit_factor: profitFactor === Infinity ? 0 : profitFactor, max_drawdown: maxDrawdown };
}

export async function getSettings(): Promise<Settings> {
  const account = await getAccount();
  return { risk_level: account.risk_level, max_allocation_pct: account.max_allocation_pct, default_allocation_pct: account.default_allocation_pct, stop_loss_pct: account.stop_loss_pct, take_profit_pct: account.take_profit_pct, confidence_threshold_pct: account.confidence_threshold_pct, max_strategies: account.max_strategies, leverage: account.leverage, loss_limit_pct: account.loss_limit_pct, fee_bps: account.fee_bps, slippage_bps: account.slippage_bps, theme: account.theme, trade_alerts: account.trade_alerts, pnl_alerts: account.pnl_alerts, risk_alerts: account.risk_alerts };
}

export async function updateSettings(s: Partial<Settings>): Promise<Settings> {
  const set: string[] = []; const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
  if (s.risk_level !== undefined) push('risk_level', s.risk_level);
  if (s.max_allocation_pct !== undefined) push('max_allocation_pct', Math.min(20, Math.max(1, s.max_allocation_pct)));
  if (s.default_allocation_pct !== undefined) push('default_allocation_pct', Math.min(20, Math.max(1, s.default_allocation_pct)));
  if (s.stop_loss_pct !== undefined) push('stop_loss_pct', Math.min(20, Math.max(0.1, s.stop_loss_pct)));
  if (s.take_profit_pct !== undefined) push('take_profit_pct', Math.min(50, Math.max(0.25, s.take_profit_pct)));
  if (s.confidence_threshold_pct !== undefined) push('confidence_threshold_pct', Math.min(95, Math.max(60, s.confidence_threshold_pct)));
  if (s.max_strategies !== undefined) push('max_strategies', Math.min(10, Math.max(1, Math.round(s.max_strategies))));
  if (s.leverage !== undefined) push('leverage', Math.min(10, Math.max(1, s.leverage)));
  if (s.loss_limit_pct !== undefined) push('loss_limit_pct', Math.min(20, Math.max(0.25, s.loss_limit_pct)));
  if (s.fee_bps !== undefined) push('fee_bps', Math.min(100, Math.max(0, s.fee_bps)));
  if (s.slippage_bps !== undefined) push('slippage_bps', Math.min(100, Math.max(0, s.slippage_bps)));
  if (s.theme !== undefined) push('theme', s.theme);
  if (s.trade_alerts !== undefined) push('trade_alerts', s.trade_alerts);
  if (s.pnl_alerts !== undefined) push('pnl_alerts', s.pnl_alerts);
  if (s.risk_alerts !== undefined) push('risk_alerts', s.risk_alerts);
  if (set.length > 0) { params.push(1); await execute(`UPDATE tp_account SET ${set.join(', ')} WHERE id = $${params.length};`, params); }
  return getSettings();
}
