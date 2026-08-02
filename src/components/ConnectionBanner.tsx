import { useApp } from '@/lib/store';

export function ConnectionBanner() {
  const { conn, errors } = useApp();

  if (conn === 'connected' || conn === 'loading') return null;

  if (conn === 'down') {
    return (
      <div className="border-b border-red-900 bg-red-950/80 px-6 py-3 text-sm text-red-200">
        <p className="font-semibold">Backend unavailable</p>
        <p className="mt-0.5 text-xs text-red-300/80">
          The paper-trading engine could not be reached. The app uses an in-browser database, so this usually means
          the page is still initializing. It will reconnect automatically.
        </p>
        {Object.keys(errors).length > 0 && (
          <p className="mt-1 text-xs text-red-400/70">
            Failed: {Object.keys(errors).join(', ')}
          </p>
        )}
      </div>
    );
  }

  // partial
  const failed = Object.keys(errors);
  return (
    <div className="border-b border-amber-900 bg-amber-950/80 px-6 py-2.5 text-sm text-amber-200">
      <p className="text-xs">
        <span className="font-semibold">Partial connection:</span> some data sources failed ({failed.join(', ')}).
        Other sections are still showing live data and will recover automatically.
      </p>
    </div>
  );
}
