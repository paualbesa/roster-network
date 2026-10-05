"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createRosterClient,
  describeEscrowMode,
  kycUsagePercent,
  rosterErrorMessage,
  type KycSnapshot,
  type RosterHealth,
} from "@/lib/roster-client";
import { RequireSession } from "./require-session";
import { useSandboxSession } from "./session";
import { ConsolePage, StatusLine, buttonClass, fieldClass } from "./ui";

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";

export function Kyc() {
  return (
    <ConsolePage
      eyebrow="Verification"
      title="Free KYC, reviewed by a person."
      lede="Every organization starts at Tier 0 with a rolling 30-day escrow cap. Submit basic details and one ID document to reach Tier 1. A Roster operator reviews it by hand."
    >
      <RequireSession>
        <KycBody />
      </RequireSession>
    </ConsolePage>
  );
}

function formatUsdc(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusCopy(snapshot: KycSnapshot): { label: string; tone: "ok" | "muted" | "error" } {
  if (snapshot.status === "approved") return { label: "Approved · Tier 1", tone: "ok" };
  if (snapshot.status === "pending") return { label: "Pending manual review", tone: "muted" };
  if (snapshot.status === "rejected") return { label: "Rejected · you can resubmit", tone: "error" };
  return { label: "Not submitted · Tier 0", tone: "muted" };
}

function KycBody() {
  const { session } = useSandboxSession();
  const [kyc, setKyc] = useState<KycSnapshot | null>(null);
  const [health, setHealth] = useState<RosterHealth | null>(null);
  const [entityType, setEntityType] = useState<"individual" | "company">("individual");
  const [legalName, setLegalName] = useState("");
  const [country, setCountry] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [companyRegNo, setCompanyRegNo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!session) return;
    const client = createRosterClient({ apiKey: session.apiKey });
    const [nextKyc, nextHealth] = await Promise.all([client.kyc(), client.health().catch(() => null)]);
    setKyc(nextKyc);
    setHealth(nextHealth);
  }, [session]);

  useEffect(() => {
    void load().catch((cause: unknown) => setError(rosterErrorMessage(cause)));
  }, [load]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setError("");
    setNotice("");
    if (!file) {
      setError("Attach one ID document (JPEG, PNG, WebP or PDF).");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("The document must be at most 5 MB.");
      return;
    }
    if (!consent) {
      setError("Confirm the data notice before submitting.");
      return;
    }
    const form = new FormData();
    form.set("entityType", entityType);
    form.set("legalName", legalName.trim());
    form.set("country", country.trim().toUpperCase());
    if (entityType === "individual") form.set("dateOfBirth", dateOfBirth);
    else form.set("companyRegNo", companyRegNo.trim());
    form.set("document", file, file.name);
    setPending(true);
    try {
      const next = await createRosterClient({ apiKey: session.apiKey }).submitKyc(form);
      setKyc(next);
      setFile(null);
      setNotice("Submitted. An operator will review it; the Tier 1 cap applies once approved.");
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  if (!kyc) {
    return error ? <StatusLine tone="error">{error}</StatusLine> : <p className="text-sm text-muted">Loading verification…</p>;
  }

  const percent = kycUsagePercent(kyc);
  const status = statusCopy(kyc);
  const canSubmit = kyc.status === "none" || kyc.status === "rejected";

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section aria-labelledby="kyc-tier" className="flex flex-col gap-6">
        <div className="border border-line/10 bg-panel p-6">
          <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Current tier</p>
          <h2 id="kyc-tier" className="mt-2 font-serif text-5xl tracking-[-0.03em] text-paper">
            Tier {kyc.tier.toString()}
          </h2>
          <div className="mt-3">
            <StatusLine tone={status.tone}>{status.label}</StatusLine>
          </div>
          <div className="mt-6">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-paper">Escrow volume, last {kyc.windowDays.toString()} days</span>
              <span className="font-mono text-xs text-muted">
                {formatUsdc(kyc.usedUsdc)} / {formatUsdc(kyc.limitUsdc)} USDC
              </span>
            </div>
            <div
              className="mt-2 h-2.5 w-full bg-panel-2"
              role="progressbar"
              aria-label="Escrow volume used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div
                className={`h-full ${percent >= 90 ? "bg-brass-bright" : "bg-brass"}`}
                style={{ width: `${percent.toString()}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              {formatUsdc(kyc.remainingUsdc)} USDC left. Held and released escrows count; refunds do not. Locks over the cap return{" "}
              <code className="font-mono text-paper">kyc_limit_exceeded</code>.
            </p>
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-line/10 pt-4 text-sm">
            <div>
              <dt className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">Tier 0 cap</dt>
              <dd className="mt-1 text-paper">{formatUsdc(kyc.limits.tier0Usdc)} USDC / 30 d</dd>
            </div>
            <div>
              <dt className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">Tier 1 cap</dt>
              <dd className="mt-1 text-paper">{formatUsdc(kyc.limits.tier1Usdc)} USDC / 30 d</dd>
            </div>
          </dl>
        </div>

        {kyc.status === "rejected" && kyc.rejectionReason ? (
          <div className="border border-brass-bright/30 bg-panel p-5">
            <p className="font-mono text-[11px] tracking-[0.16em] text-brass-bright uppercase">Reviewer note</p>
            <p className="mt-2 text-sm leading-6 text-paper">{kyc.rejectionReason}</p>
          </div>
        ) : null}

        {kyc.submission ? (
          <div className="border border-line/10 bg-panel p-5 text-sm">
            <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Last submission</p>
            <p className="mt-2 text-paper">
              {kyc.submission.legalName} · {kyc.submission.country} · {kyc.submission.entityType}
            </p>
            <p className="mt-1 text-xs text-muted">
              {new Date(kyc.submission.submittedAt).toLocaleString()} ·{" "}
              {kyc.document ? (kyc.document.deleted ? "document deleted after review" : kyc.document.mimeType) : "no document"}
            </p>
          </div>
        ) : null}

        {health ? (
          <div className="border border-line/10 bg-panel p-5 text-sm">
            <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Escrow mode · {health.escrowMode}</p>
            <p className="mt-2 leading-6 text-muted">{describeEscrowMode(health.escrowMode)}</p>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="kyc-form-title" className="border border-line/10 bg-panel p-6">
        <h2 id="kyc-form-title" className="font-serif text-3xl tracking-[-0.03em] text-paper">
          Tier 1 verification
        </h2>
        {canSubmit ? (
          <form className="mt-6 flex flex-col gap-5" onSubmit={(event) => void onSubmit(event)}>
            <fieldset className="flex gap-4">
              <legend className="mb-2 text-sm text-paper">Applicant</legend>
              {(["individual", "company"] as const).map((value) => (
                <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-paper">
                  <input
                    type="radio"
                    name="entityType"
                    value={value}
                    checked={entityType === value}
                    onChange={() => setEntityType(value)}
                    className="accent-[#c4a36a]"
                  />
                  {value === "individual" ? "Individual" : "Company"}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-col gap-2">
              <label htmlFor="kyc-name" className="text-sm text-paper">
                {entityType === "company" ? "Registered company name" : "Full legal name"}
              </label>
              <input id="kyc-name" required minLength={2} maxLength={160} value={legalName} onChange={(e) => setLegalName(e.target.value)} className={fieldClass} autoComplete="name" />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="kyc-country" className="text-sm text-paper">
                Country (ISO code, e.g. ES)
              </label>
              <input
                id="kyc-country"
                required
                pattern="[A-Za-z]{2}"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                className={`${fieldClass} w-28 uppercase`}
                autoComplete="country"
              />
            </div>
            {entityType === "individual" ? (
              <div className="flex flex-col gap-2">
                <label htmlFor="kyc-dob" className="text-sm text-paper">
                  Date of birth
                </label>
                <input id="kyc-dob" type="date" required value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} className={`${fieldClass} w-56`} />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <label htmlFor="kyc-reg" className="text-sm text-paper">
                  Company registration number
                </label>
                <input id="kyc-reg" required maxLength={40} value={companyRegNo} onChange={(e) => setCompanyRegNo(e.target.value)} className={fieldClass} />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <label htmlFor="kyc-doc" className="text-sm text-paper">
                ID document ({entityType === "company" ? "registry extract or director ID" : "passport, ID card or driving licence"})
              </label>
              <input
                id="kyc-doc"
                type="file"
                required
                accept={ACCEPT}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm text-muted file:mr-4 file:min-h-11 file:border-0 file:bg-panel-2 file:px-4 file:text-paper"
              />
              <p className="text-xs text-muted">JPEG, PNG, WebP or PDF, up to 5 MB. Stored in a private bucket; never public.</p>
            </div>
            <label className="flex cursor-pointer items-start gap-3 text-xs leading-5 text-muted">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 size-4 accent-[#c4a36a]" />
              <span>
                I understand Roster stores only these fields and the document to set escrow limits and prevent fraud. Operators view the
                document through short-lived links, every view is logged, and the document is deleted after review. I can ask for access or
                erasure at any time (GDPR).
              </span>
            </label>
            <button type="submit" className={buttonClass} disabled={pending}>
              {pending ? "Uploading…" : "Submit for review"}
            </button>
          </form>
        ) : (
          <p className="mt-4 text-sm leading-6 text-muted">
            {kyc.status === "pending"
              ? "Your submission is waiting for manual review. You will see the result here."
              : "Your organization is verified at Tier 1. Nothing else to do."}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-2">
          {error ? <StatusLine tone="error">{error}</StatusLine> : null}
          {notice ? <StatusLine tone="ok">{notice}</StatusLine> : null}
        </div>
      </section>
    </div>
  );
}
