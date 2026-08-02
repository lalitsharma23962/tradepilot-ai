import { useState } from 'react';
import { Lock, AlertTriangle, RotateCcw } from 'lucide-react';
import { useApp } from '@/lib/store';
import * as api from '@/lib/api';
import { Badge, Button, Card, CardBody, CardHeader, LoadingState } from '@/components/ui';
import type { RiskLevel, ThemeMode } from '@/lib/types';

export function SettingsPage() {
  const { settings, refresh } = useApp();
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  if (!settings) {
    return <div className="p-6"><LoadingState message="Loading settings…" /></div>;
  }

  const update = async (patch: Partial<typeof settings>) => {
    setSaving(true);
    await api.updateSettingsApi(patch);
    refresh();
    setSaving(false);
  };

  const handleReset = async () => {
    setResetting(true);
    setResetMsg(null);
    const res = await api.resetApi();
    if (res.ok) setResetMsg(res.data?.message ?? 'Account reset.');
    else setResetMsg(res.error ?? 'Reset failed.');
    refresh();
    setResetting(false);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {/* Trading mode */}
      <Card>
        <CardHeader title="Trading Mode" subtitle="Paper trading is active. Live trading is not available." />
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-emerald-400">PAPER TRADING</p>
              <p className="text-xs text-slate-500">Active — simulated trades only</p>
            </div>
            <Badge tone="positive">Active</Badge>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-800/30 px-4 py-3 opacity-60">
            <div>
              <p className="text-sm font-semibold text-slate-400">LIVE TRADING</p>
              <p className="text-xs text-slate-600">Not available yet</p>
            </div>
            <Badge tone="neutral"><Lock className="mr-1 h-3 w-3" />Disabled</Badge>
          </div>
        </CardBody>
      </Card>

      {/* API keys — informational only */}
      <Card>
        <CardHeader title="Exchange API Keys" subtitle="Not required for paper trading" />
        <CardBody className="space-y-3">
          <div className="rounded-lg bg-slate-800/40 px-4 py-3">
            <p className="text-xs text-slate-400">
              No exchange credentials are required. Paper trading only. This app does not connect to Binance,
              Coinbase, Freqtrade, or any exchange. No credentials are sent or stored.
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">API Key</label>
            <input
              disabled
              placeholder="Disabled — paper trading only"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm text-slate-500 placeholder-slate-600"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">API Secret</label>
            <input
              disabled
              type="password"
              placeholder="Disabled — paper trading only"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm text-slate-500 placeholder-slate-600"
            />
          </div>
        </CardBody>
      </Card>

      {/* Risk level */}
      <Card>
        <CardHeader title="Risk Level" />
        <CardBody>
          <div className="grid grid-cols-3 gap-2">
            {(['Conservative', 'Balanced', 'Aggressive'] as RiskLevel[]).map((r) => (
              <button
                key={r}
                onClick={() => update({ risk_level: r })}
                disabled={saving}
                className={`rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  settings.risk_level === r
                    ? 'bg-sky-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* Max position size */}
      <Card>
        <CardHeader title="Maximum Position Size" subtitle="5%–20% of equity. Hard limit: 20%." />
        <CardBody className="space-y-3">
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={5}
              max={20}
              step={1}
              value={settings.max_allocation_pct}
              onChange={(e) => update({ max_allocation_pct: Number(e.target.value) })}
              disabled={saving}
              className="flex-1 accent-sky-500"
            />
            <span className="w-14 text-right text-sm font-semibold text-sky-400">{settings.max_allocation_pct}%</span>
          </div>
          <p className="text-xs text-slate-500">Default allocation: {settings.default_allocation_pct}%. Engine enforces the 20% hard cap server-side.</p>
        </CardBody>
      </Card>

      {/* SL / TP */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title="Stop Loss" subtitle="Default 2%" />
          <CardBody>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={settings.stop_loss_pct}
                onChange={(e) => update({ stop_loss_pct: Number(e.target.value) })}
                disabled={saving}
                className="flex-1 accent-red-500"
              />
              <span className="w-14 text-right text-sm font-semibold text-red-400">{settings.stop_loss_pct}%</span>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Take Profit" subtitle="Default 4%" />
          <CardBody>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={1}
                max={20}
                step={0.5}
                value={settings.take_profit_pct}
                onChange={(e) => update({ take_profit_pct: Number(e.target.value) })}
                disabled={saving}
                className="flex-1 accent-emerald-500"
              />
              <span className="w-14 text-right text-sm font-semibold text-emerald-400">{settings.take_profit_pct}%</span>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Theme */}
      <Card>
        <CardHeader title="Theme" />
        <CardBody>
          <div className="grid grid-cols-3 gap-2">
            {(['Dark', 'Light', 'System'] as ThemeMode[]).map((t) => (
              <button
                key={t}
                onClick={() => update({ theme: t })}
                disabled={saving}
                className={`rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  settings.theme === t ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* Notifications */}
      <Card>
        <CardHeader title="Notifications" />
        <CardBody className="space-y-3">
          {[
            { key: 'trade_alerts' as const, label: 'Trade Alerts' },
            { key: 'pnl_alerts' as const, label: 'PnL Updates' },
            { key: 'risk_alerts' as const, label: 'Risk Alerts' },
          ].map((item) => (
            <label key={item.key} className="flex items-center justify-between rounded-lg bg-slate-800/40 px-4 py-3">
              <span className="text-sm text-slate-300">{item.label}</span>
              <button
                onClick={() => update({ [item.key]: !settings[item.key] } as Partial<typeof settings>)}
                disabled={saving}
                className={`relative h-6 w-11 rounded-full transition-colors ${settings[item.key] ? 'bg-sky-600' : 'bg-slate-700'}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${settings[item.key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </label>
          ))}
        </CardBody>
      </Card>

      {/* Reset */}
      <Card>
        <CardHeader title="Development Reset" subtitle="Reset account to $10,000 and clear all history" />
        <CardBody>
          <div className="flex items-center gap-3">
            <Button variant="danger" onClick={handleReset} disabled={resetting}>
              <RotateCcw className="h-4 w-4" />
              Reset Account
            </Button>
            {resetMsg && <span className="text-xs text-slate-400">{resetMsg}</span>}
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-950/40 px-3 py-2 text-xs text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>This clears all positions, trades, and snapshots and restores the initial $10,000 balance.</span>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
