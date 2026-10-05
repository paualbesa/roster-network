# Tiered free KYC (manual review)

KYC on Roster is free and tiered. It caps **escrow volume an organization locks as
buyer over a rolling 30 days** (held + released escrows; refunds do not count).

| Tier | How you get it | Default cap | Env |
|---|---|---|---|
| 0 | Every organization: wallet + verified email (Supabase Auth) or API key | 1,000 USDC / 30 days | `ROSTER_KYC_T0_LIMIT_USDC` |
| 1 | Submit basic info + one ID document; an operator approves it | 25,000 USDC / 30 days | `ROSTER_KYC_T1_LIMIT_USDC` |

## API

- `GET /v1/kyc`: tier, status (`none` | `pending` | `approved` | `rejected`),
  `usedUsdc`, `limitUsdc`, `remainingUsdc`, `windowDays`, rejection reason, upgrade hint.
- `POST /v1/kyc/submission` (multipart/form-data): `entityType` (`individual` |
  `company`), `legalName`, `country` (ISO 3166-1 alpha-2), `dateOfBirth` (individual,
  18+) or `companyRegNo` (company), and `document` (JPEG, PNG, WebP or PDF, max 5 MB).
  The file type is checked by magic bytes; the declared content type is ignored.
- Enforcement: `POST /v1/escrows` and `POST /v1/jobs` return **403** when the lock
  would exceed the cap:

```json
{
  "error": {
    "code": "kyc_limit_exceeded",
    "message": "This lock would take escrow volume to 1200.000000 USDC over the rolling 30 days; the Tier 0 limit is 1000.000000 USDC.",
    "tier": 0,
    "kycStatus": "none",
    "windowDays": 30,
    "usedUsdc": "900.000000",
    "requestedUsdc": "300.000000",
    "limitUsdc": "1000.000000",
    "remainingUsdc": "100.000000",
    "upgrade": { "tier": 1, "limitUsdc": "25000.000000", "status": "none", "how": "...", "endpoint": "POST /v1/kyc/submission", "console": "/console/kyc" }
  }
}
```

Admin (`/v1/admin/*`, operator token):

- `GET /v1/admin/kyc?status=pending|approved|rejected|all`: queue + audit log.
- `POST /v1/admin/kyc/:orgId/document-url` `{ reviewer }`: signed URL, 60 s TTL. Logged as `document_viewed`.
- `POST /v1/admin/kyc/:orgId/approve` `{ reviewer }`
- `POST /v1/admin/kyc/:orgId/reject` `{ reviewer, reason }` (reason required; shown to the applicant)
- `DELETE /v1/admin/kyc/:orgId/document` `{ reviewer }`: only after a decision.

The console has `/console/kyc` (tier, usage bar, form). `/admin` has a KYC tab
(queue, document preview, approve/reject with reason, delete document, audit log).

## Storage

- Documents go to the **private** Supabase Storage bucket `kyc-documents`
  (`public = false`, 5 MB limit, image/jpeg, image/png, image/webp, application/pdf),
  created by `supabase/migrations/20261005200000_kyc.sql`. There are no storage
  policies for `anon`/`authenticated`; only roster-api (service role) reads or writes.
- Operators preview through **signed URLs that expire after 60 seconds**. No public URL exists.
- Object path: `<organizationId>/<random id>.<ext>`. No names in paths.
- Profiles live in `kyc_profiles` (RLS forced, service role only) and every
  action goes to `kyc_audit_log` (who, what, when, reason).
- JSON-file mode (no Supabase) keeps documents under `data/kyc-documents` and
  serves HMAC-signed, 60-second preview links from the API.

## Data minimization and GDPR

- **Collected:** legal name, country, date of birth *or* company registration number,
  one ID document, and document metadata (type, size, SHA-256, upload time). Nothing else:
  no address, no selfie, no ID number extraction, no automated biometric processing.
- **Purpose and legal basis:** fraud prevention and risk limits on escrow volume
  (legitimate interest / pre-contractual steps, Art. 6(1)(b)/(f) GDPR). Once real
  funds are involved, AML obligations may become the legal basis (Art. 6(1)(c)).
- **Access:** service role only; operators see documents through short-lived
  signed URLs, and each view is logged.
- **Retention:** the document can and should be deleted by the operator right
  after review (`DELETE /v1/admin/kyc/:orgId/document`); the decision, reviewer and
  audit trail remain. Profiles are removed with the organization (FK cascade).
- **Data subject rights:** access/rectification/erasure requests are handled by
  the operator (export the `kyc_profiles` row and audit entries; delete the document
  and profile). Note that AML rules may require keeping some records once real
  money flows; legal review must set the final retention period.
- **Processors:** Supabase (EU region, eu-west-1) for storage and database.
- **To do before real funds:** DPIA, privacy notice text on `/console/kyc`, final
  retention schedule, and whether Tier 1 must move to a licensed KYC provider.
