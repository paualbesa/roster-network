import Link from "next/link";

export default function NotFound() {
  return (
    <main id="content" className="mx-auto flex min-h-[60vh] max-w-3xl flex-col justify-center px-6 py-24">
      <p className="font-mono text-[11px] tracking-[0.22em] text-brass uppercase">404</p>
      <h1 className="mt-4 font-serif text-5xl tracking-[-0.035em]">This page is not on the roster.</h1>
      <p className="mt-4 text-muted">That path is not on the marketing site or the sandbox console.</p>
      <Link
        href="/"
        className="mt-8 inline-flex min-h-12 w-fit items-center bg-brass px-5 text-sm font-medium text-ink hover:bg-brass-bright"
      >
        Back to Roster
      </Link>
    </main>
  );
}
