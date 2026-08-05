import { Bot, LayoutDashboard, CandlestickChart, Wallet, History, BarChart3, Settings as SettingsIcon } from 'lucide-react';
import { Badge } from './ui';

export type Page = 'dashboard' | 'trading' | 'portfolio' | 'history' | 'analytics' | 'settings';

const NAV: { id: Page; label: string; icon: typeof Bot }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'trading', label: 'Trading', icon: CandlestickChart },
  { id: 'portfolio', label: 'Portfolio', icon: Wallet },
  { id: 'history', label: 'Trade History', icon: History },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function Sidebar({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  return (
    <aside className="flex h-full w-60 flex-col border-r border-slate-800 bg-slate-950">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-600">
          <Bot className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-sm font-bold tracking-tight text-white">TRADEPILOT AI</h1>
          <p className="text-[10px] uppercase tracking-wider text-slate-500">Paper Trading</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? 'bg-sky-600/15 text-sky-400'
                  : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
              }`}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-slate-800 px-5 py-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Mode</span>
          <Badge tone="accent">PAPER</Badge>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
          Simulated trading only. No real exchange, no real money.
        </p>
      </div>
    </aside>
  );
}
