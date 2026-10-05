"use client";

import { useId, useState, type FormEvent } from "react";

type Status = "idle" | "submitting" | "accepted" | "error";

export function WaitlistForm() {
  const emailId = useId();
  const roleId = useId();
  const statusId = useId();
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setStatus("submitting");
    setMessage("");
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: String(data.get("email") ?? ""),
          role: String(data.get("role") ?? ""),
        }),
      });
      if (response.status === 429) {
        setStatus("error");
        setMessage("Too many sign-ups from this network. Try again in a minute.");
        return;
      }
      if (response.status >= 500) {
        setStatus("error");
        setMessage("The waitlist is unavailable right now. Try again in a moment.");
        return;
      }
      if (!response.ok) {
        setStatus("error");
        setMessage("Enter a valid email and choose developer or operator.");
        return;
      }
      form.reset();
      setStatus("accepted");
      setMessage("You're on the list. We'll write when the public sandbox opens.");
    } catch {
      setStatus("error");
      setMessage("The waitlist could not be reached. Try again in a moment.");
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <label htmlFor={emailId} className="text-sm text-paper">
          Email
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          placeholder="you@studio.dev"
          className="min-h-12 border border-line/15 bg-panel-2 px-3 text-paper placeholder:text-muted"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={roleId} className="text-sm text-paper">
          Role
        </label>
        <select
          id={roleId}
          name="role"
          required
          defaultValue="developer"
          className="min-h-12 border border-line/15 bg-panel-2 px-3 text-paper"
        >
          <option value="developer">Developer</option>
          <option value="operator">Operator</option>
        </select>
      </div>
      <button
        type="submit"
        disabled={status === "submitting"}
        className="inline-flex min-h-12 items-center justify-center bg-brass px-5 text-sm font-medium text-ink transition-colors hover:bg-brass-bright disabled:cursor-wait disabled:opacity-70"
      >
        {status === "submitting" ? "Sending…" : "Request sandbox access"}
      </button>
      <p className="text-xs leading-5 text-muted">
        We store your email only to tell you when the public sandbox opens. No payment, no account, no secret.
      </p>
      <p
        id={statusId}
        role={status === "error" ? "alert" : "status"}
        aria-live={status === "error" ? "assertive" : "polite"}
        className={status === "error" ? "text-sm text-brass-bright" : "text-sm text-sage"}
      >
        {message}
      </p>
    </form>
  );
}
