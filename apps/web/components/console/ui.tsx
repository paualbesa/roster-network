import type { ReactNode } from "react";

export const fieldClass =
  "min-h-12 w-full border border-line/15 bg-panel-2 px-3 text-base text-paper placeholder:text-muted";

export const buttonClass =
  "inline-flex min-h-12 items-center justify-center bg-brass px-5 text-sm font-medium text-ink transition-colors hover:bg-brass-bright disabled:cursor-wait disabled:opacity-70";

export const ghostClass =
  "inline-flex min-h-12 items-center justify-center border border-line/20 px-5 text-sm text-paper transition-colors hover:border-brass/70 hover:text-brass disabled:cursor-wait disabled:opacity-70";

export function ConsolePage({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-12 lg:py-16">
      <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">{eyebrow}</p>
      <h1 className="mt-4 max-w-3xl font-serif text-4xl leading-[1.05] tracking-[-0.03em] text-balance md:text-5xl">
        {title}
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-7 text-muted text-pretty">{lede}</p>
      <div className="mt-10">{children}</div>
    </div>
  );
}

export function StatusLine({ tone, children }: { tone: "error" | "ok" | "muted"; children: ReactNode }) {
  const className =
    tone === "error" ? "text-sm text-brass-bright" : tone === "ok" ? "text-sm text-sage" : "text-sm text-muted";
  return (
    <p role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} className={className}>
      {children}
    </p>
  );
}
