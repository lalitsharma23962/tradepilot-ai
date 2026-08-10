import { useEffect, useState } from 'react';
import { Play, Square, RotateCcw, Activity, Clock } from 'lucide-react';
import { useApp } from '@/lib/store';
import * as api from '@/lib/api';
import { Badge, Button } from './ui';
import { fmtDuration, fmtMoney } from '@/lib/format';
import type { Page } from './Sidebar';

const PAGE_TITLES: Record<Page, string> = {
  dashboard: 'Dashboard', trading: 'Trading', portfolio: 'Portfolio', history: 'Trade History', analytics: 'Analytics', settings: 'Settings',
};

export function TopBar({ page }: { page: Page }) {
  const { account, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [uptime, setUptime] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [gateStatus, setGateStatus] = useState<'VALIDATED' | 'REJECTED' | null>(null);
  const running = account?.bot_status === 'RUNNING';
  const gateValidated = gateStatus === 'VALIDATED';

  useEffect(() => {
    let mounted = true;
    const loadGate = async () => {
      const res = await api.validationGateApi();
      if (mounted && res.ok && res.data) setGateStatus(res.data.status);
    };
    loadGate();
    const id = setInterval(loadGate, 3000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!running) { setUptime(0); return; }
    const id = setInterval(() => {
      if (account?.started_at) setUptime(Math.round((Date.now() - new Date(account.started_at).getTime()) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [running, account?.started_at]);

  const handleStart = async () => {
    setBusy(true); setMsg(null);
    const res = await api.botStart();
    if (!res.ok) setMsg(res.error ?? 'Paper bot cannot start yet');
    else setMsg(res.data?.message ?? 'Started');
    refresh();
    setTimeout(() => setBusy(false), 600);
  };

  const handleStop = async () => {
    setBusy(true); setMsg(null);
    const res = await api.botStop();
    if (!res.ok) setMsg(res.error ?? 'Failed to stop');
    else setMsg(res.data?.message ?? 'Stopped');
    refresh();
    setTimeout(() => setBusy(false), 600);
  };

  const handleRestart = async () => {
    setBusy(true); setMsg(null);
    const res = await api.botRestart();
    if (!res.ok) setMsg(res.error ?? 'Paper bot cannot restart yet');
    else setMsg(res.data?.message ?? 'Restarted');
    refresh();
    setTimeout(() => setBusy(false), 600);
  };

  return <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-slate-800 bg-slate-900/80 px-6 backdrop-blur-md">
    <div className="flex items-center gap-4">
      <h2 className="text-lg font-semibold text-white">{PAGE_TITLES[page]}</h2>
      <Badge tone={running ? 'positive' : 'neutral'}>
        <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${running ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
        {running ? 'Bot Running' : 'Bot Stopped'}
      </Badge>
      {!gateValidated && !running && <Badge tone="negative">Validation Required</Badge>}
      {running && <span className="flex items-center gap-1 text-xs text-slate-500"><Clock className="h-3.5 w-3.5" />{fmtDuration(uptime)}</span>}
    </div>
    <div className="flex items-center gap-3">
      {msg && <span className="max-w-sm text-right text-xs text-slate-400">{msg}</span>}
      <div className="flex items-center gap-1.5 text-xs text-slate-500"><Activity className="h-3.5 w-3.5" /><span className="tabular-nums">{fmtMoney(account?.equity)}</span></div>
      <div className="flex items-center gap-2">
        {!running ? (
          <Button onClick={handleStart} disabled={busy} size="sm">
            <Play className="h-3.5 w-3.5" />Start Paper Bot
          </Button>
        ) : (
          <Button onClick={handleStop} disabled={busy} variant="danger" size="sm"><Square className="h-3.5 w-3.5" />Stop Paper Bot</Button>
        )}
        <Button onClick={handleRestart} disabled={busy} variant="secondary" size="sm">
          <RotateCcw className="h-3.5 w-3.5" />Restart
        </Button>
      </div>
    </div>
  </header>;
}
