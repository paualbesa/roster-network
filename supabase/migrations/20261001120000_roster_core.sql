-- Roster sandbox persistence.
-- Humans authenticate with Supabase Auth. The roster-api process uses the
-- service role after it checks an API key or a Supabase access token.
-- Agent callers stay on API keys (and the existing Solana escrow routes).
-- They do not receive a Supabase user.
--
-- capability_listings.embedding width is SEMANTIC_DIMENSIONS in
-- @albesa/registry (38*38 character bigrams + 128 token features = 1572).
-- Cosine distance matches the L2-normalized vectors the API already stores.
-- HNSW can be built on an empty table; IVFFlat cannot. Realtime is omitted.

-- vector may already live in public. Creating it again, or requiring schema
-- extensions before that schema exists, must not abort the migration.
create schema if not exists extensions;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'vector') then
    create extension vector with schema extensions;
  end if;
end
$$;

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create table public.organizations (
  id text primary key,
  name text not null,
  treasury_wallet_id text not null,
  mode text not null check (mode in ('sandbox', 'testnet')),
  created_at text not null
);

create table public.profiles (
  id text primary key,
  email text not null,
  display_name text not null,
  organization_id text not null references public.organizations (id) on delete cascade,
  auth_user_id uuid unique,
  created_at text not null
);

create unique index profiles_email_lower_idx on public.profiles (lower(email));
create index profiles_auth_user_id_idx on public.profiles (auth_user_id);
create index profiles_organization_id_idx on public.profiles (organization_id);

-- SQL functions resolve relations at create time, so profiles must exist first.
-- Authorization data lives on profiles.auth_user_id, never in user_metadata.
create or replace function private.current_organization_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.organization_id
  from public.profiles as p
  where p.auth_user_id = (select auth.uid())
  limit 1
$$;

revoke all on function private.current_organization_id() from public, anon;
grant execute on function private.current_organization_id() to authenticated, service_role;

create table public.password_hashes (
  user_id text primary key references public.profiles (id) on delete cascade,
  hash text not null
);

create table public.api_key_hashes (
  hash text primary key,
  organization_id text not null references public.organizations (id) on delete cascade
);

create index api_key_hashes_organization_id_idx on public.api_key_hashes (organization_id);

create table public.wallets (
  id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  owner_type text not null check (owner_type in ('organization', 'agent')),
  owner_id text not null,
  address text not null,
  chain text not null,
  asset text not null,
  created_at text not null
);

create index wallets_organization_id_idx on public.wallets (organization_id);
create unique index wallets_address_idx on public.wallets (address);

create table public.agents (
  id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  name text not null,
  wallet_id text not null,
  policy_id text not null,
  status text not null check (status in ('active', 'suspended')),
  created_at text not null
);

create index agents_organization_id_idx on public.agents (organization_id);

create table public.policies (
  id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  agent_id text not null,
  daily_spend_limit_usdc text not null,
  vendor_allowlist text[] not null,
  created_at text not null
);

create index policies_organization_id_idx on public.policies (organization_id);

-- Human-readable balances. The API reloads the full mock snapshot from
-- sandbox_wallet_state, which stays service-role only.
create table public.wallet_balances (
  address text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  balance_usdc text not null
);

create index wallet_balances_organization_id_idx on public.wallet_balances (organization_id);

create table public.sandbox_wallet_state (
  id text primary key,
  body jsonb not null
);

create table public.escrows (
  id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  seller_organization_id text not null,
  status text not null check (status in ('held', 'released', 'refunded')),
  body jsonb not null
);

create index escrows_organization_id_idx on public.escrows (organization_id);
create index escrows_seller_organization_id_idx on public.escrows (seller_organization_id);

create table public.transactions (
  id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  body jsonb not null
);

create index transactions_organization_id_idx on public.transactions (organization_id);

create table public.ledger_entries (
  id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  body jsonb not null
);

create index ledger_entries_organization_id_idx on public.ledger_entries (organization_id);

create table public.capability_listings (
  id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  status text not null check (status in ('active', 'paused')),
  body jsonb not null,
  embedding vector(1572)
);

create index capability_listings_organization_id_idx on public.capability_listings (organization_id);
create index capability_listings_embedding_hnsw
  on public.capability_listings
  using hnsw (embedding vector_cosine_ops);

create table public.jobs (
  id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  seller_organization_id text not null,
  status text not null check (status in ('held', 'released', 'refunded', 'timed_out')),
  body jsonb not null
);

create index jobs_organization_id_idx on public.jobs (organization_id);
create index jobs_seller_organization_id_idx on public.jobs (seller_organization_id);

create table public.listing_sellers (
  listing_id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  seller_agent_id text not null,
  autofill boolean not null,
  created_at text not null
);

create index listing_sellers_organization_id_idx on public.listing_sellers (organization_id);

create table public.reputation_totals (
  agent_id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  body jsonb not null
);

create index reputation_totals_organization_id_idx on public.reputation_totals (organization_id);

create table public.reputation_events (
  id text primary key,
  organization_id text not null references public.organizations (id) on delete cascade,
  agent_id text not null,
  body jsonb not null
);

create index reputation_events_organization_id_idx on public.reputation_events (organization_id);
create index reputation_events_agent_id_idx on public.reputation_events (agent_id);

-- Semantic search. security invoker so RLS applies to authenticated callers.
-- The API calls this with the service role.
create or replace function public.match_capability_listings(
  query_embedding vector(1572),
  match_count integer
)
returns table (id text, similarity double precision)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select listings.id,
         (1 - (listings.embedding <=> query_embedding))::double precision as similarity
  from public.capability_listings as listings
  where listings.status = 'active'
    and listings.embedding is not null
  order by listings.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 1), 1), 200)
$$;

revoke all on function public.match_capability_listings(vector(1572), integer) from public, anon;
grant execute on function public.match_capability_listings(vector(1572), integer) to authenticated, service_role;

alter table public.organizations enable row level security;
alter table public.organizations force row level security;
alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.password_hashes enable row level security;
alter table public.password_hashes force row level security;
alter table public.api_key_hashes enable row level security;
alter table public.api_key_hashes force row level security;
alter table public.wallets enable row level security;
alter table public.wallets force row level security;
alter table public.agents enable row level security;
alter table public.agents force row level security;
alter table public.policies enable row level security;
alter table public.policies force row level security;
alter table public.wallet_balances enable row level security;
alter table public.wallet_balances force row level security;
alter table public.sandbox_wallet_state enable row level security;
alter table public.sandbox_wallet_state force row level security;
alter table public.escrows enable row level security;
alter table public.escrows force row level security;
alter table public.transactions enable row level security;
alter table public.transactions force row level security;
alter table public.ledger_entries enable row level security;
alter table public.ledger_entries force row level security;
alter table public.capability_listings enable row level security;
alter table public.capability_listings force row level security;
alter table public.jobs enable row level security;
alter table public.jobs force row level security;
alter table public.listing_sellers enable row level security;
alter table public.listing_sellers force row level security;
alter table public.reputation_totals enable row level security;
alter table public.reputation_totals force row level security;
alter table public.reputation_events enable row level security;
alter table public.reputation_events force row level security;

revoke all on table public.password_hashes from anon, authenticated;
revoke all on table public.api_key_hashes from anon, authenticated;
revoke all on table public.sandbox_wallet_state from anon, authenticated;

grant select, insert, update, delete on table public.organizations to service_role;
grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.password_hashes to service_role;
grant select, insert, update, delete on table public.api_key_hashes to service_role;
grant select, insert, update, delete on table public.wallets to service_role;
grant select, insert, update, delete on table public.agents to service_role;
grant select, insert, update, delete on table public.policies to service_role;
grant select, insert, update, delete on table public.wallet_balances to service_role;
grant select, insert, update, delete on table public.sandbox_wallet_state to service_role;
grant select, insert, update, delete on table public.escrows to service_role;
grant select, insert, update, delete on table public.transactions to service_role;
grant select, insert, update, delete on table public.ledger_entries to service_role;
grant select, insert, update, delete on table public.capability_listings to service_role;
grant select, insert, update, delete on table public.jobs to service_role;
grant select, insert, update, delete on table public.listing_sellers to service_role;
grant select, insert, update, delete on table public.reputation_totals to service_role;
grant select, insert, update, delete on table public.reputation_events to service_role;

create policy organizations_select_own
  on public.organizations
  for select
  to authenticated
  using (id = (select private.current_organization_id()));

create policy profiles_select_self
  on public.profiles
  for select
  to authenticated
  using (auth_user_id = (select auth.uid()));

create policy wallets_select_own
  on public.wallets
  for select
  to authenticated
  using (organization_id = (select private.current_organization_id()));

create policy agents_select_own
  on public.agents
  for select
  to authenticated
  using (organization_id = (select private.current_organization_id()));

create policy policies_select_own
  on public.policies
  for select
  to authenticated
  using (organization_id = (select private.current_organization_id()));

create policy wallet_balances_select_own
  on public.wallet_balances
  for select
  to authenticated
  using (organization_id = (select private.current_organization_id()));

create policy escrows_select_party
  on public.escrows
  for select
  to authenticated
  using (
    organization_id = (select private.current_organization_id())
    or seller_organization_id = (select private.current_organization_id())
  );

create policy transactions_select_own
  on public.transactions
  for select
  to authenticated
  using (organization_id = (select private.current_organization_id()));

create policy ledger_entries_select_own
  on public.ledger_entries
  for select
  to authenticated
  using (organization_id = (select private.current_organization_id()));

-- The capability index and passports are readable by any signed-in human.
-- Writes stay on the service role. No insert/update/delete policies exist.
create policy capability_listings_select_authenticated
  on public.capability_listings
  for select
  to authenticated
  using (true);

create policy jobs_select_party
  on public.jobs
  for select
  to authenticated
  using (
    organization_id = (select private.current_organization_id())
    or seller_organization_id = (select private.current_organization_id())
  );

create policy listing_sellers_select_own
  on public.listing_sellers
  for select
  to authenticated
  using (organization_id = (select private.current_organization_id()));

create policy reputation_totals_select_authenticated
  on public.reputation_totals
  for select
  to authenticated
  using (true);

create policy reputation_events_select_authenticated
  on public.reputation_events
  for select
  to authenticated
  using (true);
