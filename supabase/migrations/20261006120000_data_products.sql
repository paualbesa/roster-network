-- Roster Data: first-party data products and the unmet-demand log.
-- Written only by roster-api with the service role. No client policies.
-- Product files (latest.json / latest.csv per product) live in the private
-- `data-products` bucket; buyers get short-lived signed URLs after escrow settles.

create table if not exists public.data_products (
  slug text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  kind text not null check (kind in ('dataset', 'feed', 'lookup')),
  name text not null,
  status text not null default 'pending' check (status in ('ok', 'error', 'pending')),
  last_refreshed_at timestamptz,
  last_attempt_at timestamptz,
  row_count integer not null default 0 check (row_count >= 0),
  bytes bigint not null default 0 check (bytes >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  duration_ms integer,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  sample jsonb not null default '[]'::jsonb,
  columns jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.unmet_needs (
  id text primary key,
  need text not null check (char_length(need) between 1 and 500),
  normalized text not null,
  count integer not null default 1 check (count >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  best_score real not null default 0,
  best_listing_name text,
  budget_usdc text,
  kind text,
  organization_id text
);

create index if not exists unmet_needs_rank_idx on public.unmet_needs (count desc, last_seen_at desc);

alter table public.data_products enable row level security;
alter table public.data_products force row level security;
alter table public.unmet_needs enable row level security;
alter table public.unmet_needs force row level security;

revoke all on table public.data_products from anon, authenticated;
revoke all on table public.unmet_needs from anon, authenticated;
grant select, insert, update, delete on table public.data_products to service_role;
grant select, insert, update, delete on table public.unmet_needs to service_role;

-- Private bucket, service role only; 50 MB per object, JSON and CSV only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('data-products', 'data-products', false, 52428800, array['application/json', 'text/csv'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
