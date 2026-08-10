import { fetchHistoricalCandles, type Candle } from '../src/lib/backtestV6';
import { TRADING_CONFIG } from '../src/lib/tradingConfig';
import { evaluateWithDiagnostics, type DiagnosticRecord } from '../src/lib/strategyV35Diagnostics';
import { MIN_INDEPENDENT_SAMPLES } from '../src/lib/strategyV35';
import * as fs from 'fs';
import * as path from 'path';

const DATA_API = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOL = 'BTCUSDT';
const INTERVALS = ['1h', '4h'] as const;
const YEAR_BARS: Record<'1h' | '4h', number> = {
  '1h': 365 * 24,
  '4h': Math.floor(365 * 24 / 4),
};

function intervalMs(x: string) {
  const m = x.match(/^(\d+)([mhd])$/i);
  if (!m) throw new Error(`Unsupported interval: ${x}`);
  const n = +m[1];
  const u = m[2].toLowerCase();
  return n * (u === 'm' ? 60000 : u === 'h' ? 3600000 : 86400000);
}

async function fetchAbsolute(symbol: string, interval: string, total: number): Promise<Candle[]> {
  const ms = intervalMs(interval);
  const rows: unknown[][] = [];
  let cursor = Math.max(0, Date.now() - (total + 20) * ms);
  while (rows.length < total + 20) {
    const limit = Math.min(1000, total + 20 - rows.length);
    const q = new URLSearchParams({ symbol, interval, startTime: String(cursor), limit: String(limit) });
    const res = await fetch(`${DATA_API}?${q}`);
    if (!res.ok) throw new Error(`Binance historical request failed ${res.status}`);
    const batch = await res.json() as unknown[][];
    if (!batch.length) break;
    rows.push(...batch);
    const last = Number(batch.at(-1)?.[0]);
    if (!Number.isFinite(last)) break;
    cursor = last + ms;
    if (batch.length < limit) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  const seen = new Set<number>();
  return rows
    .map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }))
    .filter((c) => [c.openTime, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) && c.openTime + ms <= Date.now() && !seen.has(c.openTime) && seen.add(c.openTime))
    .sort((a, b) => a.openTime - b.openTime)
    .slice(-total);
}

function writeJsonl(records: DiagnosticRecord[], filePath: string) {
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, lines + (lines.length ? '\n' : ''));
}

async function collectInterval(interval: '1h' | '4h', outDir: string) {
  const yearBars = YEAR_BARS[interval];
  const horizon = TRADING_CONFIG.maxBarsInTrade[interval] ?? TRADING_CONFIG.maxBarsInTrade['5m'];
  const warmup = Math.max(TRADING_CONFIG.lookback, 160, MIN_INDEPENDENT_SAMPLES * horizon + horizon + 21);
  const totalNeeded = yearBars + warmup;

  console.log(`[${interval}] fetching ${totalNeeded} candles...`);
  const candles = await fetchAbsolute(SYMBOL, interval, totalNeeded);
  if (candles.length < totalNeeded) {
    throw new Error(`${interval}: received ${candles.length}, need ${totalNeeded}`);
  }

  const startIdx = candles.length - yearBars;
  const records: DiagnosticRecord[] = [];

  console.log(`[${interval}] evaluating ${yearBars} bars...`);
  for (let i = startIdx; i < candles.length; i++) {
    const hist = candles.slice(0, i + 1);
    const record = evaluateWithDiagnostics(hist, SYMBOL, interval, {
      lookback: TRADING_CONFIG.lookback,
      feeBps: TRADING_CONFIG.feeBps,
      slippageBps: TRADING_CONFIG.slippageBps,
      minScore: TRADING_CONFIG.minScore,
      minStopAtr: TRADING_CONFIG.minStopAtr,
      maxStructuralRiskAtr: TRADING_CONFIG.maxStructuralRiskAtr,
      maxCostFractionOfRisk: 0.15,
      swingLookback: TRADING_CONFIG.swingLookback,
      capacityHorizonBars: horizon,
      capacityBars: hist,
      targetMultiplesR: [1, 1.5, 2],
    });
    records.push(record);
  }

  const filePath = path.join(outDir, `feature-attribution-${interval}.jsonl`);
  writeJsonl(records, filePath);
  const accepted = records.filter((r) => r.action !== 'WAIT');
  const withPaths = accepted.filter((r) => r.netExpectedR !== undefined);
  console.log(`[${interval}] wrote ${records.length} records (${accepted.length} accepted, ${withPaths.length} with path outcomes) to ${filePath}`);
}

async function main() {
  const outDir = path.resolve(process.cwd(), 'diagnostics');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const interval of INTERVALS) {
    await collectInterval(interval, outDir);
  }
  console.log('Done. Run scripts/feature-attribution-analyze.py next.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
