-- Seller profiles (payout address, founding seat) and private endpoints of imported listings.
create table if not exists public.seller_records (
  id text primary key,
  kind text not null check (kind in ('profile', 'endpoint')),
  organization_id text not null,
  body jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists seller_records_org_idx on public.seller_records (organization_id);

alter table public.seller_records enable row level security;
alter table public.seller_records force row level security;
revoke all on table public.seller_records from anon, authenticated;
grant select, insert, update, delete on table public.seller_records to service_role;

-- Recent request timestamps for the public demand board's "this week" counts.
alter table public.unmet_needs add column if not exists recent_seen jsonb not null default '[]'::jsonb;
