import { useState } from 'react';
import { AppProvider } from '@/lib/store';
import { Sidebar, type Page } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { ConnectionBanner } from '@/components/ConnectionBanner';
import { DashboardPage } from '@/pages/DashboardPage';
import { TradingPage } from '@/pages/TradingPage';
import { PortfolioPage } from '@/pages/PortfolioPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { SettingsPage } from '@/pages/SettingsPage';

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');

  return (
    <AppProvider>
      <div className="flex h-screen overflow-hidden bg-slate-900 text-slate-200">
        <Sidebar page={page} onNavigate={setPage} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar page={page} />
          <ConnectionBanner />
          <main className="flex-1 overflow-y-auto">
            {page === 'dashboard' && <DashboardPage />}
            {page === 'trading' && <TradingPage />}
            {page === 'portfolio' && <PortfolioPage />}
            {page === 'history' && <HistoryPage />}
            {page === 'analytics' && <AnalyticsPage />}
            {page === 'settings' && <SettingsPage />}
          </main>
        </div>
      </div>
    </AppProvider>
  );
}
