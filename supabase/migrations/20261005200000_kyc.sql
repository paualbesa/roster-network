-- Tiered free KYC with manual review.
-- Written only by roster-api with the service role. No client policies.
-- Data minimization: kyc_profiles.body holds the applicant fields (legal name,
-- country, date of birth or company registration number) and document metadata.
-- The document itself lives in the private `kyc-documents` bucket and can be
-- deleted by an operator after review; the decision and audit trail remain.

create table if not exists public.kyc_profiles (
  organization_id text primary key references public.organizations (id) on delete cascade,
  status text not null check (status in ('none', 'pending', 'approved', 'rejected')),
  tier smallint not null default 0 check (tier in (0, 1)),
  body jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists kyc_profiles_status_idx on public.kyc_profiles (status, updated_at desc);

create table if not exists public.kyc_audit_log (
  id text primary key,
  organization_id text not null,
  action text not null check (action in ('submitted', 'approved', 'rejected', 'document_viewed', 'document_deleted')),
  actor text not null check (char_length(actor) between 1 and 120),
  reason text check (reason is null or char_length(reason) <= 500),
  at timestamptz not null default now()
);

create index if not exists kyc_audit_log_org_idx on public.kyc_audit_log (organization_id, at desc);

alter table public.kyc_profiles enable row level security;
alter table public.kyc_profiles force row level security;
alter table public.kyc_audit_log enable row level security;
alter table public.kyc_audit_log force row level security;

revoke all on table public.kyc_profiles from anon, authenticated;
revoke all on table public.kyc_audit_log from anon, authenticated;
grant select, insert, update, delete on table public.kyc_profiles to service_role;
grant select, insert, update, delete on table public.kyc_audit_log to service_role;

-- Private bucket: no public URLs, 5 MB cap, ID document types only.
-- Access is service-role only (no storage.objects policies for anon/authenticated);
-- operators preview through signed URLs with a 60 s TTL issued by roster-api.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc-documents', 'kyc-documents', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
