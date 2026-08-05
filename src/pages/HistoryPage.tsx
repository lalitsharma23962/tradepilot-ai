import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Badge, Card, CardBody, CardHeader, EmptyState, LoadingState, Table } from '@/components/ui';
import { fmtDateTime, fmtMoney, fmtNum, fmtPct, pnlClass } from '@/lib/format';

export function HistoryPage() {
  const { conn, trades } = useApp();
  const [search, setSearch] = useState('');
  const [sideFilter, setSideFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');

  const filtered = useMemo(() => {
    return trades.filter((t) => {
      if (sideFilter !== 'ALL' && t.side !== sideFilter) return false;
      if (search && !t.symbol.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [trades, search, sideFilter]);

  if (conn === 'loading' && !trades.length) {
    return <div className="p-6"><LoadingState message="Loading trade history…" /></div>;
  }

  return (
    <div className="space-y-6 p-6">
      <Card>
        <CardHeader title="Trade History" subtitle="Closed paper trades" action={<Badge tone="accent">PAPER</Badge>} />
        <CardBody>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search symbol…"
                className="w-56 rounded-lg border border-slate-700 bg-slate-800 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div className="flex gap-1">
              {(['ALL', 'LONG', 'SHORT'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSideFilter(s)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    sideFilter === s ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <span className="ml-auto text-xs text-slate-500">{filtered.length} trades</span>
          </div>
        </CardBody>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <EmptyState title="No trades found" message="Closed paper trades will appear here once the bot makes some." />
          ) : (
            <Table
              headers={['Time', 'Symbol', 'Side', 'Entry', 'Exit', 'Qty', 'PnL', 'Return', 'Strategy', 'Status']}
              rows={filtered.map((t) => [
                fmtDateTime(t.closed_at),
                t.symbol,
                <Badge tone={t.side === 'LONG' ? 'positive' : 'negative'}>{t.side}</Badge>,
                fmtMoney(t.entry_price, t.entry_price >= 100 ? 2 : 4),
                fmtMoney(t.exit_price, t.exit_price >= 100 ? 2 : 4),
                fmtNum(t.quantity, 4),
                <span className={pnlClass(t.pnl)}>{fmtMoney(t.pnl)}</span>,
                <span className={pnlClass(t.return_pct)}>{fmtPct(t.return_pct)}</span>,
                t.strategy,
                <Badge tone="neutral">{t.status}</Badge>,
              ])}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
