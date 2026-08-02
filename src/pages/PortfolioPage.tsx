import { useApp } from '@/lib/store';
import * as api from '@/lib/api';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, LoadingState, StatCard, Table } from '@/components/ui';
import { fmtMoney, fmtNum, fmtPct, pnlClass } from '@/lib/format';
import { useState } from 'react';

export function PortfolioPage() {
  const { conn, account, positions, refresh } = useApp();
  const [busy, setBusy] = useState<string | null>(null);

  if (conn === 'loading' && !account) {
    return <div className="p-6"><LoadingState message="Loading portfolio…" /></div>;
  }

  const openValue = positions.reduce((a, p) => a + p.notional, 0);
  const unrealized = positions.reduce((a, p) => a + p.unrealized_pnl, 0);

  const handleClose = async (id: string) => {
    setBusy(id);
    await api.closePositionApi(id);
    refresh();
    setBusy(null);
  };

  const handleCloseAll = async () => {
    setBusy('all');
    await api.closeAllApi();
    refresh();
    setBusy(null);
  };

  return (
    <div className="space-y-6 p-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Equity" value={fmtMoney(account?.equity)} tone="accent" />
        <StatCard label="Cash" value={fmtMoney(account?.cash)} />
        <StatCard label="Open Position Value" value={fmtMoney(openValue)} />
        <StatCard label="Unrealized PnL" value={fmtMoney(unrealized)} tone={unrealized >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Realized PnL" value={fmtMoney(account?.realized_pnl)} tone={(account?.realized_pnl ?? 0) >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Total PnL" value={fmtMoney(account?.total_pnl)} tone={(account?.total_pnl ?? 0) >= 0 ? 'positive' : 'negative'} />
      </div>

      <Card>
        <CardHeader
          title="Open Positions"
          subtitle="All values from the paper-trading engine"
          action={
            <div className="flex items-center gap-2">
              <Badge tone="accent">PAPER</Badge>
              {positions.length > 0 && (
                <Button size="sm" variant="secondary" onClick={handleCloseAll} disabled={busy === 'all'}>
                  Close All
                </Button>
              )}
            </div>
          }
        />
        <CardBody className="p-0">
          {positions.length === 0 ? (
            <EmptyState title="No open positions" message="Start the paper bot to open simulated positions." />
          ) : (
            <Table
              headers={['Symbol', 'Side', 'Qty', 'Entry', 'Current', 'Notional', 'Unrealized PnL', 'SL', 'TP', 'Status', '']}
              rows={positions.map((p) => [
                p.symbol,
                <Badge tone={p.side === 'LONG' ? 'positive' : 'negative'}>{p.side}</Badge>,
                fmtNum(p.quantity, 4),
                fmtMoney(p.entry_price, p.entry_price >= 100 ? 2 : 4),
                fmtMoney(p.current_price, p.current_price >= 100 ? 2 : 4),
                fmtMoney(p.notional),
                <span className={pnlClass(p.unrealized_pnl)}>{fmtMoney(p.unrealized_pnl)}</span>,
                fmtMoney(p.stop_loss, p.stop_loss >= 100 ? 2 : 4),
                fmtMoney(p.take_profit, p.take_profit >= 100 ? 2 : 4),
                <Badge tone="accent">{p.status}</Badge>,
                <Button size="sm" variant="ghost" onClick={() => handleClose(p.id)} disabled={busy === p.id}>
                  Close
                </Button>,
              ])}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
