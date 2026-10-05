-- Developer waitlist from the roster.network landing page.
-- Written only by roster-api with the service role. No client policies.
create table if not exists public.waitlist_entries (
  email text primary key check (email = lower(email) and char_length(email) between 3 and 254),
  source text check (source is null or char_length(source) <= 64),
  created_at timestamptz not null default now()
);

create index if not exists waitlist_entries_created_at_idx on public.waitlist_entries (created_at desc);

alter table public.waitlist_entries enable row level security;
alter table public.waitlist_entries force row level security;

revoke all on table public.waitlist_entries from anon, authenticated;
grant select, insert, update, delete on table public.waitlist_entries to service_role;
