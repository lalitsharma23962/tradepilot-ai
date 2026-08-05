import { PGlite } from '@electric-sql/pglite';

let dbInstance: PGlite | null = null;
let initPromise: Promise<PGlite> | null = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tp_account (
  id integer PRIMARY KEY DEFAULT 1,
  cash numeric(20,2) NOT NULL DEFAULT 10000.00,
  equity numeric(20,2) NOT NULL DEFAULT 10000.00,
  total_pnl numeric(20,2) NOT NULL DEFAULT 0.00,
  realized_pnl numeric(20,2) NOT NULL DEFAULT 0.00,
  bot_status text NOT NULL DEFAULT 'STOPPED',
  started_at timestamptz,
  last_tick_at timestamptz,
  max_positions integer NOT NULL DEFAULT 3,
  max_strategies integer NOT NULL DEFAULT 10,
  max_allocation_pct numeric(5,2) NOT NULL DEFAULT 20.00,
  default_allocation_pct numeric(5,2) NOT NULL DEFAULT 15.00,
  stop_loss_pct numeric(5,2) NOT NULL DEFAULT 2.00,
  take_profit_pct numeric(5,2) NOT NULL DEFAULT 4.00,
  confidence_threshold_pct numeric(5,2) NOT NULL DEFAULT 75.00,
  leverage numeric(5,2) NOT NULL DEFAULT 1.00,
  loss_limit_pct numeric(5,2) NOT NULL DEFAULT 2.00,
  risk_pause_until timestamptz,
  fee_bps numeric(6,2) NOT NULL DEFAULT 10.00,
  slippage_bps numeric(6,2) NOT NULL DEFAULT 2.00,
  risk_level text NOT NULL DEFAULT 'Balanced',
  theme text NOT NULL DEFAULT 'Dark',
  trade_alerts boolean NOT NULL DEFAULT true,
  pnl_alerts boolean NOT NULL DEFAULT true,
  risk_alerts boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tp_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  side text NOT NULL,
  quantity numeric(20,8) NOT NULL,
  entry_price numeric(20,8) NOT NULL,
  current_price numeric(20,8) NOT NULL,
  notional numeric(20,2) NOT NULL,
  unrealized_pnl numeric(20,2) NOT NULL DEFAULT 0.00,
  stop_loss numeric(20,8) NOT NULL,
  take_profit numeric(20,8) NOT NULL,
  strategy text NOT NULL DEFAULT 'AI Signal',
  status text NOT NULL DEFAULT 'OPEN',
  opened_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tp_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  side text NOT NULL,
  quantity numeric(20,8) NOT NULL,
  entry_price numeric(20,8) NOT NULL,
  exit_price numeric(20,8) NOT NULL,
  pnl numeric(20,2) NOT NULL,
  return_pct numeric(10,2) NOT NULL,
  strategy text NOT NULL DEFAULT 'AI Signal',
  status text NOT NULL DEFAULT 'CLOSED',
  opened_at timestamptz NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tp_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equity numeric(20,2) NOT NULL,
  cash numeric(20,2) NOT NULL,
  open_value numeric(20,2) NOT NULL,
  unrealized_pnl numeric(20,2) NOT NULL,
  realized_pnl numeric(20,2) NOT NULL,
  ts timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tp_snapshots_ts ON tp_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_tp_trades_closed_at ON tp_trades(closed_at);
`;

const SEED_SQL = `
INSERT INTO tp_account (id, cash, equity, total_pnl, realized_pnl, bot_status)
SELECT 1, 10000.00, 10000.00, 0.00, 0.00, 'STOPPED'
WHERE NOT EXISTS (SELECT 1 FROM tp_account WHERE id = 1);
`;

export async function getDb(): Promise<PGlite> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const location = typeof indexedDB !== 'undefined' ? 'idb://tradepilot' : undefined;
    const db = new PGlite(location);
    await db.exec(SCHEMA_SQL);
    await db.exec(`ALTER TABLE tp_account ADD COLUMN IF NOT EXISTS max_strategies integer NOT NULL DEFAULT 10;`);
    await db.exec(`ALTER TABLE tp_account ADD COLUMN IF NOT EXISTS loss_limit_pct numeric(5,2) NOT NULL DEFAULT 2.00;`);
    await db.exec(`ALTER TABLE tp_account ADD COLUMN IF NOT EXISTS risk_pause_until timestamptz;`);
    await db.exec(`ALTER TABLE tp_account ADD COLUMN IF NOT EXISTS fee_bps numeric(6,2) NOT NULL DEFAULT 10.00;`);
    await db.exec(`ALTER TABLE tp_account ADD COLUMN IF NOT EXISTS slippage_bps numeric(6,2) NOT NULL DEFAULT 2.00;`);
    await db.exec(`ALTER TABLE tp_account ADD COLUMN IF NOT EXISTS confidence_threshold_pct numeric(5,2) NOT NULL DEFAULT 75.00;`);
    await db.exec(`ALTER TABLE tp_account ADD COLUMN IF NOT EXISTS leverage numeric(5,2) NOT NULL DEFAULT 1.00;`);
    await db.exec(`UPDATE tp_account SET max_strategies = LEAST(GREATEST(max_strategies, 1), 10), max_allocation_pct = LEAST(max_allocation_pct, 20), leverage = LEAST(GREATEST(leverage, 1), 10), loss_limit_pct = LEAST(GREATEST(loss_limit_pct, 0.25), 20);`);
    await db.exec(SEED_SQL);
    dbInstance = db;
    return db;
  })();

  return initPromise;
}

export async function resetDatabase(): Promise<void> {
  const db = await getDb();
  await db.exec('DELETE FROM tp_snapshots;');
  await db.exec('DELETE FROM tp_trades;');
  await db.exec('DELETE FROM tp_positions;');
  await db.exec(
    `UPDATE tp_account SET cash=10000.00, equity=10000.00, total_pnl=0.00, realized_pnl=0.00, bot_status='STOPPED', started_at=NULL, last_tick_at=NULL, risk_pause_until=NULL, max_strategies=10, max_allocation_pct=20.00, leverage=1.00, loss_limit_pct=2.00, fee_bps=10.00, slippage_bps=2.00;`
  );
}

export async function query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const db = await getDb();
  const result = await db.query(sql, params ?? []);
  return (result.rows ?? []) as T[];
}

export async function execute(sql: string, params?: unknown[]): Promise<void> {
  const db = await getDb();
  await db.query(sql, params ?? []);
}
