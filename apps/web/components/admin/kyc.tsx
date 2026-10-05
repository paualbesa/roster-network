"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusLine, buttonClass, fieldClass, ghostClass } from "@/components/console/ui";
import {
  AdminClientError,
  adminRequest,
  kycAuditLabel,
  kycDocumentHref,
  type AdminKycEntry,
  type AdminKycQueue,
} from "@/lib/admin-client";
import { formatOperatorTime, formatUsdcDisplay } from "@/lib/admin-metrics";
import { DataTable, EmptyState, Pill, type PillTone } from "./ui";

type KycFilter = "pending" | "approved" | "rejected" | "all";

const FILTERS: { id: KycFilter; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

const REVIEWER_KEY = "roster.admin.reviewer";

function statusTone(status: AdminKycEntry["status"]): PillTone {
  if (status === "approved") return "sage";
  if (status === "pending") return "brass";
  return "alert";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`;
}

export function KycSection({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [queue, setQueue] = useState<AdminKycQueue | null>(null);
  const [filter, setFilter] = useState<KycFilter>("pending");
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ orgId: string; url: string; mimeType: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setReviewer(window.localStorage.getItem(REVIEWER_KEY) ?? "");
  }, []);

  const handle = useCallback(
    (caught: unknown, fallback: string) => {
      if (caught instanceof AdminClientError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : fallback);
    },
    [onUnauthorized],
  );

  const load = useCallback(async () => {
    const next = await adminRequest<AdminKycQueue>("/v1/admin/kyc?status=all");
    setQueue(next);
  }, []);

  useEffect(() => {
    void load().catch((caught: unknown) => handle(caught, "Could not load the KYC queue."));
  }, [load, handle]);

  const entries = (queue?.entries ?? []).filter((entry) => filter === "all" || entry.status === filter);
  const current = queue?.entries.find((entry) => entry.organizationId === selected) ?? null;

  function rememberReviewer(value: string) {
    setReviewer(value);
    window.localStorage.setItem(REVIEWER_KEY, value);
  }

  async function act(label: string, path: string, method: "POST" | "DELETE", body: Record<string, unknown>, done: string) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await adminRequest(path, { method, body: JSON.stringify(body) });
      setNotice(done);
      if (label !== "preview") setPreview(null);
      setReason("");
      await load();
    } catch (caught) {
      handle(caught, "The KYC action failed.");
    } finally {
      setBusy("");
    }
  }

  async function openPreview(orgId: string) {
    setBusy("preview");
    setError("");
    try {
      const signed = await adminRequest<{ url: string; mimeType: string; expiresAt: string }>(
        `/v1/admin/kyc/${encodeURIComponent(orgId)}/document-url`,
        { method: "POST", body: JSON.stringify({ reviewer: reviewer.trim() || "operator" }) },
      );
      setPreview({ orgId, url: kycDocumentHref(signed.url), mimeType: signed.mimeType, expiresAt: signed.expiresAt });
      await load();
    } catch (caught) {
      handle(caught, "Could not open the document.");
    } finally {
      setBusy("");
    }
  }

  const who = reviewer.trim() || "operator";

  return (
    <section aria-labelledby="kyc-title">
      <div>
        <p className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">Compliance</p>
        <h1 id="kyc-title" className="mt-2 font-serif text-4xl tracking-[-0.03em] text-paper md:text-5xl">
          KYC review
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          Tier 1 submissions waiting for manual review. Documents sit in a private bucket and open through signed links that expire in 60
          seconds. Every view and decision is logged. Delete the document once you have decided.
        </p>
      </div>

      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        <Stat label="Pending" value={(queue?.pending ?? 0).toString()} hint="Waiting for a decision" />
        <Stat
          label="Tier 0 cap"
          value={queue ? `${formatUsdcDisplay(queue.limits.tier0Usdc)}` : "—"}
          hint="USDC per org, rolling 30 days"
        />
        <Stat
          label="Tier 1 cap"
          value={queue ? `${formatUsdcDisplay(queue.limits.tier1Usdc)}` : "—"}
          hint={`After approval · storage: ${queue?.storage ?? "—"}`}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="kyc-reviewer" className="text-sm text-paper">
            Reviewer name (audit log)
          </label>
          <input
            id="kyc-reviewer"
            value={reviewer}
            onChange={(event) => rememberReviewer(event.target.value)}
            placeholder="e.g. Pau"
            maxLength={80}
            className={`${fieldClass} w-64`}
          />
        </div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="KYC status">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={`inline-flex min-h-11 items-center px-3 text-sm ${filter === item.id ? "bg-brass text-ink" : "border border-line/15 text-paper hover:border-brass/60"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="mt-4">
          <StatusLine tone="error">{error}</StatusLine>
        </div>
      ) : null}
      {notice ? (
        <div className="mt-4">
          <StatusLine tone="ok">{notice}</StatusLine>
        </div>
      ) : null}

      <div className="mt-6">
        <DataTable
          caption="KYC submissions"
          columns={["Organization", "Applicant", "Status", "Usage", "Submitted", ""]}
          rows={entries.map((entry) => ({
            key: entry.organizationId,
            cells: [
              <div key="org">
                <p className="text-paper">{entry.organizationName}</p>
                <p className="font-mono text-[11px] text-muted">{entry.organizationId}</p>
              </div>,
              <div key="applicant">
                <p>{entry.submission?.legalName ?? "—"}</p>
                <p className="text-xs text-muted">
                  {entry.submission ? `${entry.submission.entityType} · ${entry.submission.country}` : ""}
                </p>
              </div>,
              <Pill key="status" tone={statusTone(entry.status)}>
                {entry.status} · T{entry.tier.toString()}
              </Pill>,
              <span key="usage" className="font-mono text-xs text-muted">
                {formatUsdcDisplay(entry.usedUsdc)} / {formatUsdcDisplay(entry.limitUsdc)}
              </span>,
              <span key="submitted" className="text-muted">
                {formatOperatorTime(entry.submission?.submittedAt ?? entry.updatedAt)}
              </span>,
              <button
                key="open"
                type="button"
                className="min-h-11 px-2 text-sm text-brass hover:text-brass-bright"
                onClick={() => {
                  setSelected(entry.organizationId);
                  setPreview(null);
                  setReason("");
                }}
              >
                Review
              </button>,
            ],
          }))}
          empty={{
            title: filter === "pending" ? "Nothing to review" : "No submissions",
            body: "Tier 1 submissions from /console/kyc show up here.",
          }}
        />
      </div>

      {current ? (
        <article className="mt-6 border border-line/10 bg-panel p-6" aria-labelledby="kyc-review-title">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] tracking-[0.16em] text-brass uppercase">{current.organizationId}</p>
              <h2 id="kyc-review-title" className="mt-2 font-serif text-3xl tracking-[-0.03em] text-paper">
                {current.submission?.legalName ?? current.organizationName}
              </h2>
              <div className="mt-3">
                <Pill tone={statusTone(current.status)}>{current.status}</Pill>
              </div>
            </div>
            <button type="button" className="min-h-11 px-2 text-sm text-muted hover:text-paper" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <dl className="mt-6 grid gap-4 sm:grid-cols-3">
            <Field label="Entity" value={current.submission?.entityType ?? "—"} />
            <Field label="Country" value={current.submission?.country ?? "—"} />
            <Field
              label={current.submission?.entityType === "company" ? "Company reg. no." : "Date of birth"}
              value={current.submission?.companyRegNo ?? current.submission?.dateOfBirth ?? "—"}
            />
            <Field
              label="Document"
              value={
                current.document
                  ? current.document.deleted
                    ? "Deleted after review"
                    : `${current.document.mimeType} · ${formatBytes(current.document.sizeBytes)}`
                  : "—"
              }
            />
            <Field label="Reviewed" value={current.reviewedAt ? `${formatOperatorTime(current.reviewedAt)} · ${current.reviewedBy ?? ""}` : "—"} />
            <Field label="Reason" value={current.rejectionReason ?? "—"} />
          </dl>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              className={ghostClass}
              disabled={busy !== "" || !current.hasDocument}
              onClick={() => void openPreview(current.organizationId)}
            >
              {busy === "preview" ? "Signing link" : "Preview document"}
            </button>
            {current.status !== "pending" && current.hasDocument ? (
              <button
                type="button"
                className={ghostClass}
                disabled={busy !== ""}
                onClick={() => {
                  if (!window.confirm("Delete this ID document permanently? The decision and audit log stay.")) return;
                  void act(
                    "delete",
                    `/v1/admin/kyc/${encodeURIComponent(current.organizationId)}/document`,
                    "DELETE",
                    { reviewer: who },
                    "Document deleted. The decision and audit trail remain.",
                  );
                }}
              >
                {busy === "delete" ? "Deleting" : "Delete document"}
              </button>
            ) : null}
          </div>

          {preview && preview.orgId === current.organizationId ? (
            <div className="mt-6">
              <p className="text-xs text-muted">
                Signed link expires {formatOperatorTime(preview.expiresAt)}.{" "}
                <a href={preview.url} target="_blank" rel="noreferrer noopener" className="text-brass underline underline-offset-4">
                  Open in a new tab
                </a>
              </p>
              {preview.mimeType.startsWith("image/") ? (
                <img
                  src={preview.url}
                  alt={`ID document for ${current.organizationName}`}
                  referrerPolicy="no-referrer"
                  className="mt-3 max-h-[32rem] w-auto border border-line/10 bg-panel-2 object-contain"
                />
              ) : (
                <iframe
                  title={`ID document for ${current.organizationName}`}
                  src={preview.url}
                  referrerPolicy="no-referrer"
                  className="mt-3 h-[32rem] w-full border border-line/10 bg-panel-2"
                />
              )}
            </div>
          ) : null}

          {current.status === "pending" ? (
            <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div className="flex flex-col gap-2">
                <label htmlFor="kyc-reason" className="text-sm text-paper">
                  Rejection reason (shown to the applicant)
                </label>
                <textarea
                  id="kyc-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="e.g. The document is blurry. Upload a sharper photo of the full page."
                  className={`${fieldClass} min-h-24 py-3 text-sm`}
                />
              </div>
              <div className="flex flex-col justify-end gap-3">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy !== ""}
                  onClick={() =>
                    void act(
                      "approve",
                      `/v1/admin/kyc/${encodeURIComponent(current.organizationId)}/approve`,
                      "POST",
                      { reviewer: who },
                      `Approved. ${current.organizationName} is now Tier 1.`,
                    )
                  }
                >
                  {busy === "approve" ? "Approving" : "Approve · Tier 1"}
                </button>
                <button
                  type="button"
                  className={ghostClass}
                  disabled={busy !== "" || reason.trim().length < 3}
                  onClick={() =>
                    void act(
                      "reject",
                      `/v1/admin/kyc/${encodeURIComponent(current.organizationId)}/reject`,
                      "POST",
                      { reviewer: who, reason: reason.trim() },
                      "Rejected with reason. The applicant can resubmit.",
                    )
                  }
                >
                  {busy === "reject" ? "Rejecting" : "Reject with reason"}
                </button>
              </div>
            </div>
          ) : null}
        </article>
      ) : null}

      <div className="mt-10">
        <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">Audit log</p>
        <div className="mt-3">
          {queue && queue.audit.length > 0 ? (
            <DataTable
              caption="KYC audit log"
              columns={["When", "Action", "Who", "Organization", "Reason"]}
              rows={queue.audit.slice(0, 100).map((entry) => ({
                key: entry.id,
                cells: [
                  <span key="at" className="text-muted">{formatOperatorTime(entry.at)}</span>,
                  kycAuditLabel(entry.action),
                  <span key="actor" className="font-mono text-xs">{entry.actor}</span>,
                  <span key="org" className="font-mono text-xs text-muted">{entry.organizationId}</span>,
                  <span key="reason" className="text-muted">{entry.reason ?? "—"}</span>,
                ],
              }))}
              empty={{ title: "No activity", body: "" }}
            />
          ) : (
            <EmptyState title="No KYC activity yet" body="Submissions, document views, decisions and deletions are recorded here." />
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="border border-line/10 bg-panel px-4 py-4">
      <p className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</p>
      <p className="mt-2 font-serif text-2xl tracking-[-0.03em] text-paper">{value}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">{label}</dt>
      <dd className="mt-1 text-sm break-words text-paper">{value}</dd>
    </div>
  );
}
