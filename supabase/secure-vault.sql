create table if not exists public.tradepilot_secret_vault (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  encrypted_api_key text not null,
  encrypted_api_secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tradepilot_secret_vault enable row level security;

-- No client/browser policy is granted. The service-role key used by the
-- serverless vault endpoint is the only intended database access path.
revoke all on public.tradepilot_secret_vault from anon, authenticated;
